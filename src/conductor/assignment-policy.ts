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

// ─── Completion Evidence ────────────────────────────────────────────────────

/**
 * Evidence that an assignment was completed with real file changes,
 * not just a merged PR with zero or phantom changes (fixes A11 / Sub-Plan 06 SS6).
 */
export interface CompletionEvidence {
    assignmentId: string;
    /** Distinct source files (excluding docs/ and pipeline metadata) changed on the merged branch, per `git diff --name-only`. */
    filesChanged: number;
    /** Files the assignment's declared modules require that now exist on the merged tree. */
    declaredModulesPresent: number;
    declaredModulesTotal: number;
    gatePassed: boolean;
    merged: boolean;
}

/**
 * Assignment ids that a dispatch round finished. An assignment counts as
 * complete only when its PR has been merged — an approved-but-unmerged PR
 * delivered nothing and must not prevent re-dispatch.
 *
 * Sub-Plan 07: removed `'approved'` from the completion set. A `'blocked'`
 * PR stays pending so the bugfix loop retries it.
 */
export function completedIdsFromPullRequests(prs: PullRequest[]): string[] {
    const ids: string[] = [];
    for (const pr of prs) {
        if (pr.status === 'merged') {
            ids.push(...pr.assignmentIds);
        }
    }
    return ids;
}

/**
 * Evidence-based completion: require that a merged PR actually contains
 * real file changes. Assignments that merge without evidence go back to
 * `pending` and get an `INCOMPLETE-*` Bug so triage re-dispatches them.
 *
 * Completion requires:
 *   merged === true AND filesChanged > 0 AND gatePassed === true
 *   AND (declaredModulesPresent === declaredModulesTotal when modules are declared)
 */
export function completedIdsWithEvidence(
    evidence: CompletionEvidence[],
): { completed: string[]; incomplete: CompletionEvidence[] } {
    const completed: string[] = [];
    const incomplete: CompletionEvidence[] = [];

    for (const e of evidence) {
        const modulesOk = e.declaredModulesTotal === 0 || e.declaredModulesPresent === e.declaredModulesTotal;
        if (e.merged && e.filesChanged > 0 && e.gatePassed && modulesOk) {
            completed.push(e.assignmentId);
        } else {
            incomplete.push(e);
        }
    }

    return { completed, incomplete };
}

/**
 * Synthesise INCOMPLETE-* bugs for assignments that merged without evidence.
 */
export function incompleteBugs(
    incomplete: CompletionEvidence[],
    attemptCounts: Record<string, number>,
    maxAttempts: number,
): Bug[] {
    const bugs: Bug[] = [];
    for (const e of incomplete) {
        const attempts = attemptCounts[e.assignmentId] ?? 0;
        if (attempts >= maxAttempts) continue; // capped — avoid infinite loop

        const reasons: string[] = [];
        if (!e.merged) reasons.push('PR was not merged');
        if (e.filesChanged === 0) reasons.push('zero real source file changes (only docs/metadata)');
        if (!e.gatePassed) reasons.push('quality gates did not pass');
        if (e.declaredModulesTotal > 0 && e.declaredModulesPresent < e.declaredModulesTotal) {
            reasons.push(`only ${e.declaredModulesPresent}/${e.declaredModulesTotal} declared modules present`);
        }

        bugs.push({
            id: `INCOMPLETE-${e.assignmentId}`,
            title: `Assignment ${e.assignmentId} merged without evidence`,
            severity: 'major',
            stepsToReproduce: `Check assignment ${e.assignmentId}: ${reasons.join('; ')}`,
            expectedBehavior: 'Assignment should produce real source file changes that pass quality gates',
            actualBehavior: `Re-dispatch needed: ${reasons.join('; ')}`,
            suspectedArea: `Assignment ${e.assignmentId}`,
            reportedBy: 'assignment-policy',
        });
    }
    return bugs;
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
        // Ensure bugfix assignments have taskIds (required by schema since Sub-Plan 04)
        taskIds: a.taskIds?.length ? a.taskIds : [`${prefix}${a.id}`],
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
