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
import { makeGateBug } from './bug-factory';

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

        bugs.push(makeGateBug(
            `INCOMPLETE-${e.assignmentId}`,
            `Assignment ${e.assignmentId} merged without evidence`,
            'major',
            'assignment-policy',
            `Check assignment ${e.assignmentId}: ${reasons.join('; ')}`,
            'Assignment should produce real source file changes that pass quality gates',
            `Re-dispatch needed: ${reasons.join('; ')}`,
            `Assignment ${e.assignmentId}`,
        ));
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

// ─── Story-id Sanitisation (Plan 21, E5) ────────────────────────────────────

/** Matches synthetic QA bug ids that embed a real story id, e.g. `QA-story-untested-US-001`. */
const QA_BUG_ID_WITH_STORY = /^QA-.*?-(US-\d+)$/;

/**
 * Force every assignment's `storyId` / `additionalStoryIds` to reference a real
 * user story.
 *
 * Test-sufficiency bugs get synthetic ids (`QA-no-tests`, `QA-story-untested-US-001`)
 * and bug-fix triage hands them to the Team Leader, which copies the BUG id into
 * `assignment.storyId`. The developer then silently receives no acceptance
 * criteria while the prompt claims it has them.
 *
 * Resolution ladder per id:
 *  1. known story id                      -> keep
 *  2. matches a bug that carries `storyId` -> remap to the bug's story
 *  3. matches `QA-…-US-NNN` and that story exists -> remap (belt for pre-existing state)
 *  4. otherwise                            -> drop (`storyId` becomes `''`) and warn
 *
 * Dropping beats keeping a phantom: callers filter falsy ids, so the story
 * section is omitted entirely instead of claiming criteria that do not exist.
 *
 * @returns the sanitised assignments plus the unresolvable ids (for logging).
 */
export function sanitizeAssignmentStoryIds(
    assignments: Assignment[],
    userStories: Array<{ id: string }>,
    bugs: Bug[],
): { assignments: Assignment[]; dropped: string[] } {
    const validIds = new Set(userStories.map(s => s.id));
    const bugStoryIds = new Map<string, string>();
    for (const b of bugs) {
        if (b.storyId && validIds.has(b.storyId)) bugStoryIds.set(b.id, b.storyId);
    }

    const dropped: string[] = [];

    const resolve = (id: string | undefined): string | null => {
        if (!id) return null;
        if (validIds.has(id)) return id;

        const fromBug = bugStoryIds.get(id);
        if (fromBug) return fromBug;

        const m = QA_BUG_ID_WITH_STORY.exec(id);
        if (m && validIds.has(m[1])) return m[1];

        dropped.push(id);
        return null;
    };

    const sanitized = assignments.map(a => {
        const primary = resolve(a.storyId);
        const extras = [...new Set(
            (a.additionalStoryIds ?? [])
                .map(resolve)
                .filter((id): id is string => id !== null && id !== primary),
        )];
        return { ...a, storyId: primary ?? '', additionalStoryIds: extras };
    });

    return { assignments: sanitized, dropped: [...new Set(dropped)] };
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
