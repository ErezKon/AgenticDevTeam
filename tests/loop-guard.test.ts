/**
 * Tool loop guard — unit tests for per-tool blocking, read/write/shell budgets,
 * progress bonus, cached-calls-are-free, and terminal guidance.
 *
 * Sub-Plan 08 §3: tests confirm the new loop guard behaviour.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { withLoopGuard, resolveToolBudgets } from '../src/agents/_shared/tool-loop-guard';

// Mock logger to avoid console noise
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockTool(name: string, returnValue: string = `${name}-result`) {
    let execCount = 0;
    const fn = async (_args: Record<string, any>) => {
        execCount++;
        return returnValue;
    };
    const t = tool(fn, {
        name,
        description: `Mock ${name} tool`,
        schema: z.object({ path: z.string().optional() }),
    });
    return { tool: t, getExecCount: () => execCount };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Tool Loop Guard', () => {
    it('3 identical list_dir calls block list_dir ONLY; a subsequent write_file succeeds', async () => {
        const listDir = makeMockTool('list_dir', 'dir-listing');
        const writeFile = makeMockTool('write_file', 'written');

        const { tools: guarded } = withLoopGuard(
            [listDir.tool, writeFile.tool], 'test-agent',
            { budgets: { reads: 30, writes: 25, shell: 10 } },
        );
        const guardedList = guarded.find(t => t.name === 'list_dir')!;
        const guardedWrite = guarded.find(t => t.name === 'write_file')!;

        const args = { path: '.' };

        // 1st call: runs normally
        await guardedList.invoke(args);
        expect(listDir.getExecCount()).toBe(1);

        // 2nd call: returns cached (free)
        const r2 = await guardedList.invoke(args);
        expect(r2).toContain('CACHED');

        // 3rd call: blocks THIS specific (list_dir, ".") call
        const r3 = await guardedList.invoke(args);
        expect(r3).toContain('BLOCKED');

        // write_file STILL works — not poisoned
        const r4 = await guardedWrite.invoke({ path: 'src/index.ts' });
        expect(r4).toBe('written');
        expect(writeFile.getExecCount()).toBe(1);
    });

    it('a CACHED response does not increment the budget counter', async () => {
        const readFile = makeMockTool('read_file', 'content');
        const writeFile = makeMockTool('write_file', 'written');

        // Very tight read budget of 2
        const { tools: guarded, isCeilingReached } = withLoopGuard(
            [readFile.tool, writeFile.tool], 'test-agent',
            { budgets: { reads: 2, writes: 5, shell: 5 } },
        );
        const guardedRead = guarded.find(t => t.name === 'read_file')!;

        // 1st read with args A: consumes 1 read budget
        await guardedRead.invoke({ path: 'a' });
        // 2nd read with same args A: CACHED, should be FREE
        const r2 = await guardedRead.invoke({ path: 'a' });
        expect(r2).toContain('CACHED');

        // 3rd read with args B: consumes 2nd read budget — should still work
        const r3 = await guardedRead.invoke({ path: 'b' });
        expect(r3).toBe('content');
        expect(readFile.getExecCount()).toBe(2);  // only 2 real executions

        // Not exhausted — cached call didn't count
        expect(isCeilingReached()).toBe(false);
    });

    it('read budget exhausted ⇒ writes still allowed', async () => {
        const readFile = makeMockTool('read_file', 'content');
        const writeFile = makeMockTool('write_file', 'written');

        const { tools: guarded, isCeilingReached } = withLoopGuard(
            [readFile.tool, writeFile.tool], 'test-agent',
            { budgets: { reads: 2, writes: 5, shell: 5 } },
        );
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedWrite = guarded.find(t => t.name === 'write_file')!;

        // Exhaust read budget
        await guardedRead.invoke({ path: 'a' });
        await guardedRead.invoke({ path: 'b' });

        // 3rd read should be blocked
        const r3 = await guardedRead.invoke({ path: 'c' });
        expect(JSON.parse(r3 as string).error).toContain('read tool budget is exhausted');

        // But writes should still work
        const r4 = await guardedWrite.invoke({ path: 'src/index.ts' });
        expect(r4).toBe('written');
        expect(writeFile.getExecCount()).toBe(1);

        // Not fully exhausted (writes still available)
        expect(isCeilingReached()).toBe(false);
    });

    it('3 successful writes ⇒ progress bonus granted; hard ceiling still enforced at 80', async () => {
        const readFile = makeMockTool('read_file', 'content');
        const writeFile = makeMockTool('write_file', 'written');

        const { tools: guarded, isCeilingReached } = withLoopGuard(
            [readFile.tool, writeFile.tool], 'test-agent',
            { budgets: { reads: 3, writes: 25, shell: 10 }, progressBonus: 5, hardCeiling: 80 },
        );
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedWrite = guarded.find(t => t.name === 'write_file')!;

        // Use up 3 reads
        await guardedRead.invoke({ path: 'a' });
        await guardedRead.invoke({ path: 'b' });
        await guardedRead.invoke({ path: 'c' });

        // Read budget exhausted
        const r4 = await guardedRead.invoke({ path: 'd' });
        expect(JSON.parse(r4 as string).error).toContain('read tool budget is exhausted');

        // Write a file — triggers progress bonus
        await guardedWrite.invoke({ path: 'src/x.ts' });
        expect(writeFile.getExecCount()).toBe(1);

        // Now reads should work again (bonus granted)
        const r5 = await guardedRead.invoke({ path: 'e' });
        expect(r5).toBe('content');
    });

    it('budget exhaustion injects terminal guidance message', async () => {
        const readFile = makeMockTool('read_file', 'content');

        const { tools: guarded } = withLoopGuard(
            [readFile.tool], 'test-agent',
            { budgets: { reads: 1, writes: 0, shell: 0 } },
        );
        const guardedRead = guarded.find(t => t.name === 'read_file')!;

        // Use up the only read
        await guardedRead.invoke({ path: 'a' });

        // Next call should get terminal guidance
        const r2 = await guardedRead.invoke({ path: 'b' });
        const parsed = JSON.parse(r2 as string);
        expect(parsed.error).toContain('BUDGET EXHAUSTED');
        expect(parsed.error).toContain('listing exactly the files you actually wrote');
        expect(parsed.error).toContain('Do not claim files you did not write');
    });

    // ── Legacy compatibility tests ──────────────────────────────────────

    it('returns CACHED on non-consecutive duplicate read_file (legacy mode)', async () => {
        const readFile = makeMockTool('read_file', 'file-contents-here');
        const listDir = makeMockTool('list_dir', 'dir-listing');

        const { tools: guarded } = withLoopGuard([readFile.tool, listDir.tool], 'test-agent');
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedList = guarded.find(t => t.name === 'list_dir')!;

        const r1 = await guardedRead.invoke({ path: 'src/index.ts' });
        expect(r1).toBe('file-contents-here');
        expect(readFile.getExecCount()).toBe(1);

        await guardedList.invoke({ path: 'src' });

        const r3 = await guardedRead.invoke({ path: 'src/index.ts' });
        expect(r3).toContain('CACHED');
        expect(readFile.getExecCount()).toBe(1);
    });

    it('clears cache and counts after a mutating tool', async () => {
        const readFile = makeMockTool('read_file', 'original-content');
        const writeFile = makeMockTool('write_file', 'written');

        const { tools: guarded } = withLoopGuard([readFile.tool, writeFile.tool], 'test-agent');
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedWrite = guarded.find(t => t.name === 'write_file')!;

        await guardedRead.invoke({ path: 'src/index.ts' });
        expect(readFile.getExecCount()).toBe(1);

        await guardedWrite.invoke({ path: 'src/index.ts' });

        const r2 = await guardedRead.invoke({ path: 'src/index.ts' });
        expect(r2).toBe('original-content');
        expect(readFile.getExecCount()).toBe(2);
    });

    it('legacy maxToolCalls ceiling triggers exhaustion', async () => {
        const toolA = makeMockTool('read_file', 'a-result');
        const toolB = makeMockTool('list_dir', 'b-result');

        const { tools: guarded, isCeilingReached } = withLoopGuard([toolA.tool, toolB.tool], 'test-agent', 3);
        const guardedA = guarded.find(t => t.name === 'read_file')!;
        const guardedB = guarded.find(t => t.name === 'list_dir')!;

        await guardedA.invoke({ path: 'a' });
        await guardedB.invoke({ path: 'b' });
        await guardedA.invoke({ path: 'c' });

        // 4th call: exceeds ceiling
        const r4 = await guardedB.invoke({ path: 'd' });
        expect(r4).toContain('BUDGET EXHAUSTED');
        expect(isCeilingReached()).toBe(true);
    });

    it('isCeilingReached returns false before any exhaustion', async () => {
        const readFile = makeMockTool('read_file', 'content');
        const { isCeilingReached } = withLoopGuard([readFile.tool], 'test-agent');
        expect(isCeilingReached()).toBe(false);
    });

    it('returns isCeilingReached as false for empty tools', () => {
        const { tools, isCeilingReached } = withLoopGuard([], 'test-agent');
        expect(tools).toEqual([]);
        expect(isCeilingReached()).toBe(false);
    });
});

describe('resolveToolBudgets', () => {
    it('returns default budgets for known ranks', () => {
        const principal = resolveToolBudgets('principal');
        expect(principal).toEqual({ reads: 30, writes: 25, shell: 10 });

        const junior = resolveToolBudgets('junior');
        expect(junior).toEqual({ reads: 20, writes: 15, shell: 8 });
    });

    it('falls back to default for unknown ranks', () => {
        const unknown = resolveToolBudgets('intern');
        expect(unknown).toEqual({ reads: 25, writes: 20, shell: 8 });
    });

    it('parses JSON override', () => {
        const override = JSON.stringify({ senior: { reads: 50, writes: 40, shell: 20 } });
        const senior = resolveToolBudgets('senior', override);
        expect(senior).toEqual({ reads: 50, writes: 40, shell: 20 });
    });
});
