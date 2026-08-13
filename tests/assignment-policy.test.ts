/**
 * Assignment Policy — Unit Tests
 *
 * Exercises: selectPendingAssignments, completedIdsFromPullRequests,
 * namespaceBugfixAssignments, dedupeBugs (all pure, no LLM, no git).
 *
 * Also tests topoSort with preSatisfied from dispatcher.ts.
 */
import {
    selectPendingAssignments,
    completedIdsFromPullRequests,
    namespaceBugfixAssignments,
    dedupeBugs,
} from '../src/conductor/assignment-policy';
import { topoSort } from '../src/agents/developers/dispatcher';
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
    it('resolves dependency on pre-satisfied id without cyclic fallback', () => {
        const assignments = [
            makeAssignment({ id: 'A', dependsOn: ['X'] }),
        ];
        // Without preSatisfied, 'X' is never completed → cyclic fallback
        const withoutPre = topoSort(assignments);
        expect(withoutPre).toHaveLength(1);
        // The assignment is in the fallback layer

        // With preSatisfied={X}, the dependency is met → single layer, no fallback
        const withPre = topoSort(assignments, new Set(['X']));
        expect(withPre).toHaveLength(1);
        expect(withPre[0]).toHaveLength(1);
        expect(withPre[0][0].id).toBe('A');
    });

    it('correctly layers assignments with mixed pre-satisfied and batch deps', () => {
        const assignments = [
            makeAssignment({ id: 'A', dependsOn: ['X'] }),           // X is pre-satisfied
            makeAssignment({ id: 'B', dependsOn: ['A'] }),           // depends on A in batch
            makeAssignment({ id: 'C', dependsOn: [] }),               // no deps
        ];
        const layers = topoSort(assignments, new Set(['X']));

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
        const layers = topoSort(assignments, new Set());
        expect(layers[0].map(a => a.id)).toEqual(['A']);
        expect(layers[1].map(a => a.id)).toEqual(['B']);
    });
});
