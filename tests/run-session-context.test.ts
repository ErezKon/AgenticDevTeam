/**
 * HITL sessions re-enter their RunContext.
 *
 * `session.resume()` / `session.getState()` are called by the CLI loop and the
 * REST API outside the AsyncLocalStorage scope the session was created in.
 * Before the fix every per-run singleton (run.log, ledger, response log, token
 * tracker, debug trace) silently fell back to its uninitialised module default
 * after the first approval.
 */
import { getRunContext } from '../src/utils/run-context';

jest.mock('../src/utils/logger');

const mockSeenContextIds: Array<string | undefined> = [];
const mockConductor = {
    invoke: jest.fn(async () => { mockSeenContextIds.push(getRunContext()?.id); return {}; }),
    getState: jest.fn(async () => { mockSeenContextIds.push(getRunContext()?.id); return { values: { phase: 'architect' } }; }),
    updateState: jest.fn(async () => { mockSeenContextIds.push(getRunContext()?.id); }),
};
jest.mock('../src/conductor/graph', () => ({ createConductor: jest.fn(() => mockConductor) }));

import { runHumanInTheLoop } from '../src/conductor/run';

describe('HITL RunSession', () => {
    it('runs getState() and resume() inside the RunContext the session was created in', async () => {
        const session = await runHumanInTheLoop({ systemName: 'ctx-test', requirementsText: 'Build it' });
        expect(getRunContext()).toBeUndefined();

        mockSeenContextIds.length = 0;
        await session.getState();
        await session.resume('approve');

        expect(mockSeenContextIds.length).toBeGreaterThanOrEqual(3);
        expect(mockSeenContextIds.every(id => id === session.threadId)).toBe(true);
        expect(getRunContext()).toBeUndefined();
    });
});
