/**
 * Tests for the scaffold barrier and implicit dependency injection (Sub-Plan 06 SS5a/SS5b).
 */
import { topoSort, injectScaffoldDependencies } from '../src/agents/developers/dispatcher';
import type { Assignment } from '../src/agents/_shared/base-schemas';

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

describe('injectScaffoldDependencies', () => {
    it('injects scaffold assignment ids into non-scaffold assignments', () => {
        const assignments = [
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore', branchName: 'project/chore/scaffold' }),
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature', dependsOn: [] }),
            makeAssignment({ id: 'FEATURE-002', taskType: 'feature', dependsOn: [] }),
        ];

        const augmented = injectScaffoldDependencies(assignments);

        // Scaffold assignment should not depend on itself
        expect(augmented[0].dependsOn).toEqual([]);

        // Feature assignments should depend on scaffold
        expect(augmented[1].dependsOn).toContain('SCAFFOLD-001');
        expect(augmented[2].dependsOn).toContain('SCAFFOLD-001');
    });

    it('does not duplicate existing scaffold dependencies', () => {
        const assignments = [
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore' }),
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature', dependsOn: ['SCAFFOLD-001'] }),
        ];

        const augmented = injectScaffoldDependencies(assignments);
        const deps = augmented[1].dependsOn.filter(d => d === 'SCAFFOLD-001');
        expect(deps).toHaveLength(1); // not duplicated
    });

    it('handles plans with no scaffold assignments', () => {
        const assignments = [
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature' }),
            makeAssignment({ id: 'FEATURE-002', taskType: 'feature' }),
        ];

        const augmented = injectScaffoldDependencies(assignments);
        expect(augmented[0].dependsOn).toEqual([]);
        expect(augmented[1].dependsOn).toEqual([]);
    });

    it('handles multiple scaffold assignments', () => {
        const assignments = [
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore' }),
            makeAssignment({ id: 'SCAFFOLD-002', taskType: 'chore' }),
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature', dependsOn: [] }),
        ];

        const augmented = injectScaffoldDependencies(assignments);
        expect(augmented[2].dependsOn).toContain('SCAFFOLD-001');
        expect(augmented[2].dependsOn).toContain('SCAFFOLD-002');
    });
});

describe('topoSort with scaffold dependencies', () => {
    it('places scaffold assignments in the first layer', () => {
        const assignments = [
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore' }),
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature' }),
        ];

        const augmented = injectScaffoldDependencies(assignments);
        const layers = topoSort(augmented);

        // Scaffold should be in layer 0, feature in layer 1
        expect(layers.length).toBeGreaterThanOrEqual(2);
        expect(layers[0].map(a => a.id)).toContain('SCAFFOLD-001');
        expect(layers[1].map(a => a.id)).toContain('FEATURE-001');
    });

    it('preserves existing dependencies between feature assignments', () => {
        const assignments = [
            makeAssignment({ id: 'SCAFFOLD-001', taskType: 'chore' }),
            makeAssignment({ id: 'FEATURE-001', taskType: 'feature', dependsOn: [] }),
            makeAssignment({ id: 'FEATURE-002', taskType: 'feature', dependsOn: ['FEATURE-001'] }),
        ];

        const augmented = injectScaffoldDependencies(assignments);
        const layers = topoSort(augmented);

        // SCAFFOLD-001 in layer 0, FEATURE-001 in layer 1, FEATURE-002 in layer 2
        expect(layers.length).toBeGreaterThanOrEqual(3);
        expect(layers[0].map(a => a.id)).toContain('SCAFFOLD-001');
        expect(layers[1].map(a => a.id)).toContain('FEATURE-001');
        expect(layers[2].map(a => a.id)).toContain('FEATURE-002');
    });
});
