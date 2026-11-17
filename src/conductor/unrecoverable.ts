/**
 * Runaway detection — is any further pipeline work able to change the outcome?
 *
 * Moved out of acceptance-gate.ts and rewritten in Plan 30-05. It is called at
 * the top of `bugfixTriageNode` and by the acceptance gate. The claudeopus5 run
 * repeated the same failing round three times without tripping any rule: the
 * zero-progress check counted unmerged file changes as progress, a blocked PR
 * was not a signal, and repeated attempts were counted only for `ACCEPT-` and
 * `GATE-` bugs. Only `MAX_BUGFIX_ITERATIONS` would have ended it.
 *
 * A run is unrecoverable when:
 *  1. `UNRECOVERABLE_ZERO_ROUNDS` consecutive dispatch rounds merged no PR (a
 *     round that deferred work to the next one is in flight, not a stall);
 *  2. a branch stayed unmerged for `ABANDON_AFTER_UNMERGED_ROUNDS` rounds
 *     (abandoned) and every pending assignment is on it or waits for it;
 *  3. development produced nothing at all (sourceless workspace);
 *  4. two consecutive triage rounds see the same open bugs;
 *  5. three open bugs, of any kind, were worked on twice and are still raised.
 */
import { getLogger } from '../utils/logger';
import { UNRECOVERABLE_ZERO_ROUNDS } from '../config';
import { projectSlugFromBranch } from '../utils/branch-naming';
import { buildDispatchPlan, onBranchNotMerged } from '../agents/developers/dispatch-plan';
import { abandonedBranches, selectPendingAssignments, ABANDON_AFTER_UNMERGED_ROUNDS } from './assignment-policy';
import { selectTriageBugs } from './triage-selection';
import type { ProjectStateType } from './state';
import type { Bug } from '../agents/_shared/base-schemas';

export interface UnrecoverableVerdict {
    unrecoverable: boolean;
    reason?: string;
}

type Rule = (state: ProjectStateType, openBugs: Bug[]) => string | null;

const preview = (ids: string[]): string => ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, … ${ids.length - 5} more` : '');

/** Rule 1: the last N dispatch rounds merged no PR and deferred no work. */
const zeroProgress: Rule = (state) => {
    const rounds = state.dispatchRounds ?? [];
    if (UNRECOVERABLE_ZERO_ROUNDS <= 0 || rounds.length < UNRECOVERABLE_ZERO_ROUNDS) return null;
    const tail = rounds.slice(-UNRECOVERABLE_ZERO_ROUNDS);
    if (!tail.every(r => r.merged === 0 && !(r.deferred > 0))) return null;
    const unmerged = tail.reduce((n, r) => n + r.fileChanges, 0);
    return `${UNRECOVERABLE_ZERO_ROUNDS} consecutive dispatch rounds merged no PR (${unmerged} unmerged file change(s) do not count as progress)`;
};

/** Rule 2: abandoned branches, and nothing pending that does not wait for one of them. */
const abandonedWork: Rule = (state) => {
    const abandoned = abandonedBranches(state.pullRequests ?? []);
    if (abandoned.length === 0) return null;
    const completed = state.completedAssignmentIds ?? [];
    const pending = selectPendingAssignments(state.assignments ?? [], completed);
    const plan = buildDispatchPlan(pending, { projectSlug: projectSlugFromBranch(state.systemBranch ?? ''), preSatisfied: completed });
    const stuck = new Set(abandoned.map(b => b.branchName));
    for (const b of abandoned) for (const dependent of onBranchNotMerged(plan, b.branchName, 'dependents').skip) stuck.add(dependent);
    if (plan.branchOrder.length === 0 || plan.branchOrder.some(b => !stuck.has(b))) return null;
    return `${preview(abandoned.map(b => `${b.branchName} (${b.rounds} rounds, last ${b.lastStatus})`))} stayed unmerged for `
        + `${ABANDON_AFTER_UNMERGED_ROUNDS}+ consecutive rounds (abandoned), and every pending assignment is on it or waits for it`;
};

/** Rule 3: past development with no file changes and no merged PR at all. */
const sourceless: Rule = (state) => {
    const pastDev = ['qa', 'bugfix-triage', 'devops', 'e2e', 'acceptance-gate', 'finalize'].includes(state.phase);
    const merged = (state.pullRequests ?? []).some(pr => pr.status === 'merged');
    return pastDev && (state.fileChanges ?? []).length === 0 && !merged
        ? 'Workspace appears sourceless after development — no file changes and no merged PRs'
        : null;
};

/** Rule 4: the bug-fix round between the last two triage rounds changed none of the open bugs. */
const repeatedBugSet: Rule = (state, openBugs) => {
    const rounds = state.triageRounds ?? [];
    const previous = rounds[rounds.length - 1];
    if (!previous || previous.bugIds.length === 0 || openBugs.length !== previous.bugIds.length) return null;
    const dispatches = state.dispatchRounds ?? [];
    if ((dispatches[dispatches.length - 1]?.deferred ?? 0) > 0) return null;   // the fix may not have run yet
    const before = new Set(previous.bugIds);
    if (!openBugs.every(b => before.has(b.id))) return null;
    return `The same ${openBugs.length} open bug(s) survived a whole bug-fix round (iteration ${previous.iteration}): ${preview(openBugs.map(b => b.id))}`;
};

/** Rule 5: open bugs of any kind that assignments which ran have worked on twice. */
const stuckBugs: Rule = (state, openBugs) => {
    const attempts = state.bugAttempts ?? {};
    const stuck = openBugs.filter(b => (attempts[b.id] ?? 0) >= 2);
    if (stuck.length < 3) return null;
    return `${stuck.length} open bug(s) were worked on 2+ times and are still raised: ${preview(stuck.map(b => b.id))}`;
};

const RULES: Rule[] = [zeroProgress, abandonedWork, sourceless, repeatedBugSet, stuckBugs];

/**
 * A run is unrecoverable when no remaining pipeline work can plausibly change
 * the outcome (see the module comment for the rules).
 */
export function detectUnrecoverable(state: ProjectStateType): UnrecoverableVerdict {
    const openBugs = selectTriageBugs(state).bugs;
    for (const rule of RULES) {
        const reason = rule(state, openBugs);
        if (reason) return { unrecoverable: true, reason };
    }
    return { unrecoverable: false };
}

/**
 * Small shared helper: check if the run should halt early due to
 * unrecoverability under `RUN_FAIL_POLICY='halt'`. Returns a partial state
 * update that skips the node, or null if the node should proceed normally.
 */
export function haltIfUnrecoverable(
    state: ProjectStateType,
    nodeLog: ReturnType<typeof getLogger>,
    failPolicy: string,
): Partial<ProjectStateType> | null {
    if (failPolicy !== 'halt') return null;
    if (!state.unrecoverable?.flag) return null;

    nodeLog.warn(`Run is unrecoverable (${state.unrecoverable.reason}) and RUN_FAIL_POLICY=halt — skipping to finalize`);
    return {};
}
