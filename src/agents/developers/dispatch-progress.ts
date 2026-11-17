/**
 * Plan 30-I: dispatch progress snapshots.
 *
 * The dispatcher used to snapshot `{ phase, pullRequests, fileChanges,
 * completedAssignmentIds }` straight into state.json, replacing the full run state
 * (architecture, stories, tasks, assignments, git context) with a 4-key object
 * (pacman-live-analysis-3, F13). Progress is now appended onto the state captured at
 * dispatch entry, mirroring the append reducers of those three channels.
 */
import type { FileChange, PullRequest } from '../_shared/base-schemas';

export function mergeDispatchProgress(
    base: Record<string, any>,
    pullRequests: PullRequest[],
    fileChanges: FileChange[],
    completedAssignmentIds: string[],
): Record<string, any> {
    return {
        ...base,
        pullRequests: [...(base.pullRequests ?? []), ...pullRequests],
        fileChanges: [...(base.fileChanges ?? []), ...fileChanges],
        completedAssignmentIds: [...(base.completedAssignmentIds ?? []), ...completedAssignmentIds],
    };
}
