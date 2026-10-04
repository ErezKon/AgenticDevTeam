/**
 * Agent tool calls are traced at the loop guard (DEBUG_MODE): one record per
 * call with the agent, the arguments, the result the agent saw and the budget
 * usage — while tool exceptions still propagate exactly as before.
 */
jest.mock('../src/config', () => ({ ...jest.requireActual('../src/config'), DEBUG_MODE: true }));
jest.mock('../src/utils/logger');

import * as path from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';
import { RunContext, runWithContext } from '../src/utils/run-context';
import { initDebugTrace, _resetDebugTrace } from '../src/utils/debug-trace';
import { withLoopGuard } from '../src/agents/_shared/tool-loop-guard';

const BUDGETS = { reads: 5, writes: 5, shell: 5, turns: 5 };

let outDir: string;

beforeEach(() => {
    _resetDebugTrace();
    outDir = makeTempDir('adt-tool-trace-');
});

afterEach(() => cleanupDir(outDir));

const toolRecords = () => readJsonl(path.join(outDir, 'debug', 'trace.jsonl')).filter(r => r.kind === 'tool');
const inRun = (fn: () => Promise<void>) => runWithContext(new RunContext('run-tools'), async () => {
    initDebugTrace(outDir);
    await fn();
});

function makeTool(name: string, fn: (args: { path?: string }) => Promise<string>) {
    return tool(fn, { name, description: `Mock ${name} tool`, schema: z.object({ path: z.string().optional() }) });
}

describe('loop-guard tool tracing', () => {
    it('records each guarded call with agent, args, result and budget usage', async () => {
        const readFile = makeTool('read_file', async ({ path: p }) => `body of ${p}`);

        await inRun(async () => {
            const { tools } = withLoopGuard([readFile], 'senior-backend', { budgets: BUDGETS });
            expect(await tools[0].invoke({ path: 'src/a.ts' })).toContain('body of src/a.ts');
        });

        const [record] = toolRecords();
        expect(record).toMatchObject({
            event: 'end', agentId: 'senior-backend', tool: 'read_file',
            args: { path: 'src/a.ts' }, ok: true,
            usage: { reads: 1, writes: 0, shell: 0, maxReads: 5 },
        });
        expect(record.result).toContain('body of src/a.ts');
    });

    it('records guard decisions the agent sees, such as cached repeats', async () => {
        const readFile = makeTool('read_file', async () => 'same body');

        await inRun(async () => {
            const { tools } = withLoopGuard([readFile], 'junior-react', { budgets: BUDGETS });
            await tools[0].invoke({ path: 'x.ts' });
            await tools[0].invoke({ path: 'x.ts' });
        });

        const [, repeat] = toolRecords();
        expect(repeat.result).toContain('[CACHED');
        expect(repeat.usage.reads).toBe(1);
    });

    it('propagates tool exceptions unchanged and records them', async () => {
        const writeFile = makeTool('write_file', async () => { throw new Error('disk full'); });

        await inRun(async () => {
            const { tools } = withLoopGuard([writeFile], 'junior-go', { budgets: BUDGETS });
            await expect(tools[0].invoke({ path: 'x.ts' })).rejects.toThrow('disk full');
        });

        const [record] = toolRecords();
        expect(record).toMatchObject({ event: 'error', agentId: 'junior-go', tool: 'write_file', error: { message: 'disk full' } });
    });
});
