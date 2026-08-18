/**
 * Workspace sync — bring the local checkout up to date with origin.
 *
 * Developer work is done in throw-away worktrees and squash-merged into
 * the system branch ON THE REMOTE via the GitHub API.  The main checkout
 * that QA and DevOps agents read is therefore stale by N merges.  Without
 * this sync those agents see a tree with no application source at all
 * (see Plan 16, Finding A1).
 *
 * Strategy ladder: already-current -> merge --ff-only -> rebase -> hard reset.
 * The remote is authoritative after squash merges; local-only commits were
 * already pushed by commitAndPushArtifacts.
 */
import { getLogger } from '../utils/logger';
import { gitExec, gitExecVerbose } from '../utils/git-exec';
import { WORKSPACE_SYNC_ALLOW_RESET } from '../config';
import type { GitContext } from '../agents/_shared/base-schemas';

const log = getLogger('[WorkspaceSync]', 159);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SyncResult {
    ok: boolean;
    /** HEAD sha after the sync (empty on failure). */
    headSha: string;
    /** Human-readable description of what happened, for logs and the transcript. */
    details: string;
    /** Strategy that succeeded: 'already-current' | 'fast-forward' | 'rebase' | 'reset' | 'failed'. */
    strategy: string;
}

// ─── Pure helpers (unit-testable without a repo) ────────────────────────────

/** True when `git status --porcelain` output indicates a dirty tree. */
export function isDirty(porcelainOutput: string): boolean {
    return porcelainOutput.trim().length > 0;
}

/**
 * True when the synced workspace looks like it contains no application source
 * (only docs/, .conventions/, README and dotfiles) — a strong signal that
 * PR merges did not land and QA would be meaningless.
 */
export function looksSourceless(relativePaths: string[]): boolean {
    return !relativePaths.some(p => {
        // Normalise path separators
        const norm = p.replace(/\\/g, '/');
        // Skip docs/, .conventions/, .worktrees/, .github/
        if (norm.startsWith('docs/')) return false;
        if (norm.startsWith('.conventions/')) return false;
        if (norm.startsWith('.worktrees/')) return false;
        if (norm.startsWith('.github/')) return false;
        // Skip root dotfiles
        if (!norm.includes('/') && norm.startsWith('.')) return false;
        // Skip README.md / LICENSE at root
        const base = norm.includes('/') ? '' : norm;
        if (base === 'README.md' || base === 'LICENSE') return false;
        // Anything else counts as source
        return true;
    });
}

// ─── Fetch with retry ───────────────────────────────────────────────────────

/** Total fetch attempts (1 initial + 2 retries) before giving up. */
export const GIT_FETCH_ATTEMPTS = 3;

/** Base backoff between fetch retries; doubles each attempt. */
const FETCH_RETRY_BASE_MS = 1_000;

/** Busy-wait backoff — `syncWorkspaceToBranch` is synchronous by design. */
function sleepSync(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
}

/**
 * `git fetch origin <branch>` with bounded exponential backoff.
 *
 * Network fetches fail transiently (rate limits, DNS, a loaded machine hitting
 * the timeout). A single attempt turned a blip into a failed sync, which left
 * QA and DevOps reading a stale tree.
 */
export function fetchWithRetry(
    gitRoot: string,
    branch: string,
    attempts = GIT_FETCH_ATTEMPTS,
): { ok: boolean; stdout: string; stderr: string; code: number } {
    let last = { ok: false, stdout: '', stderr: 'fetch not attempted', code: 1 };
    for (let attempt = 1; attempt <= attempts; attempt++) {
        last = gitExecVerbose(gitRoot, `fetch origin ${branch}`);
        if (last.ok) return last;
        log.warn(`fetch origin/${branch} attempt ${attempt}/${attempts} failed [exit ${last.code}]: ${last.stderr}`);
        if (attempt < attempts) sleepSync(FETCH_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    return last;
}

// ─── Main sync function ─────────────────────────────────────────────────────

/**
 * Bring the local checkout of `branch` up to date with `origin/<branch>`.
 *
 * @param gitRoot   Absolute path to the git root (contains `.git`).
 * @param branch    The branch to sync (e.g. `project/my-app`).
 * @param gitContext  Optional git context for authenticated fetches.
 * @param opts      `allowReset`: if true (default), fall back to `reset --hard` when ff/rebase fail.
 */
export function syncWorkspaceToBranch(
    gitRoot: string,
    branch: string,
    _gitContext?: GitContext | null,
    opts?: { allowReset?: boolean },
): SyncResult {
    const allowReset = opts?.allowReset ?? WORKSPACE_SYNC_ALLOW_RESET;

    // 1. Prune stale worktree tracking entries
    gitExec(gitRoot, 'worktree prune');

    // 2. Commit uncommitted changes so nothing is lost
    const porcelain = gitExec(gitRoot, 'status --porcelain');
    if (!porcelain.startsWith('Error:') && isDirty(porcelain)) {
        log.info('Uncommitted changes detected — committing before sync');
        gitExec(gitRoot, 'add .');
        gitExec(gitRoot, 'commit -m "chore: pipeline artifacts (pre-sync auto-commit)"');
    }

    // 3. Fetch origin/<branch> — network op, so use the verbose variant with
    //    retries. A transient/SIGTERM'd fetch used to abort the whole sync with
    //    the opaque message `Error:` and no exit code (Plan 21, E6).
    const fetch = fetchWithRetry(gitRoot, branch);
    if (!fetch.ok) {
        log.error(`Failed to fetch origin/${branch} after ${GIT_FETCH_ATTEMPTS} attempt(s) [exit ${fetch.code}]: ${fetch.stderr}`);
        return { ok: false, headSha: '', details: `fetch failed (exit ${fetch.code}): ${fetch.stderr}`, strategy: 'failed' };
    }

    // 4. Ensure we are on the correct branch
    const currentBranch = gitExec(gitRoot, 'rev-parse --abbrev-ref HEAD');
    if (currentBranch !== branch) {
        // Try checkout
        let coResult = gitExec(gitRoot, `checkout ${branch}`);
        if (coResult.startsWith('Error:')) {
            // Branch may not exist locally — create tracking branch
            coResult = gitExec(gitRoot, `checkout -b ${branch} origin/${branch}`);
            if (coResult.startsWith('Error:')) {
                log.error(`Cannot checkout ${branch}: ${coResult}`);
                return { ok: false, headSha: '', details: `checkout failed: ${coResult}`, strategy: 'failed' };
            }
        }
    }

    // 5. Compare HEAD with origin/<branch>
    const localSha = gitExec(gitRoot, 'rev-parse HEAD');
    const remoteSha = gitExec(gitRoot, `rev-parse origin/${branch}`);

    if (localSha.startsWith('Error:') || remoteSha.startsWith('Error:')) {
        log.error(`Cannot resolve shas — local: ${localSha}, remote: ${remoteSha}`);
        return { ok: false, headSha: '', details: `rev-parse failed`, strategy: 'failed' };
    }

    if (localSha === remoteSha) {
        log.info(`Workspace already current at ${localSha.slice(0, 8)}`);
        return { ok: true, headSha: localSha, details: `already-current at ${localSha.slice(0, 8)}`, strategy: 'already-current' };
    }

    // 6. Try fast-forward merge
    const ffResult = gitExec(gitRoot, `merge --ff-only origin/${branch}`);
    if (!ffResult.startsWith('Error:')) {
        const newSha = gitExec(gitRoot, 'rev-parse HEAD');
        const shortstat = gitExec(gitRoot, `diff --shortstat ${localSha} ${newSha}`);
        const details = `fast-forward: ${localSha.slice(0, 8)} -> ${newSha.slice(0, 8)} ${shortstat}`.trim();
        log.info(`Workspace synced via fast-forward: ${details}`);
        return { ok: true, headSha: newSha, details, strategy: 'fast-forward' };
    }

    // 7. Try rebase
    const rebaseResult = gitExec(gitRoot, `rebase origin/${branch}`);
    if (!rebaseResult.startsWith('Error:')) {
        const newSha = gitExec(gitRoot, 'rev-parse HEAD');
        const shortstat = gitExec(gitRoot, `diff --shortstat ${localSha} ${newSha}`);
        const details = `rebase: ${localSha.slice(0, 8)} -> ${newSha.slice(0, 8)} ${shortstat}`.trim();
        log.info(`Workspace synced via rebase: ${details}`);
        return { ok: true, headSha: newSha, details, strategy: 'rebase' };
    }
    // Abort failed rebase
    gitExec(gitRoot, 'rebase --abort');

    // 8. Hard reset (if allowed)
    if (allowReset) {
        log.warn(`Fast-forward and rebase both failed — falling back to hard reset. Diverged: local=${localSha.slice(0, 8)} remote=${remoteSha.slice(0, 8)}`);
        const resetResult = gitExec(gitRoot, `reset --hard origin/${branch}`);
        if (!resetResult.startsWith('Error:')) {
            const newSha = gitExec(gitRoot, 'rev-parse HEAD');
            const shortstat = gitExec(gitRoot, `diff --shortstat ${localSha} ${newSha}`);
            const details = `reset: ${localSha.slice(0, 8)} -> ${newSha.slice(0, 8)} ${shortstat}`.trim();
            log.warn(`Workspace synced via hard reset: ${details}`);
            return { ok: true, headSha: newSha, details, strategy: 'reset' };
        }
    }

    // 9. All strategies exhausted
    log.error(`All sync strategies failed for ${branch}. local=${localSha.slice(0, 8)} remote=${remoteSha.slice(0, 8)}`);
    return { ok: false, headSha: '', details: `all strategies exhausted (local=${localSha.slice(0, 8)}, remote=${remoteSha.slice(0, 8)})`, strategy: 'failed' };
}
