/**
 * Tests for the scaffold barrier and implicit dependency injection (Sub-Plan 06 SS5a/SS5b).
 *
 * Plan 30-01: the barrier is injected by `buildDispatchPlan`, scaffold work is identified
 * by branch name only, and a scaffold assignment never waits for feature work.
 */
import { buildDispatchPlan, topoSort } from '../src/agents/developers/dispatch-plan';
import type { DispatchPlan } from '../src/agents/developers/dispatch-plan';
import type { Assignment } from '../src/agents/_shared/base-schemas';

const SCAFFOLD = 'project/chore/scaffold';

function makeAssignment(overrides: Partial<Assignment> = {}): Assignment {
    return {
        id: 'ASSIGN-001',
        storyId: 'US-001',
        devAgentId: 'senior-frontend',
        rank: 'senior',
        reviewerAgentIds: ['principal-frontend'],
        description: 'Implement feature',
        priority: 'high',
        complexity: 'moderate',
        estimate: '2h',
        dependsOn: [],
        branchName: 'project/feature/us-001',
        taskType: 'feature',
        additionalStoryIds: [],
        taskIds: ['TASK-001'],
        acIndexes: [0],
        moduleIds: [],
        ...overrides,
    };
}

function plan(assignments: Assignment[]): DispatchPlan {
    return buildDispatchPlan(assignments, { projectSlug: 'project' });
}

/** The planned (effective) dependsOn of one assignment. */
function depsOf(p: DispatchPlan, id: string): string[] {
    for (const branch of p.branches.values()) {
        const found = branch.assignments.find(a => a.id === id);
        if (found) return found.dependsOn;
    }
    throw new Error(`assignment ${id} not in plan`);
}

/** All planned assignments in dispatch order. */
function planned(p: DispatchPlan): Assignment[] {
    return p.branchOrder.flatMap(b => p.branches.get(b)!.assignments);
}

describe('scaffold barrier (buildDispatchPlan)', () => {
    it('injects scaffold assignment ids into non-scaffold assignments', () => {
        const p = plan([
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: SCAFFOLD }),
            makeAssignment({ id: 'FEATURE-001', dependsOn: [] }),
            makeAssignment({ id: 'FEATURE-002', storyId: 'US-002', branchName: 'project/feature/us-002', dependsOn: [] }),
        ]);

        // Scaffold assignment should not depend on itself
        expect(depsOf(p, 'SCAFFOLD-001')).toEqual([]);

        // Feature assignments should depend on scaffold
        expect(depsOf(p, 'FEATURE-001')).toContain('SCAFFOLD-001');
        expect(depsOf(p, 'FEATURE-002')).toContain('SCAFFOLD-001');
    });

    it('does not duplicate existing scaffold dependencies', () => {
        const p = plan([
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: SCAFFOLD }),
            makeAssignment({ id: 'FEATURE-001', dependsOn: ['SCAFFOLD-001'] }),
        ]);
        expect(depsOf(p, 'FEATURE-001').filter(d => d === 'SCAFFOLD-001')).toHaveLength(1); // not duplicated
    });

    it('handles plans with no scaffold branch — a chore on a feature branch is not a barrier', () => {
        const p = plan([
            makeAssignment({ id: 'CHORE-001', taskType: 'chore' }),
            makeAssignment({ id: 'FEATURE-002', storyId: 'US-002', branchName: 'project/feature/us-002' }),
        ]);
        expect(depsOf(p, 'CHORE-001')).toEqual([]);
        expect(depsOf(p, 'FEATURE-002')).toEqual([]);
        expect([...p.branches.values()].map(b => b.kind)).toEqual(['feature', 'feature']);
    });

    it('handles multiple scaffold assignments', () => {
        const p = plan([
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: SCAFFOLD }),
            makeAssignment({ id: 'SCAFFOLD-002', taskType: 'chore', branchName: SCAFFOLD, dependsOn: ['SCAFFOLD-001'] }),
            makeAssignment({ id: 'FEATURE-001', dependsOn: [] }),
        ]);
        expect(depsOf(p, 'FEATURE-001')).toEqual(expect.arrayContaining(['SCAFFOLD-001', 'SCAFFOLD-002']));
        expect(p.branches.get(SCAFFOLD)!.assignments.map(a => a.id)).toEqual(['SCAFFOLD-001', 'SCAFFOLD-002']);
        expect(p.layers[0]).toEqual([SCAFFOLD]);
    });

    it('drops a scaffold dependency on feature work instead of creating a cycle', () => {
        const p = plan([
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: SCAFFOLD, dependsOn: ['FEATURE-001'] }),
            makeAssignment({ id: 'FEATURE-001' }),
        ]);
        expect(depsOf(p, 'SCAFFOLD-001')).toEqual([]);
        expect(depsOf(p, 'FEATURE-001')).toEqual(['SCAFFOLD-001']);
        expect(p.skippedEdges).toEqual([{ from: 'SCAFFOLD-001', to: 'FEATURE-001', reason: 'scaffold-depends-on-feature' }]);
        expect(p.warnings.some(w => w.includes('SCAFFOLD-001') && w.includes('FEATURE-001'))).toBe(true);
        expect(p.brokenEdges).toEqual([]);
        expect(p.branchOrder).toEqual([SCAFFOLD, 'project/feature/us-001']);
    });
});

describe('topoSort with scaffold dependencies', () => {
    it('places scaffold assignments in the first layer', () => {
        const { layers } = topoSort(planned(plan([
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: SCAFFOLD }),
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature' }),
        ])));

        // Scaffold should be in layer 0, feature in layer 1
        expect(layers.length).toBeGreaterThanOrEqual(2);
        expect(layers[0].map(a => a.id)).toContain('SCAFFOLD-001');
        expect(layers[1].map(a => a.id)).toContain('FEATURE-001');
    });

    it('preserves existing dependencies between feature assignments', () => {
        const { layers } = topoSort(planned(plan([
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: SCAFFOLD }),
            makeAssignment({ id: 'FEATURE-001', dependsOn: [] }),
            makeAssignment({ id: 'FEATURE-002', dependsOn: ['FEATURE-001'] }),
        ])));

        // SCAFFOLD-001 in layer 0, FEATURE-001 in layer 1, FEATURE-002 in layer 2
        expect(layers.length).toBeGreaterThanOrEqual(3);
        expect(layers[0].map(a => a.id)).toContain('SCAFFOLD-001');
        expect(layers[1].map(a => a.id)).toContain('FEATURE-001');
        expect(layers[2].map(a => a.id)).toContain('FEATURE-002');
    });
});
