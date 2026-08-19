/**
 * Worktree lifecycle — creation, disposal, salvage, and eviction.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec, gitExecVerbose, findGitRoot } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import {
    GIT_USER_NAME, GIT_USER_EMAIL,
    WORKTREE_SALVAGE_MAX, PR_SALVAGE_PATCHES,
} from '../../config';
import type { GitContext } from '../../agents/_shared/base-schemas';

const log = getLogger('[PR-Workflow]', 135);

// ─── Worktree creation ──────────────────────────────────────────────────────

export interface WorktreeResult {
    worktreeDir: string;
    worktreeWorkspace: string;
    gitRoot: string;
}

/**
 * Create an isolated worktree for a branch.
 *
 * Each branch gets its own working directory so parallel agents
 * never interfere with each other via git checkout races.
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

    // Plan 24, A2: remove ANY existing worktree whose branch is this branchName,
    // including ones under .worktrees-failed/ (salvage). Without this, `git branch -D`
    // fails because the salvage worktree still has the branch checked out, then
    // `git worktree add` fails with "A branch named '...' already exists".
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
    // Delete stale local branch if it exists (ignore errors).
    // Plan 24, A2: this now succeeds because we removed the worktree above.
    gitExec(gitRoot, `branch -D ${branchName}`);
    // Fetch latest base branch from remote (may fail if not pushed yet)
    gitExec(gitRoot, `fetch origin ${baseBranch}`);
    // Plan 24, A2: if the branch still exists despite deletion attempt (e.g. it's
    // checked out in a worktree we couldn't remove), reuse it with a hard reset.
    const branchExists = !gitExec(gitRoot, `rev-parse --verify refs/heads/${branchName}`).startsWith('Error:');

    // Create worktree with a new branch — try remote ref first, fall back to local.
    // Wrapped in try/catch so a failed creation cleans up the partial directory
    // before re-throwing (fixes A11 worktree leak).
    try {
        let wtResult: string;
        if (branchExists) {
            // Plan 24, A2: reuse existing branch — happens when a salvage worktree
            // held the branch and we couldn't fully remove it, or on a re-dispatch.
            log.info(`Reusing existing branch ${branchName} for a second dispatch round (previous attempt salvaged)`);
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" ${branchName}`);
            if (wtResult.startsWith('Error:')) {
                throw new Error(`Failed to reuse worktree for ${branchName}: ${wtResult}`);
            }
            // Reset to base to discard stale commits from previous attempt
            const resetTarget = gitExec(worktreeDir, `rev-parse --verify origin/${baseBranch}`).startsWith('Error:')
                ? baseBranch
                : `origin/${baseBranch}`;
            const resetResult = gitExec(worktreeDir, `reset --hard ${resetTarget}`);
            if (resetResult.startsWith('Error:')) {
                log.warn(`Reset to ${resetTarget} failed: ${resetResult}`);
            } else {
                log.info(`Reset reused branch to ${resetTarget}`);
            }
        } else {
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -b ${branchName} origin/${baseBranch}`);
            if (wtResult.startsWith('Error:')) {
                log.warn(`Remote ref origin/${baseBranch} not found, falling back to local branch`);
                wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -b ${branchName} ${baseBranch}`);
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

    return { worktreeDir, worktreeWorkspace, gitRoot };
}

// ─── Worktree disposal ──────────────────────────────────────────────────────

/**
 * Dispose of a worktree after PR workflow completes.
 *
 * Successful merge → remove worktree, then delete local branch.
 * Anything else    → move to .worktrees-failed/ for salvage.
 */
export function disposeWorktree(
    gitRoot: string,
    worktreeDir: string,
    branchName: string,
    wasMerged: boolean,
): void {
    const worktreeSlug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');

    // Delete local branch FIRST so the worktree can be cleanly removed
    gitExec(gitRoot, `branch -D ${branchName}`);

    if (fs.existsSync(worktreeDir)) {
        if (wasMerged) {
            // Success path — remove worktree
            gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
            log.info(`Cleaned up worktree: ${worktreeSlug}`);
        } else {
            // Failure path — preserve for salvage
            const failedDir = path.join(gitRoot, '.worktrees-failed');
            try {
                fs.mkdirSync(failedDir, { recursive: true });
                const failedPath = path.join(failedDir, worktreeSlug);
                // Remove destination if it already exists
                if (fs.existsSync(failedPath)) {
                    fs.rmSync(failedPath, { recursive: true, force: true });
                }
                // git worktree move requires the destination to NOT exist
                const moveResult = gitExecVerbose(gitRoot, `worktree move "${worktreeDir}" "${failedPath}"`);
                if (moveResult.ok) {
                    log.info(`Preserved failed worktree: ${worktreeSlug} → .worktrees-failed/`);
                } else {
                    // Fallback: just rename the directory
                    fs.renameSync(worktreeDir, failedPath);
                    log.info(`Moved failed worktree directory: ${worktreeSlug} → .worktrees-failed/`);
                }
                evictStaleSalvageWorktrees(gitRoot);
            } catch (moveErr: any) {
                log.warn(`Failed to preserve worktree (removing): ${moveErr.message}`);
                gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
            }
        }
    }
    // Prune any dangling worktree tracking entries (fixes A11 leak-proofing)
    gitExec(gitRoot, 'worktree prune');
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
 * Evict the oldest failed worktrees beyond the retention cap.
 */
export function evictStaleSalvageWorktrees(gitRoot: string): void {
    const failedDir = path.join(gitRoot, '.worktrees-failed');
    if (!fs.existsSync(failedDir)) return;
    try {
        const entries = fs.readdirSync(failedDir)
            .map(name => ({ name, mtime: fs.statSync(path.join(failedDir, name)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime); // oldest first
        while (entries.length > WORKTREE_SALVAGE_MAX) {
            const oldest = entries.shift()!;
            fs.rmSync(path.join(failedDir, oldest.name), { recursive: true, force: true });
            log.info(`Evicted stale salvage worktree: ${oldest.name}`);
        }
    } catch (err: any) {
        log.warn(`Eviction of stale salvage worktrees failed (non-fatal): ${err.message}`);
    }
}
