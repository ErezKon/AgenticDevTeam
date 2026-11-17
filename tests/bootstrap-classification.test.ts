/**
 * Plan 30-J: bootstrap detection must not promote integration work.
 *
 * pacman-live-analysis-3: ASSIGN-023 ("… only add styles/attributes/toggle wiring",
 * dependsOn ASSIGN-022) matched the `wiring` keyword, its branch (holding the
 * 18-dependency integration assignment ASSIGN-022) ran right after the scaffold, and
 * the injected bootstrap edges created dependency cycles.
 */
import {
    injectBootstrapDependencies, injectScaffoldDependencies, isBootstrapAssignment, isBootstrapBranch, topoSort,
} from '../src/agents/developers/dispatcher';
import type { Assignment } from '../src/agents/_shared/base-schemas';

jest.mock('../src/utils/logger');

function a(id: string, over: Partial<Assignment> = {}): Assignment {
    return {
        id, taskId: `T-${id}`, storyId: 'US-001', devAgentId: 'senior-frontend',
        branchName: 'app/feature/us-001', dependsOn: [], taskType: 'feature',
        description: '', reviewerAgentIds: [], ...over,
    } as unknown as Assignment;
}

/** The session-3 plan shape: scaffold, features, integration, final a11y pass. */
function sessionThreePlan(): Assignment[] {
    return [
        a('S1', { taskType: 'chore', branchName: 'app/chore/scaffold', description: 'create src/main.ts (bootstrap)' }),
        a('F1', { branchName: 'app/feature/us-001-maze' }),
        a('F2', { branchName: 'app/feature/us-004-ghosts', dependsOn: ['F1'] }),
        a('INT', { branchName: 'app/feature/us-034-integration', dependsOn: ['F1', 'F2'], description: 'Wire everything into the app shell' }),
        a('A11Y', { branchName: 'app/feature/us-034-integration', dependsOn: ['INT'], description: 'only add styles/attributes/toggle wiring' }),
    ];
}

describe('isBootstrapAssignment', () => {
    it('rejects keyword matches that depend on feature work (integration, not bootstrap)', () => {
        const plan = sessionThreePlan();
        expect(isBootstrapAssignment(plan[4], plan)).toBe(false);
    });

    it('still accepts genuine bootstrap work that depends only on the scaffold', () => {
        const plan = [...sessionThreePlan(), a('BOOT', { dependsOn: ['S1'], description: 'Set up the composition root' })];
        expect(isBootstrapAssignment(plan[5], plan)).toBe(true);
        expect(isBootstrapAssignment(a('X', { moduleIds: ['MOD-MAIN'] } as Partial<Assignment>), plan)).toBe(true);
    });

    it('never classifies scaffold assignments as bootstrap', () => {
        const plan = sessionThreePlan();
        expect(isBootstrapAssignment(plan[0], plan)).toBe(false);
    });
});

describe('isBootstrapBranch with the full plan', () => {
    it('does not promote the integration branch', () => {
        const plan = sessionThreePlan();
        const branch = plan.filter(x => x.branchName === 'app/feature/us-034-integration');
        expect(isBootstrapBranch('app/feature/us-034-integration', branch, plan)).toBe(false);
    });
});

describe('injectBootstrapDependencies', () => {
    it('injects nothing for the session-3 plan, so the integration branch is ordered last', () => {
        const plan = injectScaffoldDependencies(sessionThreePlan());
        const injected = injectBootstrapDependencies(plan);
        expect(injected).toEqual(plan);

        const layers = topoSort(injected).map(layer => layer.map(x => x.id));
        const layerOf = (id: string) => layers.findIndex(l => l.includes(id));
        expect(layerOf('S1')).toBeLessThan(layerOf('F1'));
        expect(layerOf('F2')).toBeLessThan(layerOf('INT'));
        expect(layerOf('INT')).toBeLessThan(layerOf('A11Y'));
    });

    it('makes features depend on a genuine bootstrap without creating cycles', () => {
        const plan = injectScaffoldDependencies([
            ...sessionThreePlan(),
            a('BOOT', { branchName: 'app/feature/bootstrap', description: 'App initialization and wiring of providers' }),
        ]);
        const injected = injectBootstrapDependencies(plan);
        expect(injected.find(x => x.id === 'F1')!.dependsOn).toContain('BOOT');
        expect(injected.find(x => x.id === 'BOOT')!.dependsOn).not.toContain('F1');
        expect(topoSort(injected).flat().map(x => x.id)).toHaveLength(injected.length);
    });
});
