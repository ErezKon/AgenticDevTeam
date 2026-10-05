/**
 * Assignment Policy — Unit Tests
 *
 * Exercises: selectPendingAssignments, completedIdsFromPullRequests,
 * namespaceBugfixAssignments, dedupeBugs (all pure, no LLM, no git).
 *
 * Also tests topoSort with preSatisfied from dispatch-plan.ts.
 */
import {
    selectPendingAssignments,
    storyIdsOfAssignments,
    completedIdsFromPullRequests,
    namespaceBugfixAssignments,
    dedupeBugs,
    abandonedBranches,
    newlyExecutedIds,
    dispatchRoundOf,
    bugAttemptsAfterRound,
    resolveBugIds,
} from '../src/conductor/assignment-policy';
import { topoSort } from '../src/agents/developers/dispatch-plan';
import type { Assignment, Bug, PullRequest } from '../src/agents/_shared/base-schemas';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAssignment(overrides: Partial<Assignment> & { id: string }): Assignment {
    return {
        storyId: 'US-001',
        additionalStoryIds: [],
        taskIds: ['TASK-001'],
        acIndexes: [],
        devAgentId: 'junior-react',
        rank: 'junior',
        priority: 'medium',
        complexity: 'moderate',
        estimate: '2h',
        description: 'Build something',
        dependsOn: [],
        taskType: 'feature',
        moduleIds: [],
        ...overrides,
    };
}

function makePR(overrides: Partial<PullRequest> & { assignmentIds: string[]; status: PullRequest['status'] }): PullRequest {
    return {
        id: 'PR-001',
        prNumber: 1,
        prUrl: 'https://github.com/test/repo/pull/1',
        title: 'Test PR',
        description: 'Test',
        branchName: 'feature/test',
        authorAgentId: 'junior-react',
        reviewerAgentIds: [],
        reviews: [],
        taskType: 'feature',
        ...overrides,
    };
}

function makeBug(overrides: Partial<Bug> & { id: string }): Bug {
    return {
        title: 'Something broke',
        severity: 'major',
        stepsToReproduce: 'Run the thing',
        expectedBehavior: 'It should work',
        actualBehavior: 'It does not',
        suspectedArea: 'src/thing.ts',
        reportedBy: 'qa-unit',
        ...overrides,
    };
}

// ─── selectPendingAssignments ────────────────────────────────────────────────

describe('selectPendingAssignments', () => {
    it('returns the 3 remaining assignments when 2 of 5 are completed', () => {
        const assignments = [
            makeAssignment({ id: 'A-001' }),
            makeAssignment({ id: 'A-002' }),
            makeAssignment({ id: 'A-003' }),
            makeAssignment({ id: 'A-004' }),
            makeAssignment({ id: 'A-005' }),
        ];
        const completedIds = ['A-002', 'A-004'];
        const result = selectPendingAssignments(assignments, completedIds);

        expect(result).toHaveLength(3);
        expect(result.map(a => a.id)).toEqual(['A-001', 'A-003', 'A-005']);
    });

    it('de-duplicates by id, keeping the first occurrence', () => {
        const assignments = [
            makeAssignment({ id: 'A-001', description: 'first' }),
            makeAssignment({ id: 'A-002' }),
            makeAssignment({ id: 'A-001', description: 'duplicate' }),
        ];
        const result = selectPendingAssignments(assignments, []);

        expect(result).toHaveLength(2);
        expect(result[0].description).toBe('first');
    });

    it('returns empty when all are completed', () => {
        const assignments = [
            makeAssignment({ id: 'A-001' }),
            makeAssignment({ id: 'A-002' }),
        ];
        const result = selectPendingAssignments(assignments, ['A-001', 'A-002']);
        expect(result).toHaveLength(0);
    });

    it('preserves order of remaining assignments', () => {
        const assignments = [
            makeAssignment({ id: 'A-003' }),
            makeAssignment({ id: 'A-001' }),
            makeAssignment({ id: 'A-002' }),
        ];
        const result = selectPendingAssignments(assignments, ['A-001']);
        expect(result.map(a => a.id)).toEqual(['A-003', 'A-002']);
    });
});

// ─── storyIdsOfAssignments (Plan 30-03) ──────────────────────────────────────

describe('storyIdsOfAssignments', () => {
    it('maps completed assignment ids to the stories they deliver, including additionalStoryIds', () => {
        const assignments = [
            makeAssignment({ id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: ['US-002'] }),
            makeAssignment({ id: 'ASSIGN-002', storyId: 'US-003' }),
            makeAssignment({ id: 'ASSIGN-003', storyId: 'US-001' }),
            makeAssignment({ id: 'ASSIGN-004', storyId: '' }),
        ];
        expect(storyIdsOfAssignments(assignments, ['ASSIGN-001', 'ASSIGN-003', 'ASSIGN-004'])).toEqual(['US-001', 'US-002']);
        expect(storyIdsOfAssignments(assignments, [])).toEqual([]);
    });
});

// ─── completedIdsFromPullRequests ────────────────────────────────────────────

describe('completedIdsFromPullRequests', () => {
    it('includes only merged, excludes approved/open/closed/blocked (Sub-Plan 07)', () => {
        const prs = [
            makePR({ assignmentIds: ['A-001', 'A-002'], status: 'merged' }),
            makePR({ assignmentIds: ['A-003'], status: 'approved' }),
            makePR({ assignmentIds: ['A-004'], status: 'open' }),
            makePR({ assignmentIds: ['A-005'], status: 'closed' }),
            makePR({ assignmentIds: ['A-006'], status: 'escalated_open' }),
            makePR({ assignmentIds: ['A-007'], status: 'blocked' }),
        ];
        const result = completedIdsFromPullRequests(prs);

        expect(result).toContain('A-001');
        expect(result).toContain('A-002');
        expect(result).not.toContain('A-003');
        expect(result).not.toContain('A-004');
        expect(result).not.toContain('A-005');
        expect(result).not.toContain('A-006');
        expect(result).not.toContain('A-007');
    });

    it('returns empty for no PRs', () => {
        expect(completedIdsFromPullRequests([])).toEqual([]);
    });
});

// ─── namespaceBugfixAssignments ──────────────────────────────────────────────

describe('namespaceBugfixAssignments', () => {
    it('prefixes ids with BUGFIX-<n>-', () => {
        const assignments = [
            makeAssignment({ id: 'ASSIGN-001' }),
            makeAssignment({ id: 'ASSIGN-002' }),
        ];
        const result = namespaceBugfixAssignments(assignments, 2);

        expect(result[0].id).toBe('BUGFIX-2-ASSIGN-001');
        expect(result[1].id).toBe('BUGFIX-2-ASSIGN-002');
    });

    it('rewrites intra-batch dependsOn, leaves external untouched', () => {
        const assignments = [
            makeAssignment({ id: 'ASSIGN-001', dependsOn: [] }),
            makeAssignment({ id: 'ASSIGN-002', dependsOn: ['ASSIGN-001', 'EXTERNAL-001'] }),
        ];
        const result = namespaceBugfixAssignments(assignments, 1);

        // ASSIGN-001 is in the batch, so it gets rewritten
        expect(result[1].dependsOn).toContain('BUGFIX-1-ASSIGN-001');
        // EXTERNAL-001 is not in the batch, so it stays as-is
        expect(result[1].dependsOn).toContain('EXTERNAL-001');
        expect(result[1].dependsOn).not.toContain('ASSIGN-001');
    });

    it('does not mutate the original assignments', () => {
        const original = makeAssignment({ id: 'A-001', dependsOn: ['X'] });
        const assignments = [original];
        namespaceBugfixAssignments(assignments, 1);

        expect(original.id).toBe('A-001');
        expect(original.dependsOn).toEqual(['X']);
    });
});

// ─── dedupeBugs ──────────────────────────────────────────────────────────────

describe('dedupeBugs', () => {
    it('keeps the first occurrence of each bug id', () => {
        const bugs = [
            makeBug({ id: 'BUG-001', title: 'first' }),
            makeBug({ id: 'BUG-002' }),
            makeBug({ id: 'BUG-001', title: 'duplicate' }),
            makeBug({ id: 'BUG-003' }),
            makeBug({ id: 'BUG-002', title: 'another dup' }),
        ];
        const result = dedupeBugs(bugs);

        expect(result).toHaveLength(3);
        expect(result.map(b => b.id)).toEqual(['BUG-001', 'BUG-002', 'BUG-003']);
        expect(result[0].title).toBe('first');
    });

    it('returns empty for empty input', () => {
        expect(dedupeBugs([])).toEqual([]);
    });
});

// ─── topoSort with preSatisfied ──────────────────────────────────────────────

describe('topoSort with preSatisfied', () => {
    it('resolves dependency on pre-satisfied id without a dangling-id warning', () => {
        const assignments = [
            makeAssignment({ id: 'A', dependsOn: ['X'] }),
        ];
        // Without preSatisfied, 'X' is unknown → treated as satisfied, with a warning
        const withoutPre = topoSort(assignments);
        expect(withoutPre.layers).toHaveLength(1);
        expect(withoutPre.warnings).toEqual([expect.stringContaining('"X"')]);

        // With preSatisfied={X}, the dependency is met → single layer, no warning
        const withPre = topoSort(assignments, new Set(['X']));
        expect(withPre.layers).toHaveLength(1);
        expect(withPre.layers[0]).toHaveLength(1);
        expect(withPre.layers[0][0].id).toBe('A');
        expect(withPre.warnings).toEqual([]);
        expect(withPre.brokenEdges).toEqual([]);
    });

    it('correctly layers assignments with mixed pre-satisfied and batch deps', () => {
        const assignments = [
            makeAssignment({ id: 'A', dependsOn: ['X'] }),           // X is pre-satisfied
            makeAssignment({ id: 'B', dependsOn: ['A'] }),           // depends on A in batch
            makeAssignment({ id: 'C', dependsOn: [] }),               // no deps
        ];
        const { layers } = topoSort(assignments, new Set(['X']));

        // Layer 1: A (X satisfied) and C (no deps)
        expect(layers[0].map(a => a.id).sort()).toEqual(['A', 'C']);
        // Layer 2: B (depends on A, now completed)
        expect(layers[1].map(a => a.id)).toEqual(['B']);
    });

    it('handles empty preSatisfied like original behavior', () => {
        const assignments = [
            makeAssignment({ id: 'A', dependsOn: [] }),
            makeAssignment({ id: 'B', dependsOn: ['A'] }),
        ];
        const { layers } = topoSort(assignments, new Set());
        expect(layers[0].map(a => a.id)).toEqual(['A']);
        expect(layers[1].map(a => a.id)).toEqual(['B']);
    });
});

// ─── PR history and bug attempts (Plan 30-05) ───────────────────────────────

describe('abandonedBranches (Plan 30-05)', () => {
    const on = (branchName: string, status: PullRequest['status']) => makePR({ branchName, status, assignmentIds: ['A'] });

    it('a branch whose last two records are failed attempts is abandoned', () => {
        const prs = [on('b/x', 'blocked'), on('b/y', 'merged'), on('b/x', 'closed')];
        expect(abandonedBranches(prs)).toEqual([{ branchName: 'b/x', rounds: 2, lastStatus: 'closed' }]);
    });

    it('a merged, deferred or pr-creation-failed record ends the run of failures', () => {
        for (const status of ['merged', 'deferred', 'pr-creation-failed'] as const) {
            expect(abandonedBranches([on('b/x', 'blocked'), on('b/x', status), on('b/x', 'blocked')])).toEqual([]);
        }
        expect(abandonedBranches([on('b/x', 'blocked')])).toEqual([]);
    });
});

describe('dispatch rounds and bug attempts (Plan 30-05)', () => {
    const before = [makePR({ id: 'PR-2', branchName: 'b/x', status: 'blocked', assignmentIds: ['A1', 'A2'] })];
    const round = [
        // the resumed branch re-claims A1 and A2 and ran the fix
        makePR({ id: 'PR-2', branchName: 'b/x', status: 'blocked', assignmentIds: ['A1', 'A2', 'BUGFIX-1-F1'] }),
        makePR({ id: 'PR-SKIPPED-b/y', prNumber: 0, branchName: 'b/y', status: 'closed', assignmentIds: ['B1'] }),
        makePR({ id: 'PR-3', branchName: 'b/z', status: 'merged', assignmentIds: ['C1'] }),
    ];

    it('newlyExecutedIds: only assignments no earlier record claimed', () => {
        expect(newlyExecutedIds(before, round)).toEqual(['BUGFIX-1-F1', 'B1', 'C1']);
    });

    it('dispatchRoundOf counts merged PRs (never a skipped placeholder), first executions and deferred work', () => {
        expect(dispatchRoundOf(before, { pullRequests: round, fileChanges: 9, deferredAssignmentIds: ['D1'], completed: 1 }))
            .toEqual({ fileChanges: 9, merged: 1, executed: 3, deferred: 1, completed: 1 });
    });

    it('bugAttemptsAfterRound counts a bug once per round, and only when an assignment working on it ran', () => {
        const assignments = [
            makeAssignment({ id: 'BUGFIX-1-F1', bugIds: ['PR-BLOCKED-b/x', 'QA-runner-error'] }),
            makeAssignment({ id: 'BUGFIX-1-F2', bugIds: ['QA-runner-error'] }),
            makeAssignment({ id: 'BUGFIX-1-F3', bugIds: ['PRODUCT-ARTIFACTS-root'] }),
        ];
        const attempts = bugAttemptsAfterRound(assignments, ['BUGFIX-1-F1', 'BUGFIX-1-F2'], { 'QA-runner-error': 1 });
        // F3 never ran (e.g. its branch was skipped), so PRODUCT-ARTIFACTS-root is not counted
        expect(attempts).toEqual({ 'PR-BLOCKED-b/x': 1, 'QA-runner-error': 2 });
    });

    it('resolveBugIds: the listed open bugs, else the open bugs the description names as whole ids', () => {
        const open = ['AC-US-001-1', 'AC-US-001-10', 'QA-runner-error'];
        expect(resolveBugIds(makeAssignment({ id: 'F', bugIds: ['QA-runner-error', 'GONE-1'] }), open)).toEqual(['QA-runner-error']);
        expect(resolveBugIds(makeAssignment({ id: 'F', description: 'Fix AC-US-001-10 and the runner (QA-runner-error).' }), open))
            .toEqual(['AC-US-001-10', 'QA-runner-error']);
        expect(resolveBugIds(makeAssignment({ id: 'F', description: 'Polish the UI' }), open)).toEqual([]);
    });
});
