/**
 * Durable commit — stage, commit and push worktree changes.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { getLogger } from '../../utils/logger';
import { gitExec, gitPush } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import type { GitContext } from '../../agents/_shared/base-schemas';

const log = getLogger('[PR-Workflow]', 135);

/**
 * Stage, commit and push whatever is in the worktree. Safe to call repeatedly.
 * MUST be called from a `finally` block after every agent invocation: an agent that
 * throws (recursion limit, loop-guard poisoning, connection error) has usually already
 * written files, and those writes are otherwise lost when the worktree is removed.
 * Returns the new HEAD sha, or null when there was nothing to commit.
 */
export function commitWorktree(
    worktreeWorkspace: string,
    branchName: string,
    projectSlug: string,
    storyId: string,
    type: 'feat' | 'fix' | 'test' | 'refactor' | 'chore',
    subject: string,
    gitContext?: GitContext | null,
): string | null {
    try {
        gitExec(worktreeWorkspace, 'add .');
        const statusOutput = gitExec(worktreeWorkspace, 'status --short');
        if (!statusOutput || statusOutput.includes('nothing to commit') || statusOutput.startsWith('Error:')) {
            return null; // nothing to commit
        }
        const commitMsg = `[${projectSlug}]-[${storyId}]-${type}: ${subject}`;
        gitExec(worktreeWorkspace, `commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
        gitPush(worktreeWorkspace, branchName, gitContext);
        const sha = gitExec(worktreeWorkspace, 'rev-parse HEAD');
        const commit = sha.startsWith('Error:') ? null : sha.trim();

        // Plan 22 G3: a branch is pushed as soon as an agent finishes, but its PR
        // is only opened after every assignment on the branch completes and the
        // gates run. In the pacmanclaude run that left 27 minutes in which the
        // branch had code, no PR existed, and nothing said why — indistinguishable
        // from a crash. Announce the push explicitly.
        log.info(`Branch pushed: ${branchName} @ ${commit?.slice(0, 8) ?? '(unknown)'} — "${subject}" (PR not open yet)`);
        emitRunEvent('branch:pushed', { branchName, commit, subject, type });

        return commit;
    } catch (err: any) {
        log.warn(`commitWorktree failed (non-fatal): ${err.message}`);
        return null;
    }
}
