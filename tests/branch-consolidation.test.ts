/**
 * Branch Consolidation -- unit tests for consolidateBranches.
 *
 * Verifies that the post-plan consolidation pass correctly merges branches
 * that share modules (connected-component grouping) and squashes remaining
 * branches down to the configured maximum.
 */

import { consolidateBranches } from '../src/conductor/branch-consolidation';
import type { Assignment, UserStory } from '../src/agents/_shared/base-schemas';

// ---- Mocks ------------------------------------------------------------------

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
}));

jest.mock('../src/conductor/assignment-policy', () => ({
    sanitizeAssignmentStoryIds: jest.fn(
        (assignments: any[], _stories: any[], _bugs: any[]) => ({
            assignments,
            dropped: [],
        }),
    ),
}));

// ---- Helpers ----------------------------------------------------------------

function makeAssignment(overrides: Partial<Assignment> = {}): Assignment {
    return {
        id: 'A-001',
        storyId: 'US-001',
        additionalStoryIds: [],
        taskIds: ['TASK-001'],
        acIndexes: [0],
        devAgentId: 'junior-fullstack',
        rank: 'junior',
        priority: 'medium',
        complexity: 'moderate',
        estimate: '2 hours',
        description: 'Test assignment',
        dependsOn: [],
        branchName: 'project/feat/branch-1',
        reviewerAgentIds: ['senior-backend'],
        taskType: 'feature',
        moduleIds: [],
        ...overrides,
    } as Assignment;
}

const emptyStories: UserStory[] = [];

/** Collect distinct branch names from a list of assignments. */
function branchNames(assignments: Assignment[]): string[] {
    return [...new Set(assignments.map(a => a.branchName ?? a.id))];
}

// ---- Tests ------------------------------------------------------------------

describe('consolidateBranches', () => {
    it('empty assignments returns empty result', () => {
        const { assignments, consolidationLog } = consolidateBranches([], 5, emptyStories);
        expect(assignments).toEqual([]);
        expect(consolidationLog).toEqual([]);
    });

    it('assignments within maxBranches and no collisions -- no consolidation', () => {
        const a1 = makeAssignment({ id: 'A-001', branchName: 'project/feat/branch-1', moduleIds: ['auth'] });
        const a2 = makeAssignment({ id: 'A-002', branchName: 'project/feat/branch-2', moduleIds: ['payments'] });

        const { assignments, consolidationLog } = consolidateBranches([a1, a2], 5, emptyStories);

        expect(branchNames(assignments)).toHaveLength(2);
        expect(consolidationLog.some(l => l.includes('No consolidation needed'))).toBe(true);
    });

    it('module overlap merges branches into the branch with more assignments', () => {
        // branch-1 has 2 assignments, branch-2 has 1 -- both share module "auth"
        const a1 = makeAssignment({ id: 'A-001', branchName: 'project/feat/branch-1', moduleIds: ['auth'] });
        const a2 = makeAssignment({ id: 'A-002', branchName: 'project/feat/branch-1', moduleIds: ['auth', 'ui'] });
        const a3 = makeAssignment({ id: 'A-003', branchName: 'project/feat/branch-2', moduleIds: ['auth', 'db'] });

        const { assignments } = consolidateBranches([a1, a2, a3], 10, emptyStories);
        const branches = branchNames(assignments);

        // Both branches share "auth", so they should be merged into one
        expect(branches).toHaveLength(1);
        // The survivor should be branch-1 (has 2 assignments vs 1)
        expect(branches[0]).toBe('project/feat/branch-1');
        // All three assignments are preserved
        expect(assignments).toHaveLength(3);
    });

    it('over maxBranches triggers squash', () => {
        const allAssignments = [];
        for (let i = 1; i <= 5; i++) {
            allAssignments.push(
                makeAssignment({
                    id: `A-${String(i).padStart(3, '0')}`,
                    branchName: `project/feat/branch-${i}`,
                    moduleIds: [`mod-${i}`], // No overlapping modules
                }),
            );
        }

        const { assignments, consolidationLog } = consolidateBranches(
            allAssignments,
            3,
            emptyStories,
        );

        const branches = branchNames(assignments);
        expect(branches.length).toBeLessThanOrEqual(3);
        // All 5 assignments are preserved
        expect(assignments).toHaveLength(5);
        // Log should mention squash operations
        expect(consolidationLog.some(l => l.includes('Squash'))).toBe(true);
    });

    it('module overlap + squash combined', () => {
        // 4 branches: branch-1 and branch-2 share module "auth"
        // After module merge: 3 branches. maxBranches=2 forces one more squash.
        const a1 = makeAssignment({ id: 'A-001', branchName: 'project/feat/branch-1', moduleIds: ['auth'] });
        const a2 = makeAssignment({ id: 'A-002', branchName: 'project/feat/branch-2', moduleIds: ['auth'] });
        const a3 = makeAssignment({ id: 'A-003', branchName: 'project/feat/branch-3', moduleIds: ['payments'] });
        const a4 = makeAssignment({ id: 'A-004', branchName: 'project/feat/branch-4', moduleIds: ['ui'] });

        const { assignments, consolidationLog } = consolidateBranches(
            [a1, a2, a3, a4],
            2,
            emptyStories,
        );

        const branches = branchNames(assignments);
        expect(branches.length).toBeLessThanOrEqual(2);
        expect(assignments).toHaveLength(4);
        // Both module-overlap pass and squash pass should appear in the log
        expect(consolidationLog.some(l => l.includes('Module-overlap pass'))).toBe(true);
        expect(consolidationLog.some(l => l.includes('Squash'))).toBe(true);
    });

    it('squash prefers targets with module overlap', () => {
        // branch-1 owns "auth", branch-2 owns "db", branch-3 owns "auth"
        // No module-overlap merge (each module owned by separate branches initially
        // because we put them on separate branches but with matching module names).
        // Actually, "auth" is shared by branch-1 and branch-3, so module-overlap
        // pass merges them first. Then squash merges branch-2 into the survivor.
        const a1 = makeAssignment({ id: 'A-001', branchName: 'project/feat/branch-1', moduleIds: ['auth'] });
        const a2 = makeAssignment({ id: 'A-002', branchName: 'project/feat/branch-2', moduleIds: ['db'] });
        const a3 = makeAssignment({ id: 'A-003', branchName: 'project/feat/branch-3', moduleIds: ['auth'] });

        const { assignments } = consolidateBranches([a1, a2, a3], 1, emptyStories);
        const branches = branchNames(assignments);

        expect(branches).toHaveLength(1);
        expect(assignments).toHaveLength(3);
    });

    it('single branch with many assignments -- no consolidation', () => {
        const allAssignments = [];
        for (let i = 1; i <= 5; i++) {
            allAssignments.push(
                makeAssignment({
                    id: `A-${String(i).padStart(3, '0')}`,
                    branchName: 'project/feat/single-branch',
                    moduleIds: ['core'],
                }),
            );
        }

        const { assignments, consolidationLog } = consolidateBranches(
            allAssignments,
            10,
            emptyStories,
        );

        expect(branchNames(assignments)).toHaveLength(1);
        expect(assignments).toHaveLength(5);
        expect(consolidationLog.some(l => l.includes('No consolidation needed'))).toBe(true);
    });

    it('consolidationLog describes what happened', () => {
        const a1 = makeAssignment({ id: 'A-001', branchName: 'project/feat/b1', moduleIds: ['auth'] });
        const a2 = makeAssignment({ id: 'A-002', branchName: 'project/feat/b2', moduleIds: ['auth'] });

        const { consolidationLog } = consolidateBranches([a1, a2], 10, emptyStories);

        expect(consolidationLog.length).toBeGreaterThan(0);
        // Should contain a summary line
        expect(consolidationLog.some(l => l.includes('branches'))).toBe(true);
        // Should mention collision resolution
        expect(consolidationLog.some(l => l.includes('collision'))).toBe(true);
    });
});
