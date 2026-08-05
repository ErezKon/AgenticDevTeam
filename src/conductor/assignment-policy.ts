/**
 * Assignment lifecycle policy — pure functions that prevent the bug-fix loop
 * from re-dispatching already-completed work (fixes PART A2).
 *
 * `assignments` is append-reduced in LangGraph state, so after a bug-fix
 * triage round the state holds the original assignments AND the new fix
 * assignments. Dispatching the whole list re-ran every completed assignment
 * on every bug-fix iteration — up to 4x the intended development cost.
 */
import type { Assignment, Bug, PullRequest } from '../agents/_shared/base-schemas';

// ─── Assignment Filtering ───────────────────────────────────────────────────

/**
 * Which assignments still need to be dispatched.
 *
 * De-duplicates by id (keeping the first occurrence), then removes any
 * whose id appears in `completedIds`. Order is preserved.
 */
export function selectPendingAssignments(
    assignments: Assignment[],
    completedIds: string[],
): Assignment[] {
    const completedSet = new Set(completedIds);
    const seen = new Set<string>();
    const result: Assignment[] = [];
    for (const a of assignments) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (!completedSet.has(a.id)) result.push(a);
    }
    return result;
}

// ─── Completion Tracking ────────────────────────────────────────────────────

/**
 * Assignment ids that a dispatch round finished. An assignment counts as
 * complete when its PR reached 'merged' or 'approved' — an 'open' or 'failed'
 * PR must be retried by the next iteration.
 */
export function completedIdsFromPullRequests(prs: PullRequest[]): string[] {
    const ids: string[] = [];
    for (const pr of prs) {
        if (pr.status === 'merged' || pr.status === 'approved') {
            ids.push(...pr.assignmentIds);
        }
    }
    return ids;
}

// ─── Bug-fix Namespacing ────────────────────────────────────────────────────

/**
 * Namespace bug-fix assignment ids so an iteration can never collide with the
 * original assignments or a previous iteration.
 * `ASSIGN-003` + iteration 2 → `BUGFIX-2-ASSIGN-003`.
 *
 * Also rewrites `dependsOn` entries that point at other assignments in the
 * same batch, so the dispatcher's `topoSort` still resolves. Entries that
 * are not in the batch are left alone (they refer to already-completed work).
 */
export function namespaceBugfixAssignments(
    assignments: Assignment[],
    iteration: number,
): Assignment[] {
    const prefix = `BUGFIX-${iteration}-`;
    const batchIds = new Set(assignments.map(a => a.id));

    return assignments.map(a => ({
        ...a,
        id: `${prefix}${a.id}`,
        dependsOn: a.dependsOn.map(dep =>
            batchIds.has(dep) ? `${prefix}${dep}` : dep,
        ),
    }));
}

// ─── Bug Deduplication ──────────────────────────────────────────────────────

/**
 * De-duplicate bugs by id, keeping the first occurrence.
 * Bugs use an append reducer, so duplicates accumulate across iterations.
 */
export function dedupeBugs(bugs: Bug[]): Bug[] {
    const seen = new Set<string>();
    const result: Bug[] = [];
    for (const b of bugs) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        result.push(b);
    }
    return result;
}
