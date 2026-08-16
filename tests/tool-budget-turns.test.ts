/**
 * Tool budget — turn accounting, category isolation, pressure footer and
 * forced termination (Plan 22, A1–A4).
 *
 * The pacmanclaude run proved the old flat call ceiling is denominated in the
 * wrong unit: `principal-frontend` batched 9–11 tool calls into a single turn and
 * so spent a 26-unit budget in 5 turns, after which it could not write at all.
 * These tests pin the three properties that prevent a repeat:
 *
 *   1. N parallel calls in one turn cost N read units but only ONE turn.
 *   2. An exhausted read budget never blocks writes.
 *   3. An agent that keeps calling tools after exhaustion has termination demanded.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { withLoopGuard, ToolBudgetExhaustedError } from '../src/agents/_shared/tool-loop-guard';

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockTool(name: string, result = `${name}-ok`) {
    let calls = 0;
    const t = tool(async (_args: Record<string, any>) => { calls++; return result; }, {
        name,
        description: `Mock ${name}`,
        schema: z.object({ path: z.string().optional() }),
    });
    return { tool: t, calls: () => calls };
}

/**
 * A RunnableConfig shaped like the one LangGraph passes to a tool. All calls made
 * by one model turn share the same `langgraph_step`.
 */
function turnConfig(step: number) {
    return { metadata: { langgraph_step: step } };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('turn accounting (Plan 22 A2)', () => {
    it('charges 11 parallel calls in one turn as 11 reads but only 1 turn', async () => {
        const read = mockTool('read_file', 'contents');
        const { tools, getUsage } = withLoopGuard([read.tool], 'principal-frontend', {
            budgets: { reads: 60, writes: 30, shell: 14, turns: 28 },
        });
        const guarded = tools[0];

        // This is exactly what dump 020 of the pacmanclaude run did.
        for (let i = 0; i < 11; i++) {
            await guarded.invoke({ path: `src/f${i}.ts` }, turnConfig(7) as any);
        }

        const usage = getUsage();
        expect(usage.reads).toBe(11);
        expect(usage.turns).toBe(1);
    });

    it('counts a new turn for each distinct langgraph_step', async () => {
        const read = mockTool('read_file');
        const { tools, getUsage } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 60, writes: 30, shell: 14, turns: 28 },
        });
        const guarded = tools[0];

        for (const step of [1, 1, 2, 2, 2, 3]) {
            await guarded.invoke({ path: `f-${step}-${Math.random()}` }, turnConfig(step) as any);
        }

        expect(getUsage().turns).toBe(3);
        expect(getUsage().reads).toBe(6);
    });

    it('exhausts on the turn ceiling even when categories have budget left', async () => {
        const read = mockTool('read_file');
        const { tools, isCeilingReached, getUsage } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 100, writes: 100, shell: 100, turns: 3 },
        });
        const guarded = tools[0];

        for (const step of [1, 2, 3]) {
            await guarded.invoke({ path: `f${step}` }, turnConfig(step) as any);
        }
        expect(isCeilingReached()).toBe(true);

        const blocked = await guarded.invoke({ path: 'f4' }, turnConfig(4) as any);
        expect(blocked).toContain('BUDGET EXHAUSTED');
        // Categories were nowhere near exhausted — turns were the binding constraint.
        expect(getUsage().reads).toBeLessThan(10);
    });

    it('falls back to time-window batching when no turn key is available', async () => {
        const read = mockTool('read_file');
        const { tools, getUsage } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 60, writes: 30, shell: 14, turns: 28 },
        });
        const guarded = tools[0];

        // No config → parallel calls arriving together must still be one turn.
        await Promise.all([
            guarded.invoke({ path: 'a' }),
            guarded.invoke({ path: 'b' }),
            guarded.invoke({ path: 'c' }),
        ]);

        expect(getUsage().reads).toBe(3);
        expect(getUsage().turns).toBe(1);
    });
});

describe('category isolation (Plan 22 A1)', () => {
    it('lets a read-exhausted agent still write — the pacmanclaude failure', async () => {
        const read = mockTool('read_file', 'contents');
        const write = mockTool('write_file', 'written');
        const { tools } = withLoopGuard([read.tool, write.tool], 'dev', {
            budgets: { reads: 2, writes: 5, shell: 2, turns: 28 },
            progressBonus: 0,
        });
        const guardedRead = tools.find(t => t.name === 'read_file')!;
        const guardedWrite = tools.find(t => t.name === 'write_file')!;

        await guardedRead.invoke({ path: 'a' }, turnConfig(1) as any);
        await guardedRead.invoke({ path: 'b' }, turnConfig(1) as any);

        const denied = await guardedRead.invoke({ path: 'c' }, turnConfig(2) as any);
        expect(JSON.parse(denied as string).error).toContain('read tool budget is exhausted');

        // The whole point: writes survive an exhausted read pool.
        const written = await guardedWrite.invoke({ path: 'src/x.ts' }, turnConfig(2) as any);
        expect(written).toContain('written');
        expect(write.calls()).toBe(1);
    });
});

describe('budget pressure footer (Plan 22 A3)', () => {
    it('stays silent below 60% usage', async () => {
        const read = mockTool('read_file', 'contents');
        const { tools } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 10, writes: 10, shell: 10, turns: 20 },
        });
        const r = await tools[0].invoke({ path: 'a' }, turnConfig(1) as any);
        expect(r).toBe('contents');
    });

    it('warns at 60% and escalates to CRITICAL at 85%', async () => {
        const read = mockTool('read_file', 'contents');
        const { tools } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 10, writes: 10, shell: 10, turns: 100 },
            progressBonus: 0,
        });
        const guarded = tools[0];

        let last = '';
        for (let i = 0; i < 7; i++) {
            last = String(await guarded.invoke({ path: `f${i}` }, turnConfig(i) as any));
        }
        expect(last).toContain('[BUDGET:');
        expect(last).toContain('stop exploring and start writing files');

        for (let i = 7; i < 10; i++) {
            last = String(await guarded.invoke({ path: `f${i}` }, turnConfig(i) as any));
        }
        expect(last).toContain('[BUDGET CRITICAL:');
    });
});

describe('forced termination (Plan 22 A4)', () => {
    it('demands termination after MAX_POST_EXHAUSTION_CALLS guidance responses', async () => {
        const read = mockTool('read_file');
        const { tools, isTerminationDemanded } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 1, writes: 0, shell: 0, turns: 50 },
            maxPostExhaustionCalls: 2,
        });
        const guarded = tools[0];

        await guarded.invoke({ path: 'a' }, turnConfig(1) as any);
        expect(isTerminationDemanded()).toBe(false);

        // 1st guidance response
        expect(await guarded.invoke({ path: 'b' }, turnConfig(2) as any)).toContain('BUDGET EXHAUSTED');
        expect(isTerminationDemanded()).toBe(false);

        // 2nd guidance response — the agent has ignored the budget twice.
        expect(await guarded.invoke({ path: 'c' }, turnConfig(3) as any)).toContain('BUDGET EXHAUSTED');
        expect(isTerminationDemanded()).toBe(true);
    });

    it('assertNotExhausted throws ToolBudgetExhaustedError once exhausted', async () => {
        const read = mockTool('read_file');
        const { tools, assertNotExhausted } = withLoopGuard([read.tool], 'dev', {
            budgets: { reads: 1, writes: 0, shell: 0, turns: 50 },
        });

        expect(() => assertNotExhausted()).not.toThrow();
        await tools[0].invoke({ path: 'a' }, turnConfig(1) as any);
        expect(() => assertNotExhausted()).toThrow(ToolBudgetExhaustedError);
    });

    it('reports usage on the thrown error', async () => {
        const read = mockTool('read_file');
        const { tools, assertNotExhausted } = withLoopGuard([read.tool], 'agent-x', {
            budgets: { reads: 1, writes: 0, shell: 0, turns: 50 },
        });
        await tools[0].invoke({ path: 'a' }, turnConfig(1) as any);

        try {
            assertNotExhausted();
            throw new Error('expected throw');
        } catch (err: any) {
            expect(err).toBeInstanceOf(ToolBudgetExhaustedError);
            expect(err.usage.reads).toBe(1);
            expect(err.message).toContain('agent-x');
        }
    });
});
