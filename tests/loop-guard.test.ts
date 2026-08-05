/**
 * Tool loop guard — unit tests for non-consecutive repeat detection,
 * result caching, mutating-tool cache invalidation, and maxToolCalls poisoning.
 *
 * Test plan from Sub-Plan 4:
 * 1. Tool A(X), then B, then A(X) again → 2nd A returns CACHED, underlying tool ran once.
 * 2. A third A(X) → all subsequent calls to any tool return TERMINATED poison.
 * 3. write_file between two identical read_file calls → 2nd read re-executes (no cache, no warning).
 * 4. Exceeding maxToolCalls poisons.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { withLoopGuard } from '../src/agents/_shared/tool-loop-guard';

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

/** Track how many times the underlying tool function actually ran. */
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
    it('returns CACHED on non-consecutive duplicate read_file call and the underlying tool ran only once', async () => {
        const readFile = makeMockTool('read_file', 'file-contents-here');
        const listDir = makeMockTool('list_dir', 'dir-listing');

        const guarded = withLoopGuard([readFile.tool, listDir.tool], 'test-agent');
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedList = guarded.find(t => t.name === 'list_dir')!;

        // Call A (read_file with path X) → runs (count=1, below threshold)
        const r1 = await guardedRead.invoke({ path: 'src/index.ts' });
        expect(r1).toBe('file-contents-here');
        expect(readFile.getExecCount()).toBe(1);

        // Call B (list_dir with path Y) → runs (different tool, non-consecutive)
        const r2 = await guardedList.invoke({ path: 'src' });
        expect(r2).toBe('dir-listing');

        // Call A again (same read_file, same args) → count=2 >= MAX(2), returns CACHED
        const r3 = await guardedRead.invoke({ path: 'src/index.ts' });
        expect(typeof r3).toBe('string');
        expect(r3).toContain('CACHED');
        expect(r3).toContain('file-contents-here');
        // Underlying tool should have only run once
        expect(readFile.getExecCount()).toBe(1);
    });

    it('poisons all tools after MAX_REPEATED_TOOL_CALLS + LOOP_TOLERANCE identical calls', async () => {
        const readFile = makeMockTool('read_file', 'file-contents');
        const listDir = makeMockTool('list_dir', 'listing');

        const guarded = withLoopGuard([readFile.tool, listDir.tool], 'test-agent');
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedList = guarded.find(t => t.name === 'list_dir')!;

        const args = { path: 'src/index.ts' };

        // 1st call: runs normally (count=1)
        await guardedRead.invoke(args);
        expect(readFile.getExecCount()).toBe(1);

        // Interleave a different tool so calls are non-consecutive
        await guardedList.invoke({ path: 'tests' });

        // 2nd call (count=2, at MAX_REPEATED_TOOL_CALLS threshold): returns CACHED
        const r2 = await guardedRead.invoke(args);
        expect(r2).toContain('CACHED');
        expect(readFile.getExecCount()).toBe(1);

        // 3rd call (count=3, at MAX + LOOP_TOLERANCE): poisons all tools
        const r3 = await guardedRead.invoke(args);
        expect(r3).toContain('TERMINATED');

        // Any subsequent call to ANY tool returns the poison message
        const r4 = await guardedList.invoke({ path: 'src' });
        expect(r4).toContain('TERMINATED');
    });

    it('clears cache and counts after a mutating tool — second read_file re-executes normally', async () => {
        const readFile = makeMockTool('read_file', 'original-content');
        const writeFile = makeMockTool('write_file', 'written');

        const guarded = withLoopGuard([readFile.tool, writeFile.tool], 'test-agent');
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedWrite = guarded.find(t => t.name === 'write_file')!;

        const readArgs = { path: 'src/index.ts' };

        // 1st read: runs normally (count=1)
        const r1 = await guardedRead.invoke(readArgs);
        expect(r1).toBe('original-content');
        expect(readFile.getExecCount()).toBe(1);

        // Mutating tool: clears both counts and cache
        await guardedWrite.invoke({ path: 'src/index.ts' });

        // 2nd read after mutation: re-executes (count reset to 0, now count=1 again)
        const r2 = await guardedRead.invoke(readArgs);
        expect(r2).toBe('original-content');
        expect(readFile.getExecCount()).toBe(2);
    });

    it('still detects a repeated IDENTICAL mutating call (write_file loop)', async () => {
        const writeFile = makeMockTool('write_file', 'written');
        const readFile = makeMockTool('read_file', 'content');

        const guarded = withLoopGuard([writeFile.tool, readFile.tool], 'test-agent');
        const guardedWrite = guarded.find(t => t.name === 'write_file')!;

        const args = { path: 'src/index.ts' };

        // 1st write: runs
        await guardedWrite.invoke(args);
        expect(writeFile.getExecCount()).toBe(1);

        // 2nd identical write: warned, not executed (clearing counts on a
        // mutation must not erase the mutating call's own count)
        const r2 = await guardedWrite.invoke(args);
        expect(JSON.parse(r2 as string).error).toContain('same arguments');
        expect(writeFile.getExecCount()).toBe(1);
    });

    it('poisons when exceeding maxToolCalls total ceiling', async () => {
        const toolA = makeMockTool('read_file', 'a-result');
        const toolB = makeMockTool('list_dir', 'b-result');

        // Very low ceiling: 3 total calls
        const guarded = withLoopGuard([toolA.tool, toolB.tool], 'test-agent', 3);
        const guardedA = guarded.find(t => t.name === 'read_file')!;
        const guardedB = guarded.find(t => t.name === 'list_dir')!;

        // Calls 1-3: succeed (each with different args to avoid repeat detection)
        await guardedA.invoke({ path: 'a' });
        await guardedB.invoke({ path: 'b' });
        await guardedA.invoke({ path: 'c' });

        // Call 4: exceeds the ceiling → poisoned
        const r4 = await guardedB.invoke({ path: 'd' });
        expect(r4).toContain('TERMINATED');

        // Any further call also returns poison
        const r5 = await guardedA.invoke({ path: 'e' });
        expect(r5).toContain('TERMINATED');
    });

    it('run_command clears result cache but not call counts', async () => {
        const readFile = makeMockTool('read_file', 'content');
        const runCmd = makeMockTool('run_command', 'cmd-output');

        const guarded = withLoopGuard([readFile.tool, runCmd.tool], 'test-agent');
        const guardedRead = guarded.find(t => t.name === 'read_file')!;
        const guardedCmd = guarded.find(t => t.name === 'run_command')!;

        const readArgs = { path: 'src/index.ts' };

        // 1st read: runs normally, result cached (count=1)
        const r1 = await guardedRead.invoke(readArgs);
        expect(r1).toBe('content');
        expect(readFile.getExecCount()).toBe(1);

        // run_command: clears result cache but NOT call counts
        await guardedCmd.invoke({ path: 'npm test' });

        // 2nd read: count=2 >= MAX(2), triggers warning.
        // Cache was cleared by run_command, so no cached result available.
        // Returns the loop-breaking error JSON instead.
        const r2 = await guardedRead.invoke(readArgs);
        const parsed = JSON.parse(r2 as string);
        expect(parsed.error).toContain('same arguments');
        // Underlying tool should NOT have re-executed
        expect(readFile.getExecCount()).toBe(1);
    });
});
