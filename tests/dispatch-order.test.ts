/**
 * Plan 30-O: plan-aware scaffold classification, cycle-safe scaffold injection,
 * minimal cycle breaking and branch-level dispatch order.
 *
 * Fixture = the exact dependency graph the Team Leader produced in
 * pacman-live-analysis-4 (23 assignments on 8 branches). ASSIGN-019 is a `chore`
 * on the feature branch us-015 that depends on three feature assignments.
 */
import {
    canonicalBranchName, injectScaffoldDependencies, isScaffoldAssignment, isScaffoldBranch, orderBranchLayers, topoSort,
} from '../src/agents/developers/dispatcher';
import type { Assignment } from '../src/agents/_shared/base-schemas';

jest.mock('../src/utils/logger');

const PLAN: Array<[string, string, string, string[]]> = [
    ['001', 'chore', 'chore/scaffold', []],
    ['002', 'chore', 'chore/scaffold', ['001']],
    ['003', 'chore', 'chore/scaffold', ['002']],
    ['004', 'feature', 'feature/us-001-maze', ['002', '003']],
    ['005', 'feature', 'feature/us-001-maze', ['004']],
    ['006', 'feature', 'feature/us-001-maze', ['005']],
    ['007', 'feature', 'feature/us-002-loop', ['003']],
    ['008', 'feature', 'feature/us-002-loop', ['007', '004']],
    ['009', 'feature', 'feature/us-002-loop', ['007']],
    ['010', 'feature', 'feature/us-005-ghosts', ['003', '008']],
    ['011', 'feature', 'feature/us-005-ghosts', ['010']],
    ['012', 'feature', 'feature/us-008-collision', ['008', '010']],
    ['013', 'feature', 'feature/us-008-collision', ['012']],
    ['014', 'feature', 'feature/us-012-levels', ['013']],
    ['015', 'feature', 'feature/us-012-levels', ['014']],
    ['016', 'feature', 'feature/us-015-audio', ['003']],
    ['017', 'feature', 'feature/us-015-audio', ['003']],
    ['018', 'feature', 'feature/us-015-audio', ['003']],
    ['019', 'chore', 'feature/us-015-audio', ['001', '016', '017', '018']],
    ['020', 'feature', 'feature/us-017-ui', ['013', '017']],
    ['021', 'feature', 'feature/us-017-ui', ['017', '018']],
    ['022', 'feature', 'feature/us-017-ui', ['017', '020', '021']],
    ['023', 'feature', 'feature/us-017-ui', ['006', '008', '009', '011', '012', '013', '015', '016', '017', '018', '020', '021', '022']],
];

const branch = (a: Assignment): string => a.branchName ?? '';

function sessionFourPlan(): Assignment[] {
    return PLAN.map(([id, taskType, branchName, deps]) => ({
        id: `A${id}`, taskId: `T${id}`, storyId: 'US-001', devAgentId: 'senior-frontend', description: '',
        taskType, branchName, dependsOn: deps.map(d => `A${d}`), reviewerAgentIds: [],
    }) as unknown as Assignment);
}

describe('canonicalBranchName never crosses the scaffold boundary (Plan 30-U)', () => {
    const asg = (id: string, storyId: string, branchName?: string) =>
        ({ id, storyId, branchName, dependsOn: [], description: 'x' }) as unknown as Assignment;

    it('keeps a feature-named assignment of the scaffold story on its own branch', () => {
        const map = new Map<string, string>();
        expect(canonicalBranchName(asg('A1', 'US-001', 'chore/scaffold'), 'app', map)).toBe('app/chore/scaffold');
        expect(canonicalBranchName(asg('A4', 'US-001', 'feature/us-001-maze'), 'app', map)).toBe('app/feature/us-001-maze');
        expect(canonicalBranchName(asg('A13', 'US-001', 'feature/us-001-maze'), 'app', map)).toBe('app/feature/us-001-maze');
    });

    it('keeps a scaffold-named assignment on the scaffold when a feature claimed the story first', () => {
        const map = new Map<string, string>();
        expect(canonicalBranchName(asg('F1', 'US-001', 'feature/us-001-maze'), 'app', map)).toBe('app/feature/us-001-maze');
        expect(canonicalBranchName(asg('S1', 'US-001', 'chore/scaffold'), 'app', map)).toBe('app/chore/scaffold');
    });

    it('still collapses same-side assignments and unnamed ones onto the story branch', () => {
        const map = new Map<string, string>();
        canonicalBranchName(asg('A1', 'US-002', 'feature/us-002-a'), 'app', map);
        expect(canonicalBranchName(asg('A2', 'US-002', 'feature/us-002-b'), 'app', map)).toBe('app/feature/us-002-a');
        expect(canonicalBranchName(asg('A3', 'US-002'), 'app', map)).toBe('app/feature/us-002-a');
    });
});

// Exact dependency graph of pacman-live-analysis-9 (30 assignments): the scaffold story id
// US-001 is reused by the maze assignments A004/A013, and A013 depends on four branches.
const SESSION9: Array<[string, string, string, string, string[]]> = [
    ['001', 'chore', 'US-001', 'chore/scaffold', []], ['002', 'chore', 'US-001', 'chore/scaffold', ['001']],
    ['003', 'chore', 'US-001', 'chore/scaffold', ['002']],
    ['004', 'feature', 'US-001', 'feature/us-001-maze', ['003']],
    ['005', 'feature', 'US-006', 'feature/us-003-move', ['004']], ['006', 'feature', 'US-003', 'feature/us-003-move', ['003']],
    ['007', 'feature', 'US-007', 'feature/us-007-ghost', ['004']], ['008', 'feature', 'US-007', 'feature/us-007-ghost', ['007']],
    ['009', 'feature', 'US-013', 'feature/us-013-fruit', ['004']], ['010', 'feature', 'US-015', 'feature/us-013-fruit', ['009', '008']],
    ['011', 'feature', 'US-026', 'feature/us-026-audio', ['003']], ['012', 'feature', 'US-028', 'feature/us-026-audio', ['003']],
    ['013', 'feature', 'US-001', 'feature/us-001-maze', ['004', '005', '007', '008', '009', '012']],
    ['014', 'feature', 'US-002', 'feature/us-001-maze', ['004', '013']],
    ['015', 'feature', 'US-024', 'feature/us-019-screens', ['003']], ['016', 'feature', 'US-019', 'feature/us-019-screens', ['015']],
    ['021', 'feature', 'US-025', 'feature/us-019-screens', ['015', '010']],
    ['023', 'feature', 'US-031', 'feature/us-019-screens', ['006', '013']],
    ['024', 'chore', 'US-033', 'feature/us-033-integ', ['001']],
    ['026', 'feature', 'US-035', 'feature/us-033-integ', ['005', '010', '013', '014', '021', '023']],
];

describe('session-9 plan ordering (Plan 30-U)', () => {
    it('dispatches the scaffold first and the maze before its consumers', () => {
        const plan = injectScaffoldDependencies(SESSION9.map(([id, taskType, storyId, branchName, deps]) => ({
            id: `A${id}`, taskType, storyId, branchName, dependsOn: deps.map(d => `A${d}`), description: '',
        }) as unknown as Assignment));
        const map = new Map<string, string>();
        const branchOf = (a: Assignment) => canonicalBranchName(a, 'app', map);
        for (const a of plan) branchOf(a);
        const layers = orderBranchLayers(plan, branchOf, new Set(), b => /chore\/scaffold$/.test(b));
        const layerOf = (b: string) => layers.findIndex(l => l.some(a => branchOf(a) === `app/${b}`));

        expect(layers[0].every(a => branchOf(a) === 'app/chore/scaffold')).toBe(true);
        expect(layers[0]).toHaveLength(3);
        expect(layerOf('feature/us-001-maze')).toBeLessThan(layerOf('feature/us-003-move'));
        expect(layerOf('feature/us-001-maze')).toBeLessThan(layerOf('feature/us-007-ghost'));
        expect(layerOf('feature/us-007-ghost')).toBeLessThan(layerOf('feature/us-013-fruit'));
        expect(layerOf('feature/us-033-integ')).toBe(layers.length - 1);
        expect(layers.flat()).toHaveLength(SESSION9.length);
    });
});

describe('plan-aware scaffold classification', () => {
    it('does not treat a chore on a feature branch as scaffold when the plan names a scaffold branch', () => {
        const plan = sessionFourPlan();
        const choreOnFeature = plan.find(a => a.id === 'A019')!;
        expect(isScaffoldAssignment(choreOnFeature, plan)).toBe(false);
        expect(isScaffoldBranch('app/feature/us-015-audio', plan.filter(a => a.branchName === 'feature/us-015-audio'), plan)).toBe(false);
        expect(isScaffoldAssignment(plan[0], plan)).toBe(true);
    });

    it('keeps the legacy rule (any chore) when no scaffold branch is named or no plan is given', () => {
        const plan = sessionFourPlan().map(a => ({ ...a, branchName: branch(a).replace('chore/scaffold', 'setup') }));
        expect(isScaffoldAssignment(plan.find(a => a.id === 'A019')!, plan)).toBe(true);
        expect(isScaffoldAssignment(sessionFourPlan().find(a => a.id === 'A019')!)).toBe(true);
    });
});

describe('injectScaffoldDependencies', () => {
    it('creates no cycle for the session-4 plan', () => {
        const injected = injectScaffoldDependencies(sessionFourPlan());
        expect(injected.find(a => a.id === 'A016')!.dependsOn).toContain('A001');
        expect(injected.find(a => a.id === 'A016')!.dependsOn).not.toContain('A019');
        const layers = topoSort(injected);
        expect(layers.flat()).toHaveLength(23);
        expect(layers.every(layer => layer.length < 20)).toBe(true);
    });

    it('never injects into an assignment the scaffold itself depends on', () => {
        const plan = [
            { id: 'S', taskType: 'chore', branchName: 'chore/scaffold', dependsOn: ['F'] },
            { id: 'F', taskType: 'feature', branchName: 'feature/x', dependsOn: [] },
        ] as unknown as Assignment[];
        expect(injectScaffoldDependencies(plan).find(a => a.id === 'F')!.dependsOn).toEqual([]);
    });
});

describe('topoSort cycle breaking', () => {
    // Plan 30-U: the foundation (most dependents) goes first, not the node with fewest unmet deps.
    it('releases the most depended-upon node first', () => {
        const plan = [
            { id: 'MAZE', dependsOn: ['MOVE', 'GHOST'] },
            { id: 'MOVE', dependsOn: ['MAZE'] },
            { id: 'GHOST', dependsOn: ['MAZE'] },
            { id: 'SCORE', dependsOn: ['MAZE', 'GHOST'] },
        ] as unknown as Assignment[];
        expect(topoSort(plan)[0].map(a => a.id)).toEqual(['MAZE']);
    });

    it('releases one node and keeps ordering the rest', () => {
        const plan = [
            { id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }, { id: 'C', dependsOn: ['A', 'B'] },
        ] as unknown as Assignment[];
        const layers = topoSort(plan).map(l => l.map(a => a.id));
        expect(layers).toEqual([['A'], ['B'], ['C']]);
    });
});

describe('orderBranchLayers', () => {
    it('dispatches a branch only after every branch it depends on', () => {
        const injected = injectScaffoldDependencies(sessionFourPlan());
        const layers = orderBranchLayers(injected, branch);
        const layerOf = (name: string) => layers.findIndex(l => l.some(a => a.branchName === name));

        expect(layerOf('chore/scaffold')).toBe(0);
        for (const dep of ['feature/us-001-maze', 'feature/us-002-loop', 'feature/us-005-ghosts',
            'feature/us-008-collision', 'feature/us-012-levels', 'feature/us-015-audio']) {
            expect(layerOf(dep)).toBeLessThan(layerOf('feature/us-017-ui'));
        }
        expect(layerOf('feature/us-001-maze')).toBeLessThan(layerOf('feature/us-002-loop'));
        expect(layers.flat()).toHaveLength(23);
    });

    it('always dispatches root (scaffold) branches first, even when they depend on features', () => {
        const plan = [
            { id: 'S', branchName: 'chore/scaffold', dependsOn: ['F'] },
            { id: 'F', branchName: 'feature/x', dependsOn: ['S'] },
        ] as unknown as Assignment[];
        const layers = orderBranchLayers(plan, branch, new Set(), b => b === 'chore/scaffold');
        expect(layers.map(l => l.map(a => a.id))).toEqual([['S'], ['F']]);
    });

    it('ignores dependencies on already-completed work', () => {
        const plan = sessionFourPlan().filter(a => !branch(a).startsWith('chore/'));
        const done = new Set(['A001', 'A002', 'A003']);
        const layers = orderBranchLayers(plan, branch, done);
        expect(layers[0].every(a => ['feature/us-001-maze', 'feature/us-015-audio'].includes(branch(a)))).toBe(true);
    });
});
