/**
 * Worktree lifecycle — creation, disposal, salvage, and eviction.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec, gitExecVerbose, findGitRoot, deleteLocalBranch } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import {
    GIT_USER_NAME, GIT_USER_EMAIL,
    WORKTREE_SALVAGE_MAX, PR_SALVAGE_PATCHES,
} from '../../config';

const log = getLogger('[PR-Workflow]', 135);

// ─── Worktree creation ──────────────────────────────────────────────────────

export interface WorktreeResult {
    worktreeDir: string;
    worktreeWorkspace: string;
    gitRoot: string;
    /** `origin/<branch>` when the branch resumed from its remote head (Plan 30-02); null for a new branch. */
    resumedFrom: string | null;
}

/** Salvaged worktrees: inside `.worktrees/`, so already gitignored, pruned by the walkers and never staged (Plan 30-04). */
const SALVAGE_DIR = path.join('.worktrees', '_failed');

/**
 * Head of `origin/<branch>` after refreshing it, or null when the remote has no
 * such branch. The explicit refspec updates the remote-tracking ref even when
 * the clone's fetch refspec is narrower. Plan 30-04: `ls-remote --quiet` asks
 * first — a probe — so a branch that was never pushed is not a failed fetch in
 * `errors.jsonl`.
 */
function remoteBranchHead(gitRoot: string, branchName: string): string | null {
    // Exit 2: the remote has no such branch. Any other failure falls through to the fetch.
    if (gitExecVerbose(gitRoot, `ls-remote --quiet --exit-code origin refs/heads/${branchName}`).code === 2) return null;
    const fetch = gitExecVerbose(gitRoot, `fetch origin +refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
    if (!fetch.ok) return null;
    const sha = gitExec(gitRoot, `rev-parse --verify refs/remotes/origin/${branchName}`);
    return sha.startsWith('Error:') ? null : sha.trim();
}

/** `git worktree remove --force`, deleting the directory when git refuses (the registration is pruned later). */
function removeWorktree(gitRoot: string, dir: string): void {
    gitExec(gitRoot, `worktree remove "${dir}" --force`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Delete the local branch (probed first — a missing branch is not an error), warning when git refuses. */
function dropLocalBranch(gitRoot: string, branchName: string): void {
    const del = deleteLocalBranch(gitRoot, branchName);
    if (del.error) log.warn(`Could not delete local branch ${branchName}: ${del.error}`);
}

/**
 * True when the remote holds everything the worktree has: no uncommitted
 * change, and `origin/<branch>` (asked with `ls-remote`, since live pushes go to
 * a URL and leave the remote-tracking ref stale) is the worktree's HEAD.
 */
function worktreeIsOnRemote(worktreeDir: string, branchName: string): boolean {
    const head = gitExec(worktreeDir, 'rev-parse HEAD');
    const status = gitExec(worktreeDir, 'status --porcelain');
    const remote = gitExec(worktreeDir, `ls-remote origin refs/heads/${branchName}`);
    if ([head, status, remote].some(out => out.startsWith('Error:'))) return false;
    return status === '' && remote.split(/\s+/)[0] === head;
}

/**
 * Create an isolated worktree for a branch.
 *
 * Each branch gets its own working directory so parallel agents
 * never interfere with each other via git checkout races.
 *
 * Plan 30-02: a branch that is already on the remote (blocked, open or
 * deferred in an earlier round) resumes from `origin/<branch>` — its executed
 * work is kept, and the caller merges the latest base in before any dev work.
 * Only a branch the remote does not have is cut from the base.
 */
export function createBranchWorktree(
    workspacePath: string,
    branchName: string,
    baseBranch: string,
): WorktreeResult {
    const gitRoot = findGitRoot(workspacePath);
    const relativeWorkspace = path.relative(gitRoot, workspacePath);
    const worktreeSlug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');
    const worktreeDir = path.join(gitRoot, '.worktrees', worktreeSlug);
    const worktreeWorkspace = relativeWorkspace
        ? path.join(worktreeDir, relativeWorkspace)
        : worktreeDir;

    log.info(`Creating worktree for branch: ${branchName} (from ${baseBranch})`);

    // Plan 24, A2: remove ANY existing worktree whose branch is this branchName (a
    // leftover of a crashed run, or a salvage from before Plan 30-04 — salvage is now
    // detached). Without this, `git branch -D` fails because that worktree still has the
    // branch checked out, then `git worktree add` fails with "A branch named '...' already exists".
    const porcelainOutput = gitExec(gitRoot, 'worktree list --porcelain');
    const worktreeEntries = porcelainOutput.split('\n\n').filter(Boolean);
    for (const entry of worktreeEntries) {
        const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m);
        const pathMatch = entry.match(/^worktree (.+)$/m);
        if (branchMatch && pathMatch && branchMatch[1] === branchName) {
            const existingWtPath = pathMatch[1];
            // Skip if it's the main worktree
            if (existingWtPath === gitRoot) continue;
            log.info(`Removing existing worktree for branch ${branchName}: ${existingWtPath}`);
            gitExec(gitRoot, `worktree remove "${existingWtPath}" --force`);
        }
    }
    // Prune stale worktree tracking entries (e.g. directories deleted but
    // git's internal worktree list not updated — prevents "already checked out" errors)
    gitExec(gitRoot, 'worktree prune');

    // Clean up stale worktree from a previous failed run
    if (fs.existsSync(worktreeDir)) {
        gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
    }
    // Delete the stale local branch if it exists — it is recreated below, at the remote
    // head or at the base. Plan 24, A2: this now succeeds because we removed the worktree above.
    dropLocalBranch(gitRoot, branchName);
    // Fetch latest base branch from remote (may fail if not pushed yet)
    gitExec(gitRoot, `fetch origin ${baseBranch}`);
    // Plan 30-02: resume from the remote head instead of rebuilding from the base.
    // The old path reset the branch to the base, so every round redid the same
    // assignments and its pushes were rejected as non-fast-forward.
    const remoteHead = remoteBranchHead(gitRoot, branchName);
    const resumedFrom = remoteHead ? `origin/${branchName}` : null;

    // `-B` (re)creates the local branch at the start point. Wrapped in try/catch so a
    // failed creation cleans up the partial directory before re-throwing (fixes A11 worktree leak).
    try {
        let wtResult: string;
        if (resumedFrom) {
            log.info(`Resuming branch ${branchName} from ${resumedFrom} @ ${remoteHead!.slice(0, 8)}`);
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -B ${branchName} ${resumedFrom}`);
            if (wtResult.startsWith('Error:')) {
                throw new Error(`Failed to resume worktree for ${branchName} from ${resumedFrom}: ${wtResult}`);
            }
        } else {
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -B ${branchName} origin/${baseBranch}`);
            if (wtResult.startsWith('Error:')) {
                log.warn(`Remote ref origin/${baseBranch} not found, falling back to local branch`);
                wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -B ${branchName} ${baseBranch}`);
            }
            if (wtResult.startsWith('Error:')) {
                throw new Error(`Failed to create worktree for ${branchName}: ${wtResult}`);
            }
        }
        log.info(`Worktree created: ${wtResult}`);
        // Set git identity in the worktree so agent shell commands have valid author
        gitExec(worktreeDir, `config user.name "${GIT_USER_NAME}"`);
        gitExec(worktreeDir, `config user.email "${GIT_USER_EMAIL}"`);
        // Ensure the workspace sub-directory exists in the worktree
        fs.mkdirSync(worktreeWorkspace, { recursive: true });
    } catch (wtCreateErr) {
        // Clean up any partial worktree directory so it does not leak (fixes A11)
        if (fs.existsSync(worktreeDir)) {
            gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
        }
        gitExec(gitRoot, 'worktree prune');
        throw wtCreateErr;
    }

    return { worktreeDir, worktreeWorkspace, gitRoot, resumedFrom };
}

// ─── Worktree disposal ──────────────────────────────────────────────────────

/**
 * Dispose of a worktree after the PR workflow.
 *
 * Merged, or not merged but the remote holds all of its work → remove it.
 * Otherwise (unpushed commits or uncommitted changes) → keep it, detached, at
 * `.worktrees/_failed/<slug>`; the newest `WORKTREE_SALVAGE_MAX` are kept.
 * The local branch is then deleted in every case: a later round resumes from
 * `origin/<branch>` (Plan 30-02).
 *
 * Plan 30-04: salvage used to move to `<gitRoot>/.worktrees-failed/`. One
 * `.gitignore` block without that entry was enough for the pre-sync auto-commit
 * to push the salvaged worktree as a gitlink, and QA scanned it as a product
 * root. The branch was also deleted *before* the worktree that had it checked
 * out, which always failed.
 */
export function disposeWorktree(
    gitRoot: string,
    worktreeDir: string,
    branchName: string,
    wasMerged: boolean,
): void {
    const worktreeSlug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');

    if (fs.existsSync(worktreeDir)) {
        if (wasMerged || worktreeIsOnRemote(worktreeDir, branchName)) {
            removeWorktree(gitRoot, worktreeDir);
            log.info(`Cleaned up worktree: ${worktreeSlug}${wasMerged ? '' : ` (not merged; origin/${branchName} holds its work)`}`);
        } else {
            preserveForSalvage(gitRoot, worktreeDir, worktreeSlug);
        }
    }
    dropLocalBranch(gitRoot, branchName);
    // Prune any dangling worktree tracking entries (fixes A11 leak-proofing)
    gitExec(gitRoot, 'worktree prune');
}

/**
 * Keep an unmerged worktree whose work is not all on the remote, detached so its
 * branch can be deleted; its commits stay reachable from the salvage worktree.
 */
function preserveForSalvage(gitRoot: string, worktreeDir: string, worktreeSlug: string): void {
    const target = path.join(gitRoot, SALVAGE_DIR, worktreeSlug);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // An older salvage of the same branch; git worktree move requires the destination to NOT exist
        if (fs.existsSync(target)) removeWorktree(gitRoot, target);
        const detach = gitExec(worktreeDir, 'checkout --detach');
        if (detach.startsWith('Error:')) log.warn(`Could not detach the salvaged worktree ${worktreeSlug}: ${detach}`);
        if (gitExecVerbose(gitRoot, `worktree move "${worktreeDir}" "${target}"`).ok) {
            log.info(`Preserved unpushed work of ${worktreeSlug} → ${SALVAGE_DIR}/${worktreeSlug}`);
        } else {
            // Fallback: just rename the directory
            fs.renameSync(worktreeDir, target);
            log.info(`Moved failed worktree directory: ${worktreeSlug} → ${SALVAGE_DIR}/${worktreeSlug}`);
        }
        evictStaleSalvageWorktrees(gitRoot);
    } catch (moveErr: any) {
        log.warn(`Failed to preserve worktree (removing): ${moveErr.message}`);
        removeWorktree(gitRoot, worktreeDir);
    }
}

// ─── Worktree salvage (Sub-Plan 06 §3) ──────────────────────────────────────

/**
 * Export a `git format-patch` bundle and a diagnostic README for a branch
 * that failed to merge. The patches are written to `<outputPath>/salvage/<slug>/`.
 */
export function salvageWorktree(
    worktreeWorkspace: string,
    _gitRoot: string,
    baseRef: string,
    branchName: string,
    failureReason: string,
    outputPath: string,
): void {
    if (!PR_SALVAGE_PATCHES) return;
    const slug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');
    const salvageDir = path.join(outputPath, 'salvage', slug);
    try {
        fs.mkdirSync(salvageDir, { recursive: true });
        // Export patches
        gitExec(worktreeWorkspace, `format-patch ${baseRef}..HEAD -o "${salvageDir}"`);
        // Write diagnostic README
        const gitLog = gitExec(worktreeWorkspace, 'log --oneline');
        const diffStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}..HEAD`);
        const readme = [
            `# Salvaged branch: ${branchName}`,
            ``,
            `**Base ref:** ${baseRef}`,
            `**Failure reason:** ${failureReason}`,
            `**Salvage date:** ${new Date().toISOString()}`,
            ``,
            `## Commits`,
            '```',
            gitLog,
            '```',
            ``,
            `## Diff stat`,
            '```',
            diffStat,
            '```',
        ].join('\n');
        fs.writeFileSync(path.join(salvageDir, 'README.md'), readme, 'utf-8');
        log.info(`Salvage patches written to ${salvageDir}`);
        emitRunEvent('pr:salvage', { branch: branchName, salvageDir, reason: failureReason });
    } catch (err: any) {
        log.warn(`Salvage export failed (non-fatal): ${err.message}`);
    }
}

/**
 * Evict the oldest salvaged worktrees under `.worktrees/_failed/` beyond `WORKTREE_SALVAGE_MAX`.
 */
export function evictStaleSalvageWorktrees(gitRoot: string): void {
    const salvageRoot = path.join(gitRoot, SALVAGE_DIR);
    if (!fs.existsSync(salvageRoot)) return;
    try {
        const entries = fs.readdirSync(salvageRoot)
            .map(name => ({ name, mtime: fs.statSync(path.join(salvageRoot, name)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime); // oldest first
        while (entries.length > WORKTREE_SALVAGE_MAX) {
            const oldest = entries.shift()!;
            removeWorktree(gitRoot, path.join(salvageRoot, oldest.name));
            log.info(`Evicted stale salvage worktree: ${oldest.name}`);
        }
    } catch (err: any) {
        log.warn(`Eviction of stale salvage worktrees failed (non-fatal): ${err.message}`);
    }
}
