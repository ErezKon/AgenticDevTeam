/**
 * Dispatcher branching — unit tests.
 *
 * Tests canonicalBranchName (src/agents/developers/dispatch-plan.ts) and how
 * buildDispatchPlan groups assignments onto branches.
 *
 * Plan 30-01: an explicit branchName from the Team Leader always wins. Only an
 * assignment WITHOUT a branchName follows its story, onto the first non-scaffold
 * branch recorded for that story. The old "first branch seen for the story wins"
 * rule moved feature work and the FINAL INTEGRATION assignment onto the scaffold
 * branch in the claudeopus5 run.
 */
import { canonicalBranchName, buildDispatchPlan } from '../src/agents/developers/dispatch-plan';

const projectSlug = 'simple-calculator';

function makeAssignment(overrides: Record<string, any>) {
    return {
        id: overrides.id ?? 'ASSIGN-001',
        storyId: 'storyId' in overrides ? overrides.storyId : 'US-001',
        additionalStoryIds: overrides.additionalStoryIds ?? [],
        taskIds: overrides.taskIds ?? ['TASK-001'],
        acIndexes: overrides.acIndexes ?? [],
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
        moduleIds: overrides.moduleIds ?? [],
    };
}

describe('canonicalBranchName', () => {
    it('honours explicit branch names even when assignments share a storyId', () => {
        const storyBranches = new Map<string, string>();

        const a1 = makeAssignment({ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth' });
        const a2 = makeAssignment({ id: 'ASSIGN-002', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth-form' });
        const a3 = makeAssignment({ id: 'ASSIGN-003', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth-api' });

        expect(canonicalBranchName(a1, projectSlug, storyBranches)).toBe('simple-calculator/feature/us-001-auth');
        expect(canonicalBranchName(a2, projectSlug, storyBranches)).toBe('simple-calculator/feature/us-001-auth-form');
        expect(canonicalBranchName(a3, projectSlug, storyBranches)).toBe('simple-calculator/feature/us-001-auth-api');
        // The story remembers its FIRST explicit branch, for assignments that have none.
        expect(storyBranches.get('US-001')).toBe('simple-calculator/feature/us-001-auth');
    });

    it('an assignment without a branchName follows its story\'s branch', () => {
        const storyBranches = new Map<string, string>();

        const a1 = makeAssignment({ id: 'ASSIGN-001', storyId: 'US-003', branchName: 'simple-calculator/feature/us-003-first' });
        const a2 = makeAssignment({ id: 'ASSIGN-002', storyId: 'US-003', branchName: undefined });

        canonicalBranchName(a1, projectSlug, storyBranches);
        expect(canonicalBranchName(a2, projectSlug, storyBranches)).toBe('simple-calculator/feature/us-003-first');
    });

    it('never moves an assignment without a branchName onto the scaffold', () => {
        const storyBranches = new Map<string, string>();

        const scaffold = makeAssignment({ id: 'ASSIGN-001', storyId: 'US-035', branchName: 'simple-calculator/chore/scaffold', taskType: 'chore' });
        const wiring = makeAssignment({ id: 'ASSIGN-027', storyId: 'US-035', branchName: undefined, description: 'Final integration' });

        expect(canonicalBranchName(scaffold, projectSlug, storyBranches)).toBe('simple-calculator/chore/scaffold');
        expect(storyBranches.has('US-035')).toBe(false);
        expect(canonicalBranchName(wiring, projectSlug, storyBranches)).toBe('simple-calculator/feature/us-035-final-integration');
    });

    it('never moves a scaffold assignment off the scaffold', () => {
        const storyBranches = new Map<string, string>();

        const feature = makeAssignment({ id: 'ASSIGN-004', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-engine' });
        const scaffold = makeAssignment({ id: 'ASSIGN-002', storyId: 'US-001', branchName: 'chore/scaffold', taskType: 'chore' });

        canonicalBranchName(feature, projectSlug, storyBranches);
        expect(canonicalBranchName(scaffold, projectSlug, storyBranches)).toBe('simple-calculator/chore/scaffold');
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
        // Scaffold branches are never recorded as a story's branch.
        expect(storyBranches.has('ASSIGN-030')).toBe(false);
    });
});

describe('branch grouping (buildDispatchPlan)', () => {
    it('collapses assignments without a branchName onto their story\'s branch', () => {
        const assignments = [
            makeAssignment({ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'simple-calculator/feature/us-001-auth' }),
            makeAssignment({ id: 'ASSIGN-002', storyId: 'US-001' }),
            makeAssignment({ id: 'ASSIGN-003', storyId: 'US-001' }),
            makeAssignment({ id: 'ASSIGN-004', storyId: 'US-002', branchName: 'simple-calculator/feature/us-002-calc' }),
            makeAssignment({ id: 'ASSIGN-005', storyId: 'US-002' }),
            makeAssignment({ id: 'ASSIGN-006', storyId: 'US-002' }),
        ];
        const plan = buildDispatchPlan(assignments, { projectSlug });

        expect([...plan.branches.keys()].sort()).toEqual([
            'simple-calculator/feature/us-001-auth',
            'simple-calculator/feature/us-002-calc',
        ]);
        expect(plan.branches.get('simple-calculator/feature/us-001-auth')!.assignments.map(a => a.id))
            .toEqual(['ASSIGN-001', 'ASSIGN-002', 'ASSIGN-003']);
        expect(plan.storySplits).toEqual([]);
    });

    it('an explicit branch listed after its story-mates still seeds the story branch', () => {
        const plan = buildDispatchPlan([
            makeAssignment({ id: 'ASSIGN-001', storyId: 'US-004' }),
            makeAssignment({ id: 'ASSIGN-002', storyId: 'US-004', branchName: 'feature/us-004-settings' }),
        ], { projectSlug });

        expect([...plan.branches.keys()]).toEqual(['simple-calculator/feature/us-004-settings']);
    });

    it('reports a story-branch-split when the Team Leader spreads a story over branches', () => {
        const plan = buildDispatchPlan([
            makeAssignment({ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'feature/us-001-auth' }),
            makeAssignment({ id: 'ASSIGN-002', storyId: 'US-001', branchName: 'feature/us-001-login' }),
        ], { projectSlug });

        expect(plan.storySplits).toEqual([{
            storyId: 'US-001',
            branches: ['simple-calculator/feature/us-001-auth', 'simple-calculator/feature/us-001-login'],
        }]);
        expect(plan.warnings).toContain(
            'Story US-001 spans 2 branches: simple-calculator/feature/us-001-auth, simple-calculator/feature/us-001-login',
        );
    });
});
