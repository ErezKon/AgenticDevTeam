/**
 * Bug-fix triage input (Plan 30-05): only real, actionable bugs reach the Team Leader.
 *
 * claudeopus5's first triage handed the Team Leader 63 bugs, every one of them a
 * pipeline artifact: 35 "story untested" and 9 "implemented-untested" criteria
 * because the test runner had failed, 16 criteria of one blocked PR, and a smoke
 * test that failed because the build had no artifacts. The Team Leader then
 * invented merge conflicts and file paths. `selectTriageBugs()`:
 *  - reads only what the latest evaluation raised (the bugs after the previous
 *    triage round's cursor): a bug that is no longer reported is not triaged
 *    again, and a regression is;
 *  - drops story-scoped bugs while the story's assigned work has not merged —
 *    undelivered work is not a bug, and its pending assignments are dispatched again;
 *  - turns each undelivered branch that needs a fix (a blocked or open PR, or
 *    failed critical gates) into exactly one `PR-BLOCKED-<branch>` bug with its
 *    real blockers — none for an abandoned branch, which is not dispatched again;
 *  - lets a root cause absorb its derivatives.
 */
import { blockedPrBug } from './review-policy';
import { abandonedBranches, dedupeBugs, storyIdsOfAssignments } from './assignment-policy';
import type { ProjectStateType } from './state';
import type { Bug, PullRequest } from '../agents/_shared/base-schemas';

export type TriageInput = Pick<ProjectStateType,
    'bugs' | 'triageRounds' | 'assignments' | 'completedAssignmentIds' | 'pullRequests' | 'userStories'>;

export interface TriageSelection {
    /** The bugs handed to the Team Leader. */
    bugs: Bug[];
    /** The bugs left out and why — logged, and summarised in the transcript. */
    dropped: Array<{ id: string; reason: string }>;
}

const UNDELIVERED = 'undelivered: the story has no merged work yet, and its pending assignments are dispatched again';
const ABANDONED = 'abandoned branch: unmerged in consecutive rounds, so it is not dispatched again';

/** Bugs raised since the previous triage round, i.e. what the latest evaluation reported. */
export function currentBugs(state: Pick<ProjectStateType, 'bugs' | 'triageRounds'>): Bug[] {
    const rounds = state.triageRounds ?? [];
    return (state.bugs ?? []).slice(rounds.length > 0 ? rounds[rounds.length - 1].bugCursor : 0);
}

const STORY_SCOPED_ID_RE = /^(?:AC|QA-PLAN-GAP)-(.+)-\d+$|^QA-story-untested-(.+)$/;

/** The story a bug is about: `storyId`, or the one its id embeds (`AC-US-001-0`, `QA-PLAN-GAP-US-001-0`, `QA-story-untested-US-001`). */
export function bugStoryId(bug: Bug): string | undefined {
    if (bug.storyId) return bug.storyId;
    const m = STORY_SCOPED_ID_RE.exec(bug.id);
    return m ? (m[1] ?? m[2]) : undefined;
}

/** The criterion status an AC-coverage bug reports (`Status "…"`, ac-coverage-gate.ts). */
function acStatus(bug: Bug): string | undefined {
    return bug.id.startsWith('AC-') ? /Status "([a-z-]+)"/.exec(bug.actualBehavior ?? '')?.[1] : undefined;
}

/** A PR record's real blockers: the merge stage's, else its failing gate. */
export function prBlockers(pr: PullRequest): string[] {
    if (pr.blockers?.length) return pr.blockers;
    if (pr.failedGate) return [`${pr.failedGate.step} failed (\`${pr.failedGate.command}\`)`];
    return [`${pr.status} (no blockers recorded)`];
}

/**
 * The latest PR record of every branch that needs a fix to merge: a blocked or
 * open PR, or a branch whose critical gates failed before a PR (`failedGate`). A
 * deferred branch resumes on its own; a PR-less placeholder without a gate
 * failure (no commits, push rejected) re-runs its pending assignments.
 */
export function branchesNeedingFix(prs: PullRequest[]): PullRequest[] {
    const latest = new Map(prs.map(pr => [pr.branchName, pr] as const));
    return [...latest.values()].filter(pr => pr.status === 'blocked' || pr.status === 'open'
        || (pr.status === 'closed' && !!pr.failedGate));
}

interface Absorption {
    absorber: (bug: Bug) => boolean;
    derivative: (bug: Bug) => boolean;
    reason: string;
}

const isPrBug = (b: Bug): boolean => b.id.startsWith('PR-BLOCKED-');
const isGateBug = (step: string) => (b: Bug): boolean => new RegExp(`^GATE-[a-z]+-${step}(?:-|$)`).test(b.id);

/** The acceptance gate restates a specific failure as `ACCEPT-<criterion>`; with the specific bug open the restatement adds nothing. */
const restates = (acceptId: string, specific: (b: Bug) => boolean): Absorption =>
    ({ absorber: specific, derivative: b => b.id === acceptId, reason: `restates a more specific open bug (${acceptId})` });

/** A root cause absorbs its derivatives: while it is open they add nothing triage can act on. */
const ABSORPTIONS: Absorption[] = [
    {
        absorber: b => b.id === 'QA-runner-error',
        derivative: b => b.id.startsWith('QA-story-untested-') || acStatus(b) === 'implemented-untested',
        reason: 'absorbed by QA-runner-error: the test runner failed, so this was not measured',
    },
    {
        absorber: b => b.id.startsWith('PRODUCT-ARTIFACTS'),
        derivative: b => b.id === 'PRODUCT-SMOKE',
        reason: 'absorbed by PRODUCT-ARTIFACTS: the build produced nothing to serve',
    },
    { absorber: isPrBug, derivative: b => acStatus(b) === 'blocked', reason: 'absorbed by the blocked PR: one bug per blocked PR' },
    restates('ACCEPT-BUILD', b => isGateBug('build')(b) || isGateBug('typecheck')(b)),
    restates('ACCEPT-TESTS', b => b.id === 'QA-runner-error' || isGateBug('test')(b)),
    restates('ACCEPT-ARTIFACTS', b => b.id.startsWith('PRODUCT-ARTIFACTS')),
    restates('ACCEPT-RESOLVE', b => b.id.startsWith('PRODUCT-RESOLVE')),
    restates('ACCEPT-SMOKE', b => b.id === 'PRODUCT-SMOKE' || b.id.startsWith('PRODUCT-ARTIFACTS')),
    restates('ACCEPT-AC_COVERAGE', b => b.id.startsWith('AC-') || isPrBug(b)),
];

/** Why `bug` adds nothing while `present` holds its root cause, or null. */
function absorbedBy(bug: Bug, present: Bug[]): string | null {
    const rule = ABSORPTIONS.find(r => r.derivative(bug) && present.some(other => other !== bug && r.absorber(other)));
    return rule?.reason ?? null;
}

/** The critical/major bugs of the latest evaluation that the Team Leader can act on (see the module comment). */
export function selectTriageBugs(state: TriageInput): TriageSelection {
    const dropped: TriageSelection['dropped'] = [];
    const keep = (bug: Bug, reason: string | null): boolean => {
        if (reason) dropped.push({ id: bug.id, reason });
        return !reason;
    };
    const assignments = state.assignments ?? [];
    const assigned = new Set(storyIdsOfAssignments(assignments, assignments.map(a => a.id)));
    const delivered = new Set(storyIdsOfAssignments(assignments, state.completedAssignmentIds ?? []));
    const everyStoryAssigned = (state.userStories ?? []).every(s => assigned.has(s.id));
    const prs = state.pullRequests ?? [];
    const abandoned = new Set(abandonedBranches(prs).map(b => b.branchName));

    const raised = dedupeBugs(currentBugs(state)).filter(b => b.severity === 'critical' || b.severity === 'major');
    const raisedIds = new Set(raised.map(b => b.id));
    const branchBugs = branchesNeedingFix(prs)
        .map(pr => blockedPrBug(pr.branchName, pr.prNumber, prBlockers(pr)))
        .filter(b => !raisedIds.has(b.id));

    const undeliveredReason = (bug: Bug): string | null => {
        const story = bugStoryId(bug);
        if (story && assigned.has(story) && !delivered.has(story)) return UNDELIVERED;
        // SCOPE lists the stories without merged work; it is a gap only for a story no assignment covers
        if (bug.id === 'ACCEPT-SCOPE' && everyStoryAssigned) return UNDELIVERED;
        if (isPrBug(bug) && abandoned.has(bug.id.slice('PR-BLOCKED-'.length))) return ABANDONED;
        return null;
    };
    const candidates = [...raised, ...branchBugs].filter(b => keep(b, undeliveredReason(b)));
    const bugs = candidates.filter(b => keep(b, absorbedBy(b, candidates)));
    return { bugs, dropped };
}

/** `28 × <reason>; 16 × <reason>` — the dropped bugs grouped by reason, for the log and the transcript. */
export function summariseDropped(dropped: TriageSelection['dropped']): string {
    const counts = new Map<string, number>();
    for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
    return [...counts].map(([reason, n]) => `${n} × ${reason}`).join('; ');
}
