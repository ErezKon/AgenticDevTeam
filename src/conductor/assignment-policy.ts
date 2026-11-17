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
import type { DispatchRound } from './gate-types';
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

/**
 * The story ids (`storyId` plus `additionalStoryIds`) the given assignments deliver.
 * Plan 30-03: QA handed `completedAssignmentIds` to the test-sufficiency check as
 * story ids, so no story ever counted as delivered.
 */
export function storyIdsOfAssignments(assignments: Assignment[], assignmentIds: string[]): string[] {
    const wanted = new Set(assignmentIds);
    const storyIds = new Set<string>();
    for (const a of assignments) {
        if (!wanted.has(a.id)) continue;
        for (const id of [a.storyId, ...(a.additionalStoryIds ?? [])]) if (id) storyIds.add(id);
    }
    return [...storyIds];
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
    /** Declared modules (resolved to paths through the repo contract) that exist on the merged tree. */
    declaredModulesPresent: number;
    declaredModulesTotal: number;
    /** Plan 30-02: module ids the repo contract does not know — the module check is "n/a" (total 0). */
    unresolvedModuleIds?: string[];
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

/** How many merged PRs have claimed each assignment id. */
function mergedAttemptCounts(prs: PullRequest[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const pr of prs) {
        if (pr.status !== 'merged') continue;
        for (const id of pr.assignmentIds) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
}

/**
 * Plan 30-02 step 8 — the intended Sub-Plan 06 §6 behaviour, wired into
 * `developmentNode`. A merged assignment without completion evidence goes back
 * to pending with an `INCOMPLETE-*` bug, until it has merged `maxAttempts`
 * times; after that it is accepted as-is so the bug-fix loop stays bounded.
 *
 * @param mergedIds  assignment ids claimed by this round's merged PRs
 * @param prs        every PR record so far, including this round's
 */
export function settleCompletion(
    mergedIds: string[],
    evidence: CompletionEvidence[],
    prs: PullRequest[],
    maxAttempts: number,
): { completed: string[]; reopened: CompletionEvidence[]; bugs: Bug[] } {
    const attempts = mergedAttemptCounts(prs);
    const merged = new Set(mergedIds);
    const reopened = completedIdsWithEvidence(evidence).incomplete
        .filter(e => merged.has(e.assignmentId) && (attempts[e.assignmentId] ?? 0) < maxAttempts);
    const reopenedIds = new Set(reopened.map(e => e.assignmentId));
    return {
        completed: mergedIds.filter(id => !reopenedIds.has(id)),
        reopened,
        bugs: incompleteBugs(reopened, attempts, maxAttempts),
    };
}

// ─── PR history and bug attempts (Plan 30-05) ───────────────────────────────

/** Consecutive unmerged rounds after which a branch is abandoned. */
export const ABANDON_AFTER_UNMERGED_ROUNDS = 2;

/** PR statuses that are not a failed attempt: merged, work still in flight, or a GitHub failure continue-run retries. */
const NOT_A_FAILED_ATTEMPT = new Set<PullRequest['status']>(['merged', 'deferred', 'pr-creation-failed']);

export interface AbandonedBranch {
    branchName: string;
    /** Consecutive failed attempts at the end of the branch's PR history. */
    rounds: number;
    lastStatus: PullRequest['status'];
}

/**
 * Branches whose last `ABANDON_AFTER_UNMERGED_ROUNDS` PR records are all failed
 * attempts (blocked, open, closed …). A deferred record ran work that the next
 * round resumes, so it ends the run of failures. claudeopus5's us-027 branch was
 * blocked round after round until the operator stopped the run.
 */
export function abandonedBranches(prs: PullRequest[]): AbandonedBranch[] {
    const byBranch = new Map<string, PullRequest[]>();
    for (const pr of prs) {
        const records = byBranch.get(pr.branchName) ?? [];
        records.push(pr);
        byBranch.set(pr.branchName, records);
    }
    const abandoned: AbandonedBranch[] = [];
    for (const [branchName, records] of byBranch) {
        let rounds = 0;
        for (let i = records.length - 1; i >= 0 && !NOT_A_FAILED_ATTEMPT.has(records[i].status); i--) rounds++;
        if (rounds >= ABANDON_AFTER_UNMERGED_ROUNDS) abandoned.push({ branchName, rounds, lastStatus: records[records.length - 1].status });
    }
    return abandoned;
}

/**
 * Assignments whose agent ran for the first time this round: claimed by this
 * round's PR records (Plan 30-02: a record claims only executed assignments) and
 * by no earlier record — a resumed branch re-claims what ran before.
 */
export function newlyExecutedIds(previousPrs: PullRequest[], roundPrs: PullRequest[]): string[] {
    const before = new Set(previousPrs.flatMap(pr => pr.assignmentIds));
    return [...new Set(roundPrs.flatMap(pr => pr.assignmentIds))].filter(id => !before.has(id));
}

/** A dispatch round's progress record: merged PRs, first executions and deferred work (Plan 30-05). */
export function dispatchRoundOf(
    previousPrs: PullRequest[],
    round: { pullRequests: PullRequest[]; fileChanges: number; deferredAssignmentIds: string[]; completed: number },
): DispatchRound {
    return {
        fileChanges: round.fileChanges,
        merged: round.pullRequests.filter(pr => pr.status === 'merged').length,
        executed: newlyExecutedIds(previousPrs, round.pullRequests).length,
        deferred: round.deferredAssignmentIds.length,
        completed: round.completed,
    };
}

/**
 * Plan 30-05 step 5: a bug's attempt count grows once per round in which an
 * assignment that works on it (`bugIds`) actually ran. Triage used to count every
 * bug it handed out, whether or not any work on it ran.
 *
 * @returns the new counts of the bugs worked on (the state reducer keeps the maximum)
 */
export function bugAttemptsAfterRound(
    assignments: Assignment[],
    executedIds: string[],
    attempts: Record<string, number>,
): Record<string, number> {
    const executed = new Set(executedIds);
    const worked = new Set(assignments.filter(a => executed.has(a.id)).flatMap(a => a.bugIds ?? []));
    return Object.fromEntries([...worked].map(id => [id, (attempts[id] ?? 0) + 1]));
}

/**
 * The open bugs a bug-fix assignment works on: its `bugIds` when the Team Leader
 * set them, otherwise the open bug ids its description names.
 */
export function resolveBugIds(assignment: Assignment, openBugIds: string[]): string[] {
    const listed = (assignment.bugIds ?? []).filter(id => openBugIds.includes(id));
    return listed.length > 0 ? listed : openBugIds.filter(id => namesId(assignment.description ?? '', id));
}

/** True when `text` names `id` as a whole token, so `AC-US-001-1` is not found inside `AC-US-001-10`. */
function namesId(text: string, id: string): boolean {
    for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
        if (!/[\w-]/.test(text[at - 1] ?? ' ') && !/[\w-]/.test(text[at + id.length] ?? ' ')) return true;
    }
    return false;
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
