/**
 * Plan 30-K: a strict dispatch halt ends the run.
 *
 * claudeopus5: the dispatcher halted on blocked PR #2, but developmentNode returned
 * normally, so QA synthesised 63 bugs and bug-fix rounds re-dispatched the same
 * blocked branch twice more. The halt now sets cancelled + _stopReason, which every
 * router sends to finalize.
 */
import { makeState } from './helpers/state-factory';

jest.mock('../src/utils/logger');
jest.mock('../src/utils/oauth-auth.util', () => ({ getAccessToken: jest.fn(async () => 'test-key') }));
jest.mock('../src/utils/coding-conventions', () => ({
    resolveConventionFiles: jest.fn(() => []),
    deployConventionsToWorkspace: jest.fn(),
}));
jest.mock('../src/utils/workspace', () => ({
    ...jest.requireActual('../src/utils/workspace'),
    ensureProjectGitignore: jest.fn(),
}));
jest.mock('../src/utils/run-snapshot', () => ({
    ...jest.requireActual('../src/utils/run-snapshot'),
    writePeriodicSnapshot: jest.fn(),
}));
const mockShouldStopRun = jest.fn(() => false);
jest.mock('../src/utils/run-budget', () => ({
    ...jest.requireActual('../src/utils/run-budget'),
    shouldStopRun: () => mockShouldStopRun(),
    getBudgetStatus: () => ({ binding: 'cost', level: 'stop', utilisation: 1.05 }),
}));
const mockDispatch = jest.fn();
jest.mock('../src/agents/developers/dispatcher', () => ({
    ...jest.requireActual('../src/agents/developers/dispatcher'),
    dispatchDevelopers: (...args: unknown[]) => mockDispatch(...args),
}));

import { developmentNode } from '../src/conductor/nodes/development';
import { afterQaRouter } from '../src/conductor/graph';

function dispatchResult(over: Record<string, unknown>) {
    return {
        fileChanges: [], artifacts: [], transcript: [], tokenUsage: [],
        pullRequests: [{ id: 'PR-GATES-FAILED-app/feature/x', branchName: 'app/feature/x', status: 'closed' }],
        completedAssignmentIds: [], completionEvidence: [], salvageBranches: ['app/feature/x'],
        branchesDeferred: 0, providerFailureKind: null, dispatchHalt: null, ...over,
    };
}

const state = () => makeState({
    assignments: [{
        id: 'ASSIGN-001', taskId: 'TASK-001', storyId: 'US-001', devAgentId: 'senior-frontend',
        branchName: 'app/feature/x', dependsOn: [], taskType: 'feature', description: 'x', reviewerAgentIds: [],
    } as any],
    completedAssignmentIds: [],
});

describe('developmentNode stop handling', () => {
    it('ends the run on a dispatch halt instead of routing to QA', async () => {
        mockDispatch.mockResolvedValue(dispatchResult({ dispatchHalt: { branch: 'app/feature/x', status: 'closed' } }));

        const update = await developmentNode(state());

        expect(update.cancelled).toBe(true);
        expect(update._stopReason).toBe('dispatch-halted:app/feature/x');
        expect(update.pullRequests).toHaveLength(1);
        expect(afterQaRouter({ ...state(), ...update } as any)).toBe('finalize');
    });

    // Plan 30-V (pacman-live-analysis-10): the budget cut branch 7 short → was reported `failed`.
    it('reports a halt caused by the run budget as budget-exhausted', async () => {
        mockShouldStopRun.mockReturnValueOnce(true);
        mockDispatch.mockResolvedValue(dispatchResult({ dispatchHalt: { branch: 'app/feature/x', status: 'closed' } }));

        const update = await developmentNode(state());

        expect(update.cancelled).toBe(true);
        expect(update._stopReason).toBe('budget-exhausted:cost');
    });

    it('still stops on unrecoverable provider failures', async () => {
        mockDispatch.mockResolvedValue(dispatchResult({ providerFailureKind: 'billing' }));

        const update = await developmentNode(state());

        expect(update.cancelled).toBe(true);
        expect(update._stopReason).toBe('provider-billing');
    });
});
