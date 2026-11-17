/**
 * Runaway detection — `detectUnrecoverable` (moved from acceptance-gate.ts and
 * rewritten in Plan 30-05).
 *
 * claudeopus5 repeated the same failing round three times without tripping a
 * rule: unmerged file changes counted as progress, the blocked PR was not a
 * signal, and repeated attempts were counted only for ACCEPT-/GATE- bugs.
 */
import { detectUnrecoverable } from '../src/conductor/unrecoverable';
import { makeState } from './helpers/state-factory';
import type { Assignment, Bug, PullRequest } from '../src/agents/_shared/base-schemas';
import type { DispatchRound } from '../src/conductor/gate-types';

const SYSTEM = 'project/app';
const US027 = 'app/feature/us-027-storage';

const roundOf = (fields: Partial<DispatchRound>): DispatchRound =>
    ({ fileChanges: 0, merged: 0, executed: 0, deferred: 0, completed: 0, ...fields });

function bug(id: string): Bug {
    return { id, title: id, severity: 'critical', reportedBy: 'test', stepsToReproduce: id, expectedBehavior: '', actualBehavior: id, suspectedArea: '' };
}

function assignment(id: string, branchName: string, dependsOn: string[] = []): Assignment {
    return {
        id, storyId: `US-${id}`, additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [], devAgentId: 'senior-frontend',
        rank: 'senior', priority: 'high', complexity: 'moderate', estimate: '2h', description: `Implement ${id}`,
        dependsOn, branchName, taskType: 'feature', moduleIds: [],
    };
}

function pr(id: string, branchName: string, status: PullRequest['status'], assignmentIds: string[] = []): PullRequest {
    return {
        id, prNumber: 2, prUrl: '', title: id, description: '', branchName, authorAgentId: 'junior-angular',
        reviewerAgentIds: [], reviews: [], status, assignmentIds, taskType: 'feature',
    };
}

/** Past development, with merged work, so the sourceless rule stays quiet. */
const developed = { phase: 'qa' as any, systemBranch: SYSTEM, fileChanges: [{ path: 'src/a.ts', action: 'created' as const, summary: 'a', storyId: 'US-1', agentId: 'dev' }] };

describe('detectUnrecoverable — zero progress (Plan 30-05)', () => {
    it('returns false for a normal state', () => {
        expect(detectUnrecoverable(makeState()).unrecoverable).toBe(false);
    });

    it('rounds that merged nothing are a stall even when they changed files (claudeopus5)', () => {
        const state = makeState({ dispatchRounds: [roundOf({ fileChanges: 14, executed: 6 }), roundOf({ fileChanges: 3, executed: 1 })] });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('consecutive dispatch rounds merged no PR');
        expect(reason).toContain('17 unmerged file change(s)');
    });

    it('does not trigger on a single zero-merge round', () => {
        expect(detectUnrecoverable(makeState({ dispatchRounds: [roundOf({})] })).unrecoverable).toBe(false);
    });

    it('a round that merged a PR resets the count', () => {
        expect(detectUnrecoverable(makeState({ dispatchRounds: [roundOf({}), roundOf({ merged: 1 })] })).unrecoverable).toBe(false);
    });

    it('a round that deferred work to the next one is in flight, not stalled', () => {
        expect(detectUnrecoverable(makeState({ dispatchRounds: [roundOf({}), roundOf({ deferred: 2 })] })).unrecoverable).toBe(false);
    });

    it('detects a sourceless workspace after development', () => {
        const { unrecoverable, reason } = detectUnrecoverable(makeState({ phase: 'qa' as any }));
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('sourceless');
    });
});

describe('detectUnrecoverable — abandoned branches (Plan 30-05)', () => {
    const blockedTwice = [pr('PR-2', US027, 'blocked', ['A1']), pr('PR-2', US027, 'blocked', ['A1', 'BUGFIX-1-A1'])];

    it('a branch unmerged in two consecutive rounds, with every pending assignment on it or waiting for it', () => {
        const state = makeState({
            ...developed,
            assignments: [assignment('A1', US027), assignment('BUGFIX-1-A1', US027), assignment('B1', 'app/feature/b', ['A1'])],
            pullRequests: blockedTwice,
        });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain(`${US027} (2 rounds, last blocked)`);
        expect(reason).toContain('abandoned');
    });

    it('not while other pending work can still run', () => {
        const state = makeState({
            ...developed,
            assignments: [assignment('A1', US027), assignment('C1', 'app/feature/c')],
            pullRequests: blockedTwice,
        });
        expect(detectUnrecoverable(state).unrecoverable).toBe(false);
    });

    it('a deferred round in between is progress, not a failed attempt', () => {
        const state = makeState({
            ...developed,
            assignments: [assignment('A1', US027)],
            pullRequests: [pr('PR-2', US027, 'blocked', ['A1']), pr('PR-DEFERRED', US027, 'deferred', ['A1']), pr('PR-2', US027, 'blocked', ['A1'])],
        });
        expect(detectUnrecoverable(state).unrecoverable).toBe(false);
    });
});

describe('detectUnrecoverable — the same open bugs (Plan 30-05)', () => {
    const previous = { iteration: 1, bugCursor: 2, bugIds: ['QA-runner-error', 'PRODUCT-ARTIFACTS-root'] };

    it('two consecutive triage rounds that see the same open bugs', () => {
        const state = makeState({
            ...developed,
            bugs: [bug('QA-runner-error'), bug('PRODUCT-ARTIFACTS-root'), bug('PRODUCT-ARTIFACTS-root'), bug('QA-runner-error')],
            triageRounds: [previous],
            dispatchRounds: [roundOf({ merged: 1, executed: 2 })],
        });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('The same 2 open bug(s) survived a whole bug-fix round');
    });

    it('not when one of them was fixed, or when the last round deferred work', () => {
        const fixedOne = makeState({ ...developed, bugs: [bug('QA-runner-error'), bug('PRODUCT-ARTIFACTS-root'), bug('QA-runner-error')], triageRounds: [previous] });
        const deferred = makeState({
            ...developed,
            bugs: [bug('QA-runner-error'), bug('PRODUCT-ARTIFACTS-root'), bug('PRODUCT-ARTIFACTS-root'), bug('QA-runner-error')],
            triageRounds: [previous],
            dispatchRounds: [roundOf({ merged: 1, deferred: 1 })],
        });
        expect(detectUnrecoverable(fixedOne).unrecoverable).toBe(false);
        expect(detectUnrecoverable(deferred).unrecoverable).toBe(false);
    });
});

describe('detectUnrecoverable — bugs worked on twice (Plan 30-05)', () => {
    const ids = ['QA-runner-error', 'PRODUCT-ARTIFACTS-root', 'PR-BLOCKED-app/feature/x'];

    it('counts every kind of bug, not only ACCEPT- and GATE- ids', () => {
        const state = makeState({
            ...developed,
            bugs: ids.map(bug),
            bugAttempts: Object.fromEntries(ids.map(id => [id, 2])),
        });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('3 open bug(s) were worked on 2+ times');
    });

    it('a bug the latest evaluation no longer raised is not open', () => {
        const state = makeState({
            ...developed,
            bugs: ids.map(bug),
            triageRounds: [{ iteration: 2, bugCursor: 3, bugIds: [] }],
            bugAttempts: Object.fromEntries(ids.map(id => [id, 2])),
        });
        expect(detectUnrecoverable(state).unrecoverable).toBe(false);
    });

    it('not before the bugs were worked on twice', () => {
        const state = makeState({ ...developed, bugs: ids.map(bug), bugAttempts: Object.fromEntries(ids.map(id => [id, 1])) });
        expect(detectUnrecoverable(state).unrecoverable).toBe(false);
    });
});
