/**
 * Git State Reconciliation — verify and fix workspace git state before
 * resuming a continued run.
 *
 * Sub-Plan 08 of the "Continue Run" feature (Plan 23).
 *
 * Before the pipeline resumes, the workspace must be in a clean,
 * consistent git state:
 *
 * 1. Workspace exists and is a git repo
 * 2. Current branch is the system branch (project/<slug>)
 * 3. Working tree is clean (no uncommitted changes)
 * 4. Remote is reachable (live GitHub mode)
 * 5. Stale worktrees are pruned
 * 6. Stale lock files are removed
 * 7. Partially-completed branches are cleaned up
 * 8. Workspace is synced with remote
 *
 * Called by `continueRun()` in `run.ts` after singleton rehydration and
 * before graph invocation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { gitExec, gitExecVerbose } from '../../utils/git-exec';
import { appendLedger } from '../../utils/run-ledger';
import { CONTINUE_GIT_RECONCILE, CONTINUE_CLOSE_STALE_PRS } from '../../config';
import { GITHUB_MODE } from '../../utils/github-local';
import type { CollectedRunState, BranchStatus } from './state-collector';

const log = getLogger('[GitReconciliation]', 177);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of a single reconciliation check. */
interface CheckResult {
    check: string;
    ok: boolean;
    details: string;
    action?: string; // what was done to fix it
}

/** Overall reconciliation result. */
export interface ReconciliationResult {
    ok: boolean;
    checks: CheckResult[];
    warnings: string[];
    /** The system branch the workspace is on after reconciliation. */
    systemBranch: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Verify and fix the workspace git state before resuming a continued run.
 *
 * This function performs a series of checks and fixes to ensure the workspace
 * is in a clean, consistent state for pipeline resumption. It is designed to
 * be conservative: checks that fail non-fatally log warnings but don't abort.
 *
 * @param collected - The collected run state from the state collector.
 * @param state - The reconstructed state object.
 * @returns A `ReconciliationResult` with check details and overall status.
 *
 * @throws Only when `collected.workspacePath` is empty or does not exist — these
 *         are fatal conditions that should be caught upstream.
 */
export function reconcileGitState(
    collected: CollectedRunState,
    state: Record<string, any>,
): ReconciliationResult {
    if (!CONTINUE_GIT_RECONCILE) {
        log.info('Git reconciliation disabled (CONTINUE_GIT_RECONCILE=false)');
        return {
            ok: true,
            checks: [{ check: 'skip', ok: true, details: 'reconciliation disabled' }],
            warnings: [],
            systemBranch: detectSystemBranch(collected, state),
        };
    }

    const workspacePath = collected.workspacePath;
    const checks: CheckResult[] = [];
    const warnings: string[] = [];

    log.info(`Reconciling git state for workspace: ${workspacePath}`);

    // ── 1. Workspace exists and is a git repo ────────────────────────────
    const existsCheck = checkWorkspaceIsGitRepo(collected);
    checks.push(existsCheck);
    if (!existsCheck.ok) {
        // Fatal — cannot continue without a valid git repo
        return { ok: false, checks, warnings, systemBranch: '' };
    }

    // ── 2. Stale lock files ──────────────────────────────────────────────
    // Must be done before any git operations — stale locks block everything
    const lockCheck = removeStaleLockFiles(workspacePath);
    checks.push(lockCheck);

    // ── 3. Worktree cleanup ──────────────────────────────────────────────
    const worktreeCheck = cleanupWorktrees(workspacePath);
    checks.push(worktreeCheck);

    // ── 4. Determine and checkout system branch ──────────────────────────
    const systemBranch = detectSystemBranch(collected, state);
    const branchCheck = ensureSystemBranch(workspacePath, systemBranch);
    checks.push(branchCheck);
    if (!branchCheck.ok) {
        warnings.push(`Could not checkout system branch "${systemBranch}": ${branchCheck.details}`);
    }

    // ── 5. Clean working tree ────────────────────────────────────────────
    const cleanCheck = ensureCleanWorkingTree(workspacePath);
    checks.push(cleanCheck);

    // ── 6. Remote reachability (live mode only) ──────────────────────────
    if (GITHUB_MODE === 'live') {
        const remoteCheck = checkRemoteReachable(workspacePath);
        checks.push(remoteCheck);
        if (!remoteCheck.ok) {
            warnings.push(`Remote is not reachable: ${remoteCheck.details}`);
        }
    }

    // ── 7. Branch cleanup for partially-completed development ────────────
    const branchCleanup = cleanupStaleBranches(
        workspacePath,
        collected.prBranchStatus,
        systemBranch,
    );
    checks.push(branchCleanup);

    // ── 8. Sync with remote ──────────────────────────────────────────────
    const syncCheck = syncWithRemote(workspacePath, systemBranch);
    checks.push(syncCheck);
    if (!syncCheck.ok) {
        warnings.push(`Remote sync failed: ${syncCheck.details}`);
    }

    // ── 9. Close stale PRs (live mode only) ──────────────────────────────
    if (GITHUB_MODE === 'live' && CONTINUE_CLOSE_STALE_PRS) {
        const openPRBranches = collected.prBranchStatus
            .filter(b => b.status === 'open')
            .map(b => b.branch);
        if (openPRBranches.length > 0) {
            // We log the intent but don't actually close PRs here — that
            // requires Octokit and gitContext which are not available at
            // this level. The PR workflow will handle re-creation.
            log.info(
                `${openPRBranches.length} open PR branch(es) from previous run will be ` +
                `superseded when development re-dispatches: ${openPRBranches.join(', ')}`,
            );
        }
    }

    // Append a ledger entry for the reconciliation
    appendLedger({
        kind: 'invariant',
        id: 'git-reconciliation',
        phase: 'intake',
        detail: `git-reconciliation: ${checks.filter(c => c.ok).length}/${checks.length} checks passed`,
    });

    const allOk = checks.every(c => c.ok) || checks.every(c => c.ok || !isFatal(c));
    log.info(
        `Git reconciliation ${allOk ? 'complete' : 'completed with issues'}: ` +
        `${checks.filter(c => c.ok).length}/${checks.length} checks passed`,
    );

    return { ok: allOk, checks, warnings, systemBranch };
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Checks that are fatal if they fail. */
function isFatal(check: CheckResult): boolean {
    return check.check === 'workspace-is-git-repo';
}

/**
 * Detect the system branch from the reconstructed state or git state.
 *
 * The system branch follows the pattern `project/<slug>`.
 */
function detectSystemBranch(
    collected: CollectedRunState,
    state: Record<string, any>,
): string {
    // Primary: from state.systemBranch (set by intakeNode)
    if (state.systemBranch && typeof state.systemBranch === 'string') {
        return state.systemBranch;
    }

    // Fallback: derive from system name
    const systemName = state.input?.systemName
        ?? collected.manifest?.systemName;
    if (systemName) {
        const slug = systemName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        return `project/${slug}`;
    }

    // Last resort: check current branch in git
    if (collected.workspaceIsGitRepo) {
        const currentBranch = gitExec(collected.workspacePath, 'rev-parse --abbrev-ref HEAD');
        if (!currentBranch.startsWith('Error:') && currentBranch.startsWith('project/')) {
            return currentBranch;
        }
    }

    // Default fallback
    return 'main';
}

// ─── Individual checks ──────────────────────────────────────────────────────

/** Check 1: Workspace exists and is a git repo. */
function checkWorkspaceIsGitRepo(collected: CollectedRunState): CheckResult {
    if (!collected.workspacePath) {
        return {
            check: 'workspace-is-git-repo',
            ok: false,
            details: 'Workspace path is unknown',
        };
    }
    if (!collected.workspaceExists) {
        return {
            check: 'workspace-is-git-repo',
            ok: false,
            details: `Workspace directory does not exist: ${collected.workspacePath}`,
        };
    }
    if (!collected.workspaceIsGitRepo) {
        return {
            check: 'workspace-is-git-repo',
            ok: false,
            details: `Workspace is not a git repository: ${collected.workspacePath}`,
        };
    }
    return {
        check: 'workspace-is-git-repo',
        ok: true,
        details: `Valid git repo at ${collected.workspacePath}`,
    };
}

/** Check 2: Remove stale .git lock files that may remain from a killed process. */
function removeStaleLockFiles(workspacePath: string): CheckResult {
    const gitDir = path.join(workspacePath, '.git');
    const removed: string[] = [];

    try {
        // Remove .git/*.lock files
        const gitDirEntries = fs.readdirSync(gitDir);
        for (const entry of gitDirEntries) {
            if (entry.endsWith('.lock')) {
                const lockPath = path.join(gitDir, entry);
                fs.unlinkSync(lockPath);
                removed.push(entry);
                log.info(`Removed stale lock file: ${entry}`);
            }
        }

        // Remove .git/worktrees/*/locked files
        const worktreesDir = path.join(gitDir, 'worktrees');
        if (fs.existsSync(worktreesDir)) {
            const worktreeEntries = fs.readdirSync(worktreesDir, { withFileTypes: true });
            for (const entry of worktreeEntries) {
                if (entry.isDirectory()) {
                    const lockedFile = path.join(worktreesDir, entry.name, 'locked');
                    if (fs.existsSync(lockedFile)) {
                        fs.unlinkSync(lockedFile);
                        removed.push(`worktrees/${entry.name}/locked`);
                        log.info(`Removed stale worktree lock: worktrees/${entry.name}/locked`);
                    }
                }
            }
        }
    } catch (err: any) {
        return {
            check: 'stale-lock-files',
            ok: true, // non-fatal
            details: `Error scanning for lock files: ${err.message}`,
        };
    }

    return {
        check: 'stale-lock-files',
        ok: true,
        details: removed.length > 0
            ? `Removed ${removed.length} stale lock file(s): ${removed.join(', ')}`
            : 'No stale lock files found',
        action: removed.length > 0 ? `removed ${removed.length} lock files` : undefined,
    };
}

/** Check 3: Clean up stale worktrees from the previous run. */
function cleanupWorktrees(workspacePath: string): CheckResult {
    const removed: string[] = [];

    // Remove .worktrees/ directory (used by the dispatcher for feature branch worktrees)
    const worktreesDir = path.join(workspacePath, '.worktrees');
    if (fs.existsSync(worktreesDir)) {
        try {
            const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const worktreePath = path.join(worktreesDir, entry.name);
                    try {
                        fs.rmSync(worktreePath, { recursive: true, force: true });
                        removed.push(entry.name);
                    } catch (err: any) {
                        log.warn(`Failed to remove worktree directory ${entry.name}: ${err.message}`);
                    }
                }
            }
        } catch (err: any) {
            log.warn(`Failed to scan worktrees directory: ${err.message}`);
        }
    }

    // Remove .worktrees-failed/ directory
    const failedDir = path.join(workspacePath, '.worktrees-failed');
    if (fs.existsSync(failedDir)) {
        try {
            fs.rmSync(failedDir, { recursive: true, force: true });
            removed.push('.worktrees-failed');
        } catch (err: any) {
            log.warn(`Failed to remove .worktrees-failed/: ${err.message}`);
        }
    }

    // Prune stale worktree references from git
    const pruneResult = gitExec(workspacePath, 'worktree prune');
    if (pruneResult.startsWith('Error:')) {
        log.warn(`git worktree prune failed: ${pruneResult}`);
    }

    return {
        check: 'worktree-cleanup',
        ok: true,
        details: removed.length > 0
            ? `Cleaned up ${removed.length} worktree(s): ${removed.join(', ')}`
            : 'No stale worktrees found',
        action: removed.length > 0 ? `removed ${removed.length} worktrees` : undefined,
    };
}

/** Check 4: Ensure the workspace is on the system branch. */
function ensureSystemBranch(workspacePath: string, systemBranch: string): CheckResult {
    const currentBranch = gitExec(workspacePath, 'rev-parse --abbrev-ref HEAD');
    if (currentBranch.startsWith('Error:')) {
        return {
            check: 'system-branch',
            ok: false,
            details: `Cannot determine current branch: ${currentBranch}`,
        };
    }

    if (currentBranch === systemBranch) {
        return {
            check: 'system-branch',
            ok: true,
            details: `Already on system branch: ${systemBranch}`,
        };
    }

    // Try to checkout the system branch
    log.info(`Switching from "${currentBranch}" to system branch "${systemBranch}"`);
    let coResult = gitExec(workspacePath, `checkout ${systemBranch}`);
    if (coResult.startsWith('Error:')) {
        // Branch may not exist locally — try creating a tracking branch
        coResult = gitExec(workspacePath, `checkout -b ${systemBranch} origin/${systemBranch}`);
        if (coResult.startsWith('Error:')) {
            // Last resort: the branch might just not exist remotely either
            // Try checking out 'main' as a fallback
            coResult = gitExec(workspacePath, 'checkout main');
            if (coResult.startsWith('Error:')) {
                return {
                    check: 'system-branch',
                    ok: false,
                    details: `Cannot checkout system branch "${systemBranch}" or "main"`,
                };
            }
            return {
                check: 'system-branch',
                ok: true,
                details: `System branch "${systemBranch}" not found — fell back to "main"`,
                action: 'checked out main',
            };
        }
    }

    return {
        check: 'system-branch',
        ok: true,
        details: `Switched to system branch: ${systemBranch}`,
        action: `checked out ${systemBranch}`,
    };
}

/** Check 5: Ensure the working tree has no uncommitted changes. */
function ensureCleanWorkingTree(workspacePath: string): CheckResult {
    const porcelain = gitExec(workspacePath, 'status --porcelain');
    if (porcelain.startsWith('Error:')) {
        return {
            check: 'clean-working-tree',
            ok: false,
            details: `Cannot check working tree status: ${porcelain}`,
        };
    }

    if (porcelain.trim().length === 0) {
        return {
            check: 'clean-working-tree',
            ok: true,
            details: 'Working tree is clean',
        };
    }

    // Auto-commit dirty changes
    log.info('Working tree has uncommitted changes — auto-committing');
    gitExec(workspacePath, 'add .');
    const commitResult = gitExec(
        workspacePath,
        'commit -m "chore: auto-commit pre-continuation"',
    );
    if (commitResult.startsWith('Error:')) {
        return {
            check: 'clean-working-tree',
            ok: true, // non-fatal — changes are just unstaged
            details: `Auto-commit failed (changes still present): ${commitResult}`,
        };
    }

    return {
        check: 'clean-working-tree',
        ok: true,
        details: 'Uncommitted changes auto-committed',
        action: 'auto-committed changes',
    };
}

/** Check 6: Test remote reachability (live mode only). */
function checkRemoteReachable(workspacePath: string): CheckResult {
    const result = gitExecVerbose(workspacePath, 'ls-remote origin --exit-code');
    if (result.ok) {
        return {
            check: 'remote-reachable',
            ok: true,
            details: 'Remote origin is reachable',
        };
    }

    return {
        check: 'remote-reachable',
        ok: false,
        details: `Remote origin is not reachable: ${result.stderr}`,
    };
}

/** Check 7: Clean up branches from partially-completed development. */
function cleanupStaleBranches(
    workspacePath: string,
    prBranchStatus: BranchStatus[],
    systemBranch: string,
): CheckResult {
    if (prBranchStatus.length === 0) {
        return {
            check: 'branch-cleanup',
            ok: true,
            details: 'No PR branches to clean up',
        };
    }

    const cleaned: string[] = [];
    const errors: string[] = [];

    for (const { branch, status } of prBranchStatus) {
        if (branch === systemBranch) continue; // never delete the system branch

        switch (status) {
            case 'merged':
                // Already in main — delete local branch if it exists
                deleteLocalBranch(workspacePath, branch, cleaned, errors);
                break;

            case 'open':
                // Will be re-created on dispatch — delete local branch
                deleteLocalBranch(workspacePath, branch, cleaned, errors);
                break;

            case 'failed-salvaged':
                // Salvage patches already in outputs/ — delete local branch
                deleteLocalBranch(workspacePath, branch, cleaned, errors);
                break;

            case 'pr-creation-failed':
                // Branch code is pushed but PR creation failed — keep the branch
                // so continue-run can retry PR creation without re-running dev agents
                log.info(`Keeping branch ${branch} — PR creation will be retried`);
                break;

            case 'unknown':
                // Leave unknown branches alone — err on the side of caution
                break;
        }
    }

    const details = cleaned.length > 0
        ? `Cleaned up ${cleaned.length} stale branch(es): ${cleaned.join(', ')}`
        : 'No stale branches to clean up';

    if (errors.length > 0) {
        log.warn(`Branch cleanup errors: ${errors.join('; ')}`);
    }

    return {
        check: 'branch-cleanup',
        ok: true,
        details,
        action: cleaned.length > 0 ? `deleted ${cleaned.length} branches` : undefined,
    };
}

/** Helper: delete a local branch, recording the result. */
function deleteLocalBranch(
    workspacePath: string,
    branch: string,
    cleaned: string[],
    errors: string[],
): void {
    // Check if the branch exists locally
    const exists = gitExec(workspacePath, `rev-parse --verify ${branch}`);
    if (exists.startsWith('Error:')) return; // doesn't exist — nothing to do

    const result = gitExec(workspacePath, `branch -D ${branch}`);
    if (result.startsWith('Error:')) {
        errors.push(`Failed to delete ${branch}: ${result}`);
    } else {
        cleaned.push(branch);
        log.info(`Deleted stale local branch: ${branch}`);
    }
}

/** Check 8: Sync workspace with remote. */
function syncWithRemote(workspacePath: string, systemBranch: string): CheckResult {
    // Fetch latest from origin
    const fetchResult = gitExecVerbose(workspacePath, 'fetch origin');
    if (!fetchResult.ok) {
        return {
            check: 'remote-sync',
            ok: false,
            details: `git fetch failed: ${fetchResult.stderr}`,
        };
    }

    // Check if the remote branch exists
    const remoteSha = gitExec(workspacePath, `rev-parse origin/${systemBranch}`);
    if (remoteSha.startsWith('Error:')) {
        // No remote tracking branch — that's okay for local mode or first push
        return {
            check: 'remote-sync',
            ok: true,
            details: `No remote tracking branch origin/${systemBranch} — skipping sync`,
        };
    }

    const localSha = gitExec(workspacePath, 'rev-parse HEAD');
    if (localSha.startsWith('Error:')) {
        return {
            check: 'remote-sync',
            ok: false,
            details: `Cannot determine HEAD: ${localSha}`,
        };
    }

    if (localSha === remoteSha) {
        return {
            check: 'remote-sync',
            ok: true,
            details: `Already in sync with origin/${systemBranch} at ${localSha.slice(0, 8)}`,
        };
    }

    // Try fast-forward merge
    const mergeResult = gitExec(workspacePath, `merge origin/${systemBranch} --no-edit`);
    if (mergeResult.startsWith('Error:')) {
        // If merge fails, try rebase as fallback
        const rebaseResult = gitExec(workspacePath, `rebase origin/${systemBranch}`);
        if (rebaseResult.startsWith('Error:')) {
            gitExec(workspacePath, 'rebase --abort');
            return {
                check: 'remote-sync',
                ok: false,
                details: `Cannot sync with origin/${systemBranch}: merge and rebase both failed`,
            };
        }
        return {
            check: 'remote-sync',
            ok: true,
            details: `Synced with origin/${systemBranch} via rebase: ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`,
            action: 'rebased',
        };
    }

    return {
        check: 'remote-sync',
        ok: true,
        details: `Synced with origin/${systemBranch} via merge: ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`,
        action: 'merged',
    };
}
