/**
 * Durable commit — stage, commit and push worktree changes.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08). Plan 30-02: every push is
 * verified (`pushBranch`), and the durable-commit subject that records which
 * assignment ran has one formatter/parser pair, so a branch resumed from its
 * remote head can tell which assignments already executed.
 */
import { getLogger } from '../../utils/logger';
import { gitExec, gitExecVerbose, gitPush } from '../../utils/git-exec';
import { stageWorkspaceChanges } from '../../utils/repo-hygiene';
import { emitRunEvent } from '../../utils/event-bus';
import type { GitContext } from '../../agents/_shared/base-schemas';

const log = getLogger('[PR-Workflow]', 135);

// ─── Durable-commit subjects (Plan 30-02) ───────────────────────────────────

const DURABLE_SUBJECT_RE = /\bwork from (\S+) on (\S+) \(durable commit\)$/;

/**
 * Subject of the commit made after an assignment's agent ran; `executedAssignmentIds`
 * parses it back. A failed run is marked (`durable commit, failed`) so a resumed
 * branch runs that assignment again on top of its partial work.
 */
export function durableCommitSubject(devAgentId: string, assignmentId: string, failed = false): string {
    return `work from ${devAgentId} on ${assignmentId} (durable commit${failed ? ', failed' : ''})`;
}

/** The assignment id a successful run's durable-commit subject records, or null for any other commit. */
export function parseDurableCommitSubject(subject: string): string | null {
    return DURABLE_SUBJECT_RE.exec(subject.trim())?.[2] ?? null;
}

/**
 * Assignments that already ran successfully on the checked-out branch, read
 * from the durable-commit subjects in `<baseRef>..HEAD`. An unreadable log
 * yields an empty set: re-running an assignment is safe, skipping one is not.
 */
export function executedAssignmentIds(worktreeWorkspace: string, baseRef: string): Set<string> {
    const subjects = gitExec(worktreeWorkspace, `log --format=%s ${baseRef}..HEAD`);
    if (subjects.startsWith('Error:')) {
        log.warn(`Cannot read the commit subjects of ${baseRef}..HEAD (${subjects}) — every assignment will run`);
        return new Set();
    }
    const ids = new Set<string>();
    for (const line of subjects.split('\n')) {
        const id = parseDurableCommitSubject(line);
        if (id) ids.add(id);
    }
    return ids;
}

// ─── Verified push (Plan 30-02) ─────────────────────────────────────────────

export interface PushResult {
    pushed: boolean;
    /** Git's output when the push did not land. */
    error?: string;
}

/** True when git refused a push because the remote branch has commits the local one lacks. */
export function isNonFastForward(gitOutput: string): boolean {
    return /non-fast-forward|fetch first|\[rejected\]|tip of your current branch is behind/i.test(gitOutput);
}

/**
 * Fetch `origin/<branch>` and replay the local commits on top of it, merging
 * when the rebase conflicts. Returns null once HEAD contains the remote
 * branch, otherwise why it could not.
 */
function integrateRemoteBranch(worktreeWorkspace: string, branchName: string): string | null {
    const fetch = gitExecVerbose(worktreeWorkspace, `fetch origin +refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
    if (!fetch.ok) return `fetch of origin/${branchName} failed: ${fetch.stderr}`;
    if (gitExecVerbose(worktreeWorkspace, `rebase origin/${branchName}`).ok) return null;
    gitExec(worktreeWorkspace, 'rebase --abort');
    const merge = gitExecVerbose(worktreeWorkspace, `merge --no-edit origin/${branchName}`);
    if (merge.ok) return null;
    gitExec(worktreeWorkspace, 'merge --abort');
    return `origin/${branchName} conflicts with the local commits (rebase and merge both failed): ${merge.stderr}`;
}

/**
 * Push HEAD to the branch on the remote and confirm it landed. A
 * non-fast-forward rejection integrates `origin/<branch>` (rebase, merge as
 * fallback) and retries once. A push that still fails is logged as an ERROR
 * and emitted as `branch:push-failed` — it is never reported as pushed.
 */
export function pushBranch(worktreeWorkspace: string, branchName: string, gitContext?: GitContext | null): PushResult {
    let out = gitPush(worktreeWorkspace, branchName, gitContext);
    if (!out.startsWith('Error:')) return { pushed: true };
    if (isNonFastForward(out)) {
        log.warn(`Push of ${branchName} rejected (non-fast-forward) — integrating origin/${branchName} and retrying once`);
        const blocker = integrateRemoteBranch(worktreeWorkspace, branchName);
        out = blocker === null ? gitPush(worktreeWorkspace, branchName, gitContext) : `Error: ${blocker}`;
        if (!out.startsWith('Error:')) {
            log.info(`Push of ${branchName} succeeded after integrating origin/${branchName}`);
            return { pushed: true };
        }
    }
    log.error(`Push of ${branchName} FAILED: ${out}`);
    emitRunEvent('branch:push-failed', { branchName, error: out.slice(0, 500) });
    return { pushed: false, error: out };
}

// ─── Durable commit ─────────────────────────────────────────────────────────

/** HEAD of the worktree, or '' when it cannot be read. */
export function headSha(worktreeWorkspace: string): string {
    const sha = gitExec(worktreeWorkspace, 'rev-parse HEAD');
    return sha.startsWith('Error:') ? '' : sha.trim();
}

export interface CommitResult extends PushResult {
    /** HEAD after the commit; null when there was nothing to commit or the commit failed. */
    sha: string | null;
}

/**
 * Stage (`stageWorkspaceChanges`), commit with `message` and push with
 * verification. Nothing to commit returns `{ sha: null, pushed: false }` without
 * an `error`. Plan 30-04: conflicted files that still contain conflict markers
 * are never staged, so a merge is not completed with them — nothing is
 * committed until every conflict is resolved (the merge ladder used to commit
 * the markers and report the conflict as resolved).
 */
export function commitAndPush(
    worktreeWorkspace: string,
    branchName: string,
    message: string,
    gitContext?: GitContext | null,
): CommitResult {
    try {
        const stage = stageWorkspaceChanges(worktreeWorkspace);
        if (stage.error) {
            log.error(`Staging on ${branchName} failed: ${stage.error}`);
            return { sha: null, pushed: false, error: stage.error };
        }
        if (stage.unresolvedConflicts.length > 0) {
            const error = `${stage.unresolvedConflicts.length} file(s) still contain merge-conflict markers `
                + `(${stage.unresolvedConflicts.join(', ')}) — nothing committed, the merge stays open`;
            log.warn(`${branchName}: ${error}`);
            return { sha: null, pushed: false, error };
        }
        if (stage.staged.length === 0) return { sha: null, pushed: false }; // nothing to commit
        const commitOut = gitExec(worktreeWorkspace, `commit -m "${message.replace(/["\\]/g, '\\$&')}"`);
        if (commitOut.startsWith('Error:')) {
            log.error(`Commit on ${branchName} failed: ${commitOut}`);
            return { sha: null, pushed: false, error: commitOut };
        }
        const push = pushBranch(worktreeWorkspace, branchName, gitContext);
        // Read HEAD after the push: a non-fast-forward recovery rebases the commit.
        return { sha: headSha(worktreeWorkspace) || null, ...push };
    } catch (err: any) {
        log.warn(`Commit on ${branchName} failed (non-fatal): ${err.message}`);
        return { sha: null, pushed: false, error: err.message };
    }
}

/**
 * Stage, commit and push whatever is in the worktree. Safe to call repeatedly.
 * MUST be called from a `finally` block after every agent invocation: an agent that
 * throws (recursion limit, loop-guard poisoning, connection error) has usually already
 * written files, and those writes are otherwise lost when the worktree is removed.
 * Nothing to commit returns `{ sha: null, pushed: false }` without an `error`.
 */
export function commitWorktree(
    worktreeWorkspace: string,
    branchName: string,
    projectSlug: string,
    storyId: string,
    type: 'feat' | 'fix' | 'test' | 'refactor' | 'chore',
    subject: string,
    gitContext?: GitContext | null,
): CommitResult {
    const result = commitAndPush(worktreeWorkspace, branchName, `[${projectSlug}]-[${storyId}]-${type}: ${subject}`, gitContext);
    if (result.pushed) {
        // Plan 22 G3: a branch is pushed as soon as an agent finishes, but its PR
        // is only opened after every assignment on the branch completes and the
        // gates run. In the pacmanclaude run that left 27 minutes in which the
        // branch had code, no PR existed, and nothing said why — indistinguishable
        // from a crash. Announce the push explicitly.
        log.info(`Branch pushed: ${branchName} @ ${result.sha?.slice(0, 8) ?? '(unknown)'} — "${subject}" (PR not open yet)`);
        emitRunEvent('branch:pushed', { branchName, commit: result.sha, subject, type });
    }
    return result;
}
