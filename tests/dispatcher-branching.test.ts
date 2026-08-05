/**
 * Dispatcher branching — unit tests.
 *
 * Tests the canonicalBranchName helper exported from src/agents/developers/dispatcher.ts.
 * Verifies one-branch-per-story grouping: all assignments with the same storyId
 * collapse onto a single branch, regardless of what branchName the Team Leader
 * assigned to each one.
 *
 * Test cases from Sub-Plan 6 verification spec:
 *   - 3 assignments with storyId US-001 (different branchNames) → 1 branch
 *   - 3 assignments with storyId US-002 → 1 branch
 *   - Total: 6 assignments, 2 stories → 2 branches
 *   - First assignment's branchName wins for the story
 *   - Missing branchName gets a generated name with project slug prefix
 */
import { canonicalBranchName } from '../src/agents/developers/dispatcher';

const projectSlug = 'simple-calculator';

function makeAssignment(overrides: Record<string, any>) {
    return {
        id: overrides.id ?? 'ASSIGN-001',
        storyId: 'storyId' in overrides ? overrides.storyId : 'US-001',
        devAgentId: overrides.devAgentId ?? 'junior-react',
        rank: overrides.rank ?? 'junior',
        priority: overrides.priority ?? 'medium',
        complexity: overrides.complexity ?? 'moderate',
        estimate: overrides.estimate ?? '2h',
        description: overrides.description ?? 'Build something',
        dependsOn: overrides.dependsOn ?? [],
        branchName: overrides.branchName,
        reviewerAgentIds: overrides.reviewerAgentIds ?? ['senior-frontend', 'principal-frontend'],
        taskType: overrides.taskType ?? 'feature',
    };
}

describe('canonicalBranchName', () => {
    it('collapses assignments with the same storyId onto one branch', () => {
        const storyBranches = new Map<string, string>();

        const a1 = makeAssignment({ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth' });
        const a2 = makeAssignment({ id: 'ASSIGN-002', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth-form' });
        const a3 = makeAssignment({ id: 'ASSIGN-003', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth-api' });

        const b1 = canonicalBranchName(a1, projectSlug, storyBranches);
        const b2 = canonicalBranchName(a2, projectSlug, storyBranches);
        const b3 = canonicalBranchName(a3, projectSlug, storyBranches);

        expect(b1).toBe('simple-calculator/feature/us-001-auth');
        expect(b2).toBe(b1); // collapsed onto the first assignment's branch
        expect(b3).toBe(b1);
    });

    it('produces exactly 2 branches for 6 assignments across 2 stories', () => {
        const storyBranches = new Map<string, string>();

        const assignments = [
            makeAssignment({ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth' }),
            makeAssignment({ id: 'ASSIGN-002', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-login' }),
            makeAssignment({ id: 'ASSIGN-003', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-register' }),
            makeAssignment({ id: 'ASSIGN-004', storyId: 'US-002', branchName: 'simple-calculator/feature/us-002-calc' }),
            makeAssignment({ id: 'ASSIGN-005', storyId: 'US-002', branchName: 'simple-calculator/feature/us-002-calc-ui' }),
            makeAssignment({ id: 'ASSIGN-006', storyId: 'US-002', branchName: 'simple-calculator/feature/us-002-calc-api' }),
        ];

        const branches = new Set(
            assignments.map(a => canonicalBranchName(a, projectSlug, storyBranches)),
        );

        expect(branches.size).toBe(2);
        expect(storyBranches.size).toBe(2);
    });

    it('first assignment branchName wins for the story', () => {
        const storyBranches = new Map<string, string>();

        const a1 = makeAssignment({ id: 'ASSIGN-001', storyId: 'US-003', branchName: 'simple-calculator/feature/us-003-first' });
        const a2 = makeAssignment({ id: 'ASSIGN-002', storyId: 'US-003', branchName: 'simple-calculator/feature/us-003-second' });

        canonicalBranchName(a1, projectSlug, storyBranches);
        const branch2 = canonicalBranchName(a2, projectSlug, storyBranches);

        expect(branch2).toBe('simple-calculator/feature/us-003-first');
    });

    it('generates a branch name with slug prefix when branchName is missing', () => {
        const storyBranches = new Map<string, string>();

        const a = makeAssignment({ id: 'ASSIGN-010', storyId: 'US-005', branchName: undefined, description: 'Add user dashboard' });
        const branch = canonicalBranchName(a, projectSlug, storyBranches);

        expect(branch).toMatch(/^simple-calculator\//);
        expect(branch).toContain('us-005');
    });

    it('adds project slug prefix when the team leader forgot it', () => {
        const storyBranches = new Map<string, string>();

        const a = makeAssignment({ id: 'ASSIGN-020', storyId: 'US-006', branchName: 'feature/us-006-forgot-prefix' });
        const branch = canonicalBranchName(a, projectSlug, storyBranches);

        expect(branch).toBe('simple-calculator/feature/us-006-forgot-prefix');
    });

    it('falls back to assignment id when storyId is missing', () => {
        const storyBranches = new Map<string, string>();

        const a = makeAssignment({ id: 'ASSIGN-030', storyId: undefined, branchName: 'simple-calculator/chore/scaffold' });
        const branch = canonicalBranchName(a, projectSlug, storyBranches);

        expect(branch).toBe('simple-calculator/chore/scaffold');
        expect(storyBranches.get('ASSIGN-030')).toBe('simple-calculator/chore/scaffold');
    });
});
