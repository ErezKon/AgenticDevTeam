/**
 * Dispatch planning (Plan 30-01) — src/agents/developers/dispatch-plan.ts.
 *
 * Covers: scaffold-by-name, explicit branches, bootstrap vs finalizer barriers,
 * deterministic cycle breaking (assignment and branch level), the branch DAG
 * order, overlap serialisation, the halt-policy reaction and the plan summary.
 */
import {
    buildDispatchPlan, topoSort, onBranchNotMerged, serialiseOverlaps,
    summariseDispatchPlan, describeBrokenEdge,
} from '../src/agents/developers/dispatch-plan';
import type { DispatchPlan } from '../src/agents/developers/dispatch-plan';
import { wouldCreateCycle } from '../src/utils/dependency-graph';
import type { Assignment } from '../src/agents/_shared/base-schemas';

const SLUG = 'app';
const SCAFFOLD = 'app/chore/scaffold';

function make(id: string, branchName: string | undefined, over: Partial<Assignment> = {}): Assignment {
    return {
        id,
        storyId: `US-${id}`,
        additionalStoryIds: [],
        taskIds: ['TASK-001'],
        acIndexes: [],
        devAgentId: 'senior-frontend',
        rank: 'senior',
        priority: 'high',
        complexity: 'moderate',
        estimate: '2h',
        description: `Implement ${id}`,
        dependsOn: [],
        branchName,
        reviewerAgentIds: ['principal-frontend'],
        taskType: 'feature',
        moduleIds: [],
        ...over,
    };
}

const plan = (assignments: Assignment[], preSatisfied: string[] = []): DispatchPlan =>
    buildDispatchPlan(assignments, { projectSlug: SLUG, preSatisfied });

/** The planned (effective) dependsOn of one assignment. */
function depsOf(p: DispatchPlan, id: string): string[] {
    for (const branch of p.branches.values()) {
        const found = branch.assignments.find(a => a.id === id);
        if (found) return found.dependsOn;
    }
    throw new Error(`assignment ${id} not in plan`);
}

describe('scaffold classification', () => {
    it('a chore on a feature branch is not scaffold work', () => {
        const p = plan([
            make('S', SCAFFOLD, { taskType: 'chore' }),
            make('AUDIT', 'app/feature/us-027-storage', { taskType: 'chore', description: 'Audit and compress assets' }),
        ]);
        expect(p.branches.get('app/feature/us-027-storage')!.kind).toBe('feature');
        expect(p.assignmentKinds.get('AUDIT')).toBe('feature');
        expect(depsOf(p, 'AUDIT')).toEqual(['S']);
    });

    it('an un-prefixed chore/scaffold branch is the scaffold whatever the taskType', () => {
        const p = plan([make('S', 'chore/scaffold', { taskType: 'refactor' }), make('F', 'feature/f')]);
        expect(p.branches.get(SCAFFOLD)!.kind).toBe('scaffold');
        expect(p.branchOrder).toEqual([SCAFFOLD, 'app/feature/f']);
    });
});

describe('explicit branches', () => {
    it('are honoured even when assignments share a story with the scaffold', () => {
        const p = plan([
            make('S1', SCAFFOLD, { storyId: 'US-001', taskType: 'chore' }),
            make('F1', 'app/feature/us-001-engine', { storyId: 'US-001' }),
            make('F2', 'app/feature/us-001-engine', { storyId: 'US-001' }),
            make('F3', undefined, { storyId: 'US-001' }),
        ]);
        expect(p.branches.get(SCAFFOLD)!.assignments.map(a => a.id)).toEqual(['S1']);
        expect(p.branches.get('app/feature/us-001-engine')!.assignments.map(a => a.id)).toEqual(['F1', 'F2', 'F3']);
        expect(p.storySplits).toEqual([{ storyId: 'US-001', branches: [SCAFFOLD, 'app/feature/us-001-engine'] }]);
    });

    it('an invalid explicit name falls back to the story branch with a warning', () => {
        const p = plan([make('F1', 'feature/us-001..oops', { storyId: 'US-001', description: 'Login form' })]);
        expect([...p.branches.keys()]).toEqual(['app/feature/us-001-login-form']);
        expect(p.warnings.some(w => w.includes('F1') && w.includes('ignoring branchName'))).toBe(true);
    });
});

describe('bootstrap and finalizer barriers', () => {
    it('bootstrap wiring that needs only the scaffold runs right after it, before feature work', () => {
        const p = plan([
            make('S', SCAFFOLD, { taskType: 'chore' }),
            make('F', 'app/feature/f'),
            make('B', 'app/feature/bootstrap', { description: 'Composition root wiring for the app shell', dependsOn: ['S'] }),
        ]);
        expect(p.assignmentKinds.get('B')).toBe('bootstrap');
        expect(depsOf(p, 'F')).toEqual(['S', 'B']);
        expect(p.branchOrder).toEqual([SCAFFOLD, 'app/feature/bootstrap', 'app/feature/f']);
        expect(p.branches.get('app/feature/bootstrap')!.reason).toContain('bootstrap: B mentions "wiring"');
    });

    it('an entry-module owner counts as bootstrap work', () => {
        const p = plan([make('S', SCAFFOLD), make('M', 'app/feature/main', { moduleIds: ['MOD-MAIN'] }), make('F', 'app/feature/f')]);
        expect(p.assignmentKinds.get('M')).toBe('bootstrap');
        expect(depsOf(p, 'F')).toContain('M');
    });

    it('wiring that depends on feature work is a finalizer: no injected edges, no cycle, runs last', () => {
        const p = plan([
            make('S', SCAFFOLD, { taskType: 'chore' }),
            make('W', 'app/feature/integration', { description: 'FINAL INTEGRATION: wiring every screen', dependsOn: ['F1', 'F2'] }),
            make('F1', 'app/feature/a'),
            make('F2', 'app/feature/b'),
        ]);
        expect(p.assignmentKinds.get('W')).toBe('finalizer');
        expect(depsOf(p, 'F1')).toEqual(['S']);
        expect(depsOf(p, 'F2')).toEqual(['S']);
        expect(p.brokenEdges).toEqual([]);
        expect(p.skippedEdges).toEqual([]);
        expect(p.branchOrder[p.branchOrder.length - 1]).toBe('app/feature/integration');
        expect(p.branches.get('app/feature/integration')!.reason).toBe('finalizer: W mentions "wiring" but depends on 2 feature assignment(s)');
    });

    it('a finalizer branch waits while any other branch is still ready', () => {
        const p = plan([
            make('W', 'app/feature/integration', { description: 'Final wiring', dependsOn: ['F1'] }),
            make('F1', 'app/feature/a'),
            make('F2', 'app/feature/b', { dependsOn: ['F1'] }),
        ]);
        // W and F2 both only need F1, but the finalizer is held back for a layer.
        expect(p.layers).toEqual([['app/feature/a'], ['app/feature/b'], ['app/feature/integration']]);
    });

    it('skips a barrier edge that would close a branch cycle', () => {
        // B's branch also carries feature work that waits for branch x, so "x waits for B" would be a cycle.
        const p = plan([
            make('S', SCAFFOLD),
            make('X1', 'app/feature/x'),
            make('B', 'app/feature/boot', { description: 'Bootstrap the router' }),
            make('B2', 'app/feature/boot', { dependsOn: ['X1'] }),
        ]);
        expect(p.assignmentKinds.get('B')).toBe('bootstrap');
        expect(p.skippedEdges).toEqual([{ from: 'X1', to: 'B', reason: 'would-create-cycle' }]);
        expect(depsOf(p, 'B2')).toEqual(['X1', 'S', 'B']);
        expect(p.brokenEdges).toEqual([]);
        expect(p.branchOrder).toEqual([SCAFFOLD, 'app/feature/x', 'app/feature/boot']);
    });
});

describe('cycle breaking', () => {
    it('breaks an assignment cycle deterministically and records the removed edge', () => {
        const cyclic = [
            make('A', 'app/feature/x', { dependsOn: ['C'] }),
            make('B', 'app/feature/x', { dependsOn: ['A'] }),
            make('C', 'app/feature/x', { dependsOn: ['B'] }),
        ];
        const first = topoSort(cyclic);
        expect(first.brokenEdges).toEqual([{ from: 'A', to: 'C', level: 'assignment', cycle: ['A', 'B', 'C'] }]);
        expect(first.layers.map(l => l.map(a => a.id))).toEqual([['A'], ['B'], ['C']]);
        expect(first.layers[0][0].dependsOn).toEqual([]);
        expect(topoSort(cyclic)).toEqual(first);
        expect(describeBrokenEdge(first.brokenEdges[0])).toContain('dropped "A dependsOn C"');
    });

    it('breaks a self-dependency', () => {
        const { brokenEdges, layers } = topoSort([make('A', 'app/feature/x', { dependsOn: ['A'] })]);
        expect(brokenEdges).toEqual([{ from: 'A', to: 'A', level: 'assignment', cycle: ['A'] }]);
        expect(layers).toHaveLength(1);
    });

    it('never dispatches a cycle as one parallel batch', () => {
        const p = plan([
            make('A', 'app/feature/a', { dependsOn: ['B'] }),
            make('B', 'app/feature/b', { dependsOn: ['A'] }),
        ]);
        expect(p.brokenEdges).toEqual([{ from: 'A', to: 'B', level: 'assignment', cycle: ['A', 'B'] }]);
        expect(p.layers).toEqual([['app/feature/a'], ['app/feature/b']]);
    });

    it('breaks a branch-level cycle and names the assignment edges behind it', () => {
        const p = plan([
            make('X1', 'app/feature/x'),
            make('Y1', 'app/feature/y', { dependsOn: ['X1'] }),
            make('X2', 'app/feature/x', { dependsOn: ['Y1'] }),
        ]);
        expect(p.brokenEdges).toEqual([{
            from: 'app/feature/x', to: 'app/feature/y', level: 'branch',
            cycle: ['app/feature/x', 'app/feature/y'], via: [{ from: 'X2', to: 'Y1' }],
        }]);
        expect(p.branchOrder).toEqual(['app/feature/x', 'app/feature/y']);
        expect(describeBrokenEdge(p.brokenEdges[0])).toContain('X2 dependsOn Y1');
    });
});

describe('branch DAG order', () => {
    it('orders branches by their cross-branch dependencies, not by listing order', () => {
        const p = plan([
            make('Z', 'app/feature/z', { dependsOn: ['Y'] }),
            make('Y', 'app/feature/y', { dependsOn: ['X'] }),
            make('X', 'app/feature/x'),
            make('S', SCAFFOLD),
        ]);
        expect(p.layers).toEqual([[SCAFFOLD], ['app/feature/x'], ['app/feature/y'], ['app/feature/z']]);
        expect(p.branches.get('app/feature/z')!.dependsOnBranches).toEqual([SCAFFOLD, 'app/feature/y']);
    });

    it('waits for the whole branch, not just the first ready assignment', () => {
        // Old behaviour: branch "late" started as soon as L1 was ready, running L2 before X merged.
        const p = plan([
            make('L1', 'app/feature/late'),
            make('L2', 'app/feature/late', { dependsOn: ['X'] }),
            make('X', 'app/feature/x'),
        ]);
        expect(p.branchOrder).toEqual(['app/feature/x', 'app/feature/late']);
    });

    it('treats dependencies on already-merged work as satisfied', () => {
        const p = plan([make('F', 'app/feature/f', { dependsOn: ['ASSIGN-OLD'] })], ['ASSIGN-OLD']);
        expect(p.layers).toEqual([['app/feature/f']]);
        expect(p.warnings).toEqual([]);
    });

    it('groups independent branches into one layer', () => {
        const p = plan([make('S', SCAFFOLD), make('A', 'app/feature/a'), make('B', 'app/feature/b')]);
        expect(p.layers).toEqual([[SCAFFOLD], ['app/feature/a', 'app/feature/b']]);
    });
});

describe('wouldCreateCycle', () => {
    const graph = new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set<string>()]]);
    it('detects an edge that closes a cycle', () => expect(wouldCreateCycle(graph, 'c', 'a')).toBe(true));
    it('allows an edge that does not', () => expect(wouldCreateCycle(graph, 'a', 'c')).toBe(false));
    it('rejects a self edge', () => expect(wouldCreateCycle(graph, 'a', 'a')).toBe(true));
});

describe('overlap serialisation', () => {
    it('chains same-layer branches that own a common module', () => {
        const p = plan([
            make('A', 'app/feature/a', { moduleIds: ['MOD-RENDERER'] }),
            make('B', 'app/feature/b', { moduleIds: ['MOD-RENDERER'] }),
            make('C', 'app/feature/c', { moduleIds: ['MOD-AUDIO'] }),
        ]);
        expect(serialiseOverlaps(p, p.layers[0])).toEqual({ chains: [['app/feature/a', 'app/feature/b']], parallel: ['app/feature/c'] });
        expect(p.warnings.some(w => w.includes('MOD-RENDERER'))).toBe(true);
    });

    it('ignores overlaps between branches already ordered by a dependency', () => {
        const p = plan([
            make('A', 'app/feature/a', { moduleIds: ['MOD-RENDERER'] }),
            make('B', 'app/feature/b', { moduleIds: ['MOD-RENDERER'], dependsOn: ['A'] }),
        ]);
        expect(p.overlaps.size).toBe(0);
    });
});

describe('onBranchNotMerged (DISPATCH_HALT_POLICY)', () => {
    // scaffold ← a ← b ← d ;  scaffold ← c
    const p = plan([
        make('S', SCAFFOLD),
        make('A', 'app/feature/a'),
        make('B', 'app/feature/b', { dependsOn: ['A'] }),
        make('C', 'app/feature/c'),
        make('D', 'app/feature/d', { dependsOn: ['B'] }),
    ]);

    it('dependents skips only the transitive dependents', () => {
        expect(onBranchNotMerged(p, 'app/feature/a', 'dependents')).toEqual({ halt: false, skip: ['app/feature/b', 'app/feature/d'] });
        expect(onBranchNotMerged(p, 'app/feature/c', 'dependents')).toEqual({ halt: false, skip: [] });
    });

    it('dependents still blocks everything when the scaffold fails', () => {
        expect(onBranchNotMerged(p, SCAFFOLD, 'dependents').skip).toEqual(['app/feature/a', 'app/feature/c', 'app/feature/b', 'app/feature/d']);
    });

    it('strict halts on any failure, scaffold-only only on the scaffold, off never', () => {
        expect(onBranchNotMerged(p, 'app/feature/c', 'strict')).toEqual({ halt: true, skip: [] });
        expect(onBranchNotMerged(p, 'app/feature/c', 'scaffold-only')).toEqual({ halt: false, skip: [] });
        expect(onBranchNotMerged(p, SCAFFOLD, 'scaffold-only')).toEqual({ halt: true, skip: [] });
        expect(onBranchNotMerged(p, SCAFFOLD, 'off')).toEqual({ halt: false, skip: [] });
    });
});

describe('summariseDispatchPlan', () => {
    it('records kinds, reasons, assignments, dependencies and order', () => {
        const p = plan([make('S', SCAFFOLD), make('F', 'app/feature/f')]);
        expect(summariseDispatchPlan(p)).toEqual({
            branches: [
                { name: SCAFFOLD, kind: 'scaffold', reason: 'scaffold: branch name is <slug>/chore/scaffold', assignments: ['S'], dependsOn: [] },
                { name: 'app/feature/f', kind: 'feature', reason: 'feature', assignments: ['F'], dependsOn: [SCAFFOLD] },
            ],
            order: [SCAFFOLD, 'app/feature/f'],
            layers: [[SCAFFOLD], ['app/feature/f']],
            skippedEdges: [],
            brokenEdges: [],
            warnings: [],
        });
    });
});
