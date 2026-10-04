/**
 * Debug trace core (DEBUG_MODE) — outputs/<run>/debug/.
 *
 * The trace is what gets handed to an AI for root-cause analysis, so these
 * tests pin the properties that make it trustworthy: complete and ordered,
 * failures indexed in errors.jsonl, secrets never written, bounded field
 * size, per-run isolation, and wrappers that never change what they observe.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    DEBUG_MODE: true,
    DEBUG_TRACE_MAX_FIELD_CHARS: 400,
    GITHUB_TOKEN: 'gh-test-secret-value-1234567890',
    ANTHROPIC_API_KEY: 'anthropic-test-secret-0987654321',
}));

import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';
import { RunContext, runWithContext } from '../src/utils/run-context';
import {
    initDebugTrace, trace, traceSync, traceAsync, traceToolCall, traceOctokit,
    withTraceContext, writeDebugSummary, serializeError, _resetDebugTrace,
} from '../src/utils/debug-trace';

const GITHUB_SECRET = 'gh-test-secret-value-1234567890';
const ANTHROPIC_SECRET = 'anthropic-test-secret-0987654321';

let outDir: string;

beforeEach(() => {
    _resetDebugTrace();
    outDir = makeTempDir('adt-debug-trace-');
});

afterEach(() => cleanupDir(outDir));

const debugFile = (name: string, dir = outDir) => path.join(dir, 'debug', name);
const inRun = <T>(fn: () => Promise<T>, id = 'run-test'): Promise<T> => runWithContext(new RunContext(id), fn);

describe('initDebugTrace', () => {
    it('creates the debug folder with README, environment and an init record', async () => {
        await inRun(async () => {
            expect(initDebugTrace(outDir, { systemName: 'demo' })).toBe(path.join(outDir, 'debug'));
        });

        expect(fs.readFileSync(debugFile('README.md'), 'utf-8')).toContain('## Record kinds');
        const env = JSON.parse(fs.readFileSync(debugFile('environment.json'), 'utf-8'));
        expect(env.run).toMatchObject({ runId: 'run-test', systemName: 'demo' });
        expect(env.config.DEBUG_MODE).toBe(true);
        expect(env.config.GITHUB_TOKEN).toBe('***set***');
        expect(env.config).not.toHaveProperty('default');
        expect(env.process.node).toBe(process.version);

        const [init] = readJsonl(debugFile('trace.jsonl'));
        expect(init).toMatchObject({ seq: 1, kind: 'run', event: 'init', runId: 'run-test', systemName: 'demo', droppedBeforeInit: 0 });
    });

    it('flushes records traced before init, in order', async () => {
        await inRun(async () => {
            trace({ kind: 'log', level: 'INFO', message: 'before init' });
            expect(fs.existsSync(debugFile('trace.jsonl'))).toBe(false);
            initDebugTrace(outDir);
        });

        const records = readJsonl(debugFile('trace.jsonl'));
        expect(records[0]).toMatchObject({ seq: 1, kind: 'log', message: 'before init' });
        expect(records[1]).toMatchObject({ seq: 2, kind: 'run', event: 'init' });
    });
});

describe('trace', () => {
    it('copies failures (but not expected probes) to errors.jsonl with the same seq', async () => {
        await inRun(async () => {
            initDebugTrace(outDir);
            trace({ kind: 'exec', event: 'end', cmd: 'git status' });
            trace({ kind: 'exec', event: 'error', cmd: 'git push origin main' });
            trace({ kind: 'exec', event: 'error', cmd: 'git diff --cached --quiet', probe: true });
            trace({ kind: 'tool', event: 'end', tool: 'run_command', ok: false });
            trace({ kind: 'log', level: 'ERROR', message: 'boom' });
        });

        const errors = readJsonl(debugFile('errors.jsonl'));
        expect(errors.map(r => r.cmd ?? r.tool ?? r.message)).toEqual(['git push origin main', 'run_command', 'boom']);
        const all = readJsonl(debugFile('trace.jsonl'));
        for (const failure of errors) {
            expect(all.find(r => r.seq === failure.seq)).toEqual(failure);
        }
    });

    it('never writes configured secrets, auth headers or their base64 forms', async () => {
        const basicAuth = Buffer.from(`x-access-token:${GITHUB_SECRET}`).toString('base64');
        await inRun(async () => {
            initDebugTrace(outDir);
            trace({
                kind: 'exec', event: 'end',
                cmd: `git -c http.extraHeader=Authorization: Basic ${basicAuth} push`,
                stdout: `token ${GITHUB_SECRET}`,
                nested: { deep: [ANTHROPIC_SECRET, `raw:${basicAuth}`] },
            });
        });

        for (const file of ['trace.jsonl', 'environment.json']) {
            const raw = fs.readFileSync(debugFile(file), 'utf-8');
            expect(raw).not.toContain(GITHUB_SECRET);
            expect(raw).not.toContain(ANTHROPIC_SECRET);
            expect(raw).not.toContain(basicAuth);
        }
        expect(fs.readFileSync(debugFile('trace.jsonl'), 'utf-8')).toContain('***REDACTED***');
    });

    it('clips long strings, keeping head and tail around an explicit marker', async () => {
        const long = 'H'.repeat(1000) + 'MIDDLE' + 'T'.repeat(1000);
        await inRun(async () => {
            initDebugTrace(outDir);
            trace({ kind: 'log', level: 'INFO', message: long });
        });

        const record = readJsonl(debugFile('trace.jsonl')).find(r => r.kind === 'log');
        expect(record.message).toMatch(/^H{240}\n…\[debug-trace: 1606 chars elided of 2006\]…\nT{160}$/);
    });

    it('isolates concurrent runs into their own folders', async () => {
        const dirA = makeTempDir('adt-debug-a-');
        const dirB = makeTempDir('adt-debug-b-');
        const tick = () => new Promise(resolve => setTimeout(resolve, 5));
        try {
            await Promise.all([
                runWithContext(new RunContext('run-a'), async () => {
                    initDebugTrace(dirA);
                    await tick();
                    trace({ kind: 'log', level: 'INFO', message: 'from A' });
                }),
                runWithContext(new RunContext('run-b'), async () => {
                    initDebugTrace(dirB);
                    await tick();
                    trace({ kind: 'log', level: 'INFO', message: 'from B' });
                }),
            ]);
            const a = readJsonl(debugFile('trace.jsonl', dirA));
            const b = readJsonl(debugFile('trace.jsonl', dirB));
            expect(a.filter(r => r.kind === 'log').map(r => r.message)).toEqual(['from A']);
            expect(b.filter(r => r.kind === 'log').map(r => r.message)).toEqual(['from B']);
            expect(a.every(r => r.runId === 'run-a')).toBe(true);
            expect(b.every(r => r.runId === 'run-b')).toBe(true);
        } finally {
            cleanupDir(dirA);
            cleanupDir(dirB);
        }
    });

    it('attributes nested records via withTraceContext; explicit fields win', async () => {
        await inRun(async () => {
            initDebugTrace(outDir);
            await withTraceContext({ phase: 'development', branch: 'feat/board' }, async () => {
                await Promise.resolve();
                trace({ kind: 'log', level: 'INFO', message: 'nested' });
                withTraceContext({ agentId: 'junior-react' }, () => {
                    trace({ kind: 'log', level: 'INFO', message: 'agent', phase: 'review' });
                });
            });
            trace({ kind: 'log', level: 'INFO', message: 'outside' });
        });

        const logs = readJsonl(debugFile('trace.jsonl')).filter(r => r.kind === 'log');
        expect(logs[0]).toMatchObject({ message: 'nested', phase: 'development', branch: 'feat/board' });
        expect(logs[1]).toMatchObject({ message: 'agent', phase: 'review', branch: 'feat/board', agentId: 'junior-react' });
        expect(logs[2].phase).toBeUndefined();
        expect(logs[2].branch).toBeUndefined();
    });
});

describe('operation wrappers', () => {
    const boom = Object.assign(new Error('kaput'), { status: 503 });

    it('traceSync / traceAsync record outcomes and rethrow the original error', async () => {
        await inRun(async () => {
            initDebugTrace(outDir);
            expect(traceSync({ fields: { kind: 'exec', cmd: 'ok' } }, () => 42)).toBe(42);
            let caught: unknown;
            try {
                traceSync({ fields: { kind: 'exec', cmd: 'bad' } }, () => { throw boom; });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBe(boom);
            await expect(traceAsync({ fields: { kind: 'http', method: 'GET' }, start: true }, async () => { throw boom; }))
                .rejects.toBe(boom);
        });

        const records = readJsonl(debugFile('trace.jsonl')).filter(r => r.kind !== 'run');
        expect(records.map(r => `${r.kind}:${r.event}`)).toEqual(['exec:end', 'exec:error', 'http:start', 'http:error']);
        expect(typeof records[0].durationMs).toBe('number');
        expect(records[1].error).toMatchObject({ name: 'Error', message: 'kaput', status: 503 });
    });

    it('traceToolCall records what the agent saw and rethrows unchanged', async () => {
        await inRun(async () => {
            initDebugTrace(outDir);
            const readFile = traceToolCall('junior-go', 'read_file',
                async (args: { path: string }) => `contents of ${args.path}`, () => ({ reads: 1 }));
            await readFile({ path: 'a.ts' }, { toolCall: { id: 'call_1' } });

            const writeFile = traceToolCall('junior-go', 'write_file', async () => { throw boom; });
            await expect(writeFile({}, {})).rejects.toBe(boom);

            const denied = traceToolCall('junior-go', 'run_command', async () => 'Error: Command denied');
            await denied({ command: 'sudo rm -rf /' });
        });

        const tools = readJsonl(debugFile('trace.jsonl')).filter(r => r.kind === 'tool');
        expect(tools[0]).toMatchObject({
            event: 'end', agentId: 'junior-go', tool: 'read_file', toolCallId: 'call_1',
            args: { path: 'a.ts' }, result: 'contents of a.ts', ok: true, usage: { reads: 1 },
        });
        expect(tools[1]).toMatchObject({ event: 'error', tool: 'write_file', error: { message: 'kaput' } });
        expect(tools[2]).toMatchObject({ event: 'end', tool: 'run_command', ok: false });
    });

    it('traceOctokit records local stand-in calls through a proxy', async () => {
        const api = {
            pulls: { create: async (p: { title: string }) => ({ data: { number: 7, html_url: 'local://pr/7', title: p.title } }) },
        };
        await inRun(async () => {
            initDebugTrace(outDir);
            const traced = traceOctokit(api, 'github-local');
            const res = await traced.pulls.create({ owner: 'o', repo: 'r', title: 'feat: x', head: 'feat/x', base: 'main' } as any);
            expect(res.data.number).toBe(7);
        });

        const [record] = readJsonl(debugFile('trace.jsonl')).filter(r => r.kind === 'http');
        expect(record).toMatchObject({
            event: 'end', service: 'github-local', method: 'pulls.create',
            params: { owner: 'o', repo: 'r', head: 'feat/x', base: 'main', title: 'feat: x' },
            response: { number: 7, html_url: 'local://pr/7' },
        });
    });

    it('traceOctokit hooks real Octokit requests without recording headers', async () => {
        let hook: ((request: (o: any) => Promise<any>, options: any) => Promise<any>) | undefined;
        const octokit = { hook: { wrap: (_name: string, fn: typeof hook) => { hook = fn; } } };
        await inRun(async () => {
            initDebugTrace(outDir);
            expect(traceOctokit(octokit, 'github')).toBe(octokit);
            const request = jest.fn(async () => ({ status: 201, data: { number: 3, state: 'open' } }));
            const res = await hook!(request, {
                method: 'POST', url: '/repos/{owner}/{repo}/pulls', owner: 'o', repo: 'r',
                headers: { authorization: 'token super-secret-header' },
            });
            expect(res.status).toBe(201);
        });

        const [record] = readJsonl(debugFile('trace.jsonl')).filter(r => r.kind === 'http');
        expect(record).toMatchObject({ method: 'POST', route: '/repos/{owner}/{repo}/pulls', status: 201, response: { number: 3, state: 'open' } });
        expect(JSON.stringify(record)).not.toContain('super-secret-header');
    });
});

describe('writeDebugSummary', () => {
    it('aggregates counts, failures, per-program and per-agent stats and the slowest operations', async () => {
        await inRun(async () => {
            initDebugTrace(outDir);
            trace({ kind: 'exec', event: 'end', program: 'git', cmd: 'git status', durationMs: 5 });
            trace({ kind: 'exec', event: 'error', program: 'npm', cmd: 'npm test', durationMs: 900 });
            trace({ kind: 'llm', event: 'end', agentId: 'architect', usage: { inputTokens: 100, outputTokens: 20 }, durationMs: 300 });
            expect(writeDebugSummary()).toMatchObject({ records: 4, failures: 1 });
        });

        const summary = JSON.parse(fs.readFileSync(debugFile('summary.json'), 'utf-8'));
        expect(summary.byKind).toEqual({ run: 1, exec: 2, llm: 1 });
        expect(summary.execByProgram.npm).toEqual({ count: 1, failures: 1, totalMs: 900 });
        expect(summary.llmByAgent.architect).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20, totalMs: 300 });
        expect(summary.slowest.map((s: any) => s.label)).toEqual(['npm test', 'architect', 'git status']);
        expect(summary.firstFailures).toEqual([expect.objectContaining({ kind: 'exec', label: 'npm test' })]);
    });
});

describe('serializeError', () => {
    it('keeps provider status, body, useful headers and the cause chain', () => {
        const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        const err = Object.assign(new Error('400 bad request'), {
            status: 400,
            error: { type: 'invalid_request_error' },
            headers: new Map([['request-id', 'req_123'], ['content-type', 'application/json'], ['retry-after', '7']]),
            cause,
        });

        const serialized = serializeError(err);
        expect(serialized).toMatchObject({
            name: 'Error', message: '400 bad request', status: 400,
            body: { type: 'invalid_request_error' },
            headers: { 'request-id': 'req_123', 'retry-after': '7' },
            cause: { message: 'socket hang up', code: 'ECONNRESET' },
        });
        expect(serialized.headers).not.toHaveProperty('content-type');
        expect(typeof serialized.stack).toBe('string');
    });
});
