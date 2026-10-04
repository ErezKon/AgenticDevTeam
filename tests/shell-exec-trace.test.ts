/**
 * Traced child-process primitives (shell-exec.ts) under DEBUG_MODE.
 *
 * Every command the pipeline spawns goes through these drop-ins, so the trace
 * must capture what ran and how it ended — and the drop-ins must behave
 * exactly like child_process: same return values, same thrown error objects.
 * Uses real `sh` commands; no network.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    DEBUG_MODE: true,
    DEBUG_TRACE_MAX_FIELD_CHARS: 2000,
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';
import { RunContext, runWithContext } from '../src/utils/run-context';
import { initDebugTrace, _resetDebugTrace } from '../src/utils/debug-trace';
import { execSync, execFileSync, execFileAsync, execCapture } from '../src/utils/shell-exec';

const describePosix = os.platform() === 'win32' ? describe.skip : describe;

let outDir: string;

beforeEach(() => {
    _resetDebugTrace();
    outDir = makeTempDir('adt-exec-trace-');
});

afterEach(() => cleanupDir(outDir));

const execRecords = () => readJsonl(path.join(outDir, 'debug', 'trace.jsonl')).filter(r => r.kind === 'exec');
const errorRecords = () => readJsonl(path.join(outDir, 'debug', 'errors.jsonl'));
const inRun = <T>(fn: () => T | Promise<T>): Promise<T> =>
    runWithContext(new RunContext('run-exec'), async () => {
        initDebugTrace(outDir);
        return fn();
    });

describePosix('traced child-process primitives', () => {
    it('execSync returns the same output and records the command', async () => {
        const out = await inRun(() => execSync('echo hello', { encoding: 'utf-8' }));
        expect(out).toBe('hello\n');

        const [record] = execRecords();
        expect(record).toMatchObject({ event: 'end', program: 'echo', cmd: 'echo hello', exitCode: 0, stdout: 'hello\n' });
        expect(record.caller).toContain('shell-exec-trace.test.ts');
        expect(typeof record.durationMs).toBe('number');
    });

    it('execSync rethrows the identical error and records exit code and stderr', async () => {
        let caught: any;
        await inRun(() => {
            try {
                execSync('echo oops >&2; exit 3', { encoding: 'utf-8', stdio: 'pipe' });
            } catch (err) {
                caught = err;
            }
        });
        expect(caught.status).toBe(3);
        expect(String(caught.stderr)).toContain('oops');

        const [record] = execRecords();
        expect(record).toMatchObject({ event: 'error', exitCode: 3, timedOut: false });
        expect(record.stderr).toContain('oops');
        expect(errorRecords().map(r => r.seq)).toEqual([record.seq]);
    });

    it('execFileSync records the program behind `sh -c`, the args and the cwd', async () => {
        const out = await inRun(() => execFileSync('sh', ['-c', 'pwd'], { cwd: outDir, encoding: 'utf-8' }));
        expect(fs.realpathSync(out.trim())).toBe(fs.realpathSync(outDir));

        const [record] = execRecords();
        expect(record).toMatchObject({ event: 'end', program: 'pwd', args: ['-c', 'pwd'], cwd: outDir, exitCode: 0 });
    });

    it('execFileAsync writes start + end records and resolves like promisify(execFile)', async () => {
        const result = await inRun(() => execFileAsync('/bin/sh', ['-c', 'echo async; echo warn >&2'], { encoding: 'utf-8' }));
        expect(result).toEqual({ stdout: 'async\n', stderr: 'warn\n' });

        const records = execRecords();
        expect(records.map(r => r.event)).toEqual(['start', 'end']);
        expect(records[1]).toMatchObject({ program: 'echo', exitCode: 0, stdout: 'async\n', stderr: 'warn\n' });
    });

    it('execFileAsync records a timeout with its signal and rejects like execFile', async () => {
        await inRun(() => expect(execFileAsync('sleep', ['5'], { timeout: 200 }))
            .rejects.toMatchObject({ killed: true, signal: 'SIGTERM' }));

        const record = execRecords().find(r => r.event === 'error');
        expect(record).toMatchObject({ program: 'sleep', timedOut: true, signal: 'SIGTERM', timeoutMs: 200 });
    });

    it('execCapture resolves (never rejects) with the exit code and indexes the failure', async () => {
        const result = await inRun(() => execCapture('echo out; echo err >&2; exit 2', { cwd: outDir }));
        expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 2 });

        const records = execRecords();
        expect(records.map(r => r.event)).toEqual(['start', 'end']);
        expect(records[1]).toMatchObject({ ok: false, exitCode: 2, stdout: 'out\n', stderr: 'err\n' });
        expect(errorRecords()).toHaveLength(1);
    });

    it('records stdin passed through options.input', async () => {
        const out = await inRun(() => execSync('cat', { input: 'payload-123', encoding: 'utf-8' }));
        expect(out).toBe('payload-123');
        expect(execRecords()[0]).toMatchObject({ program: 'cat', stdin: 'payload-123', stdout: 'payload-123' });
    });

    it('tags expected probe failures and keeps them out of errors.jsonl', async () => {
        await inRun(() => {
            try {
                execSync('which definitely-not-a-real-tool-xyz', { stdio: 'pipe' });
            } catch {
                // expected: the tool does not exist
            }
        });
        expect(execRecords()[0]).toMatchObject({ event: 'error', probe: true });
        expect(errorRecords()).toEqual([]);
    });

    it('keeps the tail of long output, where failures print', async () => {
        await inRun(() => execSync('for i in $(seq 1 2000); do echo line-$i; done', { encoding: 'utf-8' }));

        const [record] = execRecords();
        expect(record.stdout).toContain('line-2000');
        expect(record.stdout).toContain('chars elided');
        expect(record.stdout.indexOf('chars elided')).toBeLessThan(record.stdout.length / 2);
    });
});

describe('lazy child_process resolution', () => {
    it('loads and passes arguments through under a partial child_process mock', () => {
        jest.isolateModules(() => {
            const mockExecSync = jest.fn(() => 'mocked');
            jest.doMock('child_process', () => ({ execSync: mockExecSync }));
            const shellExec = require('../src/utils/shell-exec');

            expect(shellExec.execSync('anything --flag', { encoding: 'utf-8' })).toBe('mocked');
            expect(mockExecSync).toHaveBeenCalledWith('anything --flag', { encoding: 'utf-8' });
        });
    });
});
