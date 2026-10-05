/**
 * Plan 30-02 step 3 — never discard valid output (pr/agent-invoke.ts).
 *
 * Crossing MAX_INVOCATION_INPUT_TOKENS after valid output returns that output
 * with `budgetCapped: true` and does not respawn; InvocationBudgetExceededError
 * is thrown only when no generation produced valid output, and it is never
 * retried as a rate limit. In the claudeopus5 run ASSIGN-021 finished with
 * 134/134 tests passing and valid JSON, and its output was thrown away.
 */
jest.mock('../src/utils/logger');
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    MAX_INVOCATION_INPUT_TOKENS: 600_000,
    AGENT_RESPAWN_ENABLED: true,
    AGENT_RESPAWN_MAX_GENERATIONS: 2,
}));
/** Input tokens the tracker reports for the invocation, one value per ceiling check. */
const mockSpent: { values: number[] } = { values: [] };
jest.mock('../src/utils/token-tracker', () => ({
    tokenTracker: {
        startInvocation: () => 'inv-test',
        endInvocation: () => undefined,
        markBudgetCapped: () => undefined,
        getInvocationInputTokens: () => (mockSpent.values.length > 1 ? mockSpent.values.shift()! : mockSpent.values[0] ?? 0),
    },
}));
jest.mock('../src/utils/response-log', () => ({ logAgentResponse: () => undefined }));
jest.mock('../src/conductor/agent-respawn', () => ({
    buildHandoff: () => ({ filesWritten: ['src/a.ts'], filesRead: [], worktreeVerified: false }),
    renderHandoff: () => 'handoff',
    madeProgress: () => true,
}));

import { invokeDevAgent } from '../src/conductor/pr/agent-invoke';
import { InvocationBudgetExceededError } from '../src/utils/run-budget';

const VALID = JSON.stringify({
    fileChanges: [{ path: 'src/a.ts', action: 'created', summary: 'storage service', storyId: 'US-027', agentId: 'junior-angular' }],
    notes: '134/134 tests passing',
});

/** A built agent whose single invoke() returns `content` (null = no messages at all). */
function fakeAgent(content: string | null, toolCeilingHit = false) {
    return {
        invoke: jest.fn(async () => ({ messages: content === null ? [] : [{ type: 'ai', content }] })),
        setInvocationId: jest.fn(),
        isCeilingReached: () => toolCeilingHit,
        getToolUsage: () => ({ reads: 3, writes: 2, shell: 1, turns: 4 }),
        systemPromptText: 'system',
    };
}

const invoke = (agent: ReturnType<typeof fakeAgent>, build?: () => any) =>
    invokeDevAgent(agent, 'task', 'thread', 'junior-angular', 'claude-haiku-4-5', build, { worktreeDir: '/tmp', baseRef: 'origin/main' });

beforeEach(() => { mockSpent.values = []; });

describe('invokeDevAgent — invocation ceiling (Plan 30-02)', () => {
    it('under the ceiling, returns the output normally', async () => {
        mockSpent.values = [120_000];
        const res = await invoke(fakeAgent(VALID));
        expect(res.budgetCapped).toBe(false);
        expect(res.output.fileChanges.map(fc => fc.path)).toEqual(['src/a.ts']);
    });

    it('over the ceiling with valid output: returns it budget-capped and does not respawn', async () => {
        mockSpent.values = [727_000];
        const agent = fakeAgent(VALID, true);   // the tool ceiling alone would trigger a respawn
        const build = jest.fn(() => fakeAgent(VALID));

        const res = await invoke(agent, build);

        expect(res.budgetCapped).toBe(true);
        expect(res.output.notes).toBe('134/134 tests passing');
        expect(build).not.toHaveBeenCalled();
        expect(agent.invoke).toHaveBeenCalledTimes(1);
    });

    it('over the ceiling without any output: throws InvocationBudgetExceededError', async () => {
        mockSpent.values = [650_000];
        await expect(invoke(fakeAgent(null), jest.fn())).rejects.toBeInstanceOf(InvocationBudgetExceededError);
    });

    it('over the ceiling with unparseable output: throws InvocationBudgetExceededError, not a parse error', async () => {
        mockSpent.values = [650_000];
        await expect(invoke(fakeAgent('I am done, see the files.'))).rejects.toBeInstanceOf(InvocationBudgetExceededError);
    });

    it('keeps an earlier generation\'s valid output when a respawn crosses the ceiling without any', async () => {
        mockSpent.values = [300_000, 700_000];
        const gen0 = fakeAgent(VALID, true);
        const gen1 = fakeAgent(null);
        const build = jest.fn(() => gen1);

        const res = await invoke(gen0, build);

        expect(build).toHaveBeenCalledTimes(1);
        expect(gen1.invoke).toHaveBeenCalledTimes(1);
        expect(res.budgetCapped).toBe(true);
        expect(res.output.fileChanges.map(fc => fc.path)).toEqual(['src/a.ts']);
    });

    it('is not retried as a rate limit when its token count contains "429"', async () => {
        mockSpent.values = [1_429_881];
        const agent = fakeAgent(null);
        await expect(invoke(agent)).rejects.toBeInstanceOf(InvocationBudgetExceededError);
        expect(agent.invoke).toHaveBeenCalledTimes(1);
    });

    it('a soft landing is final: the output is kept budget-capped and nothing respawns (Plan 30-06)', async () => {
        mockSpent.values = [180_000];                               // under the raw backstop
        const landed = { ...fakeAgent(VALID, true), softLanding: () => 'effective-token budget spent' };
        const build = jest.fn(() => fakeAgent(VALID));

        const res = await invoke(landed, build);

        expect(res.budgetCapped).toBe(true);
        expect(res.output.notes).toBe('134/134 tests passing');
        expect(build).not.toHaveBeenCalled();                      // the tool ceiling alone would have respawned
    });
});
