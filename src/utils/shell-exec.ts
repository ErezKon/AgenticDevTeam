/**
 * Shared shell-execution helpers for gate modules.
 *
 * Consolidates the duplicated ExecFn type, safeChildEnv, defaultExec,
 * and isToolAvailable from quality-gates, security-gates, and test-runner.
 *
 * Plan 25-11: Added async variants (`AsyncExecFn`, `defaultExecAsync`,
 * `isToolAvailableAsync`) that use `child_process.execFile` with promises
 * to stop blocking the Node.js event loop during gate execution.
 *
 * Also the single home of the traced `child_process` primitives
 * (`execSync`, `execFileSync`, `execFileAsync`, `execCapture`): every child
 * process the pipeline spawns goes through them so DEBUG_MODE can record it.
 */
import {
    execSync as cpExecSync,
    execFileSync as cpExecFileSync,
    execFile as cpExecFile,
    exec as cpExec,
    type ExecOptions,
    type ExecFileOptions,
} from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { isDebugMode, traceSync, traceAsync, callerSite, scrubText, type TraceRecord } from './debug-trace';

// ─── Safe environment allowlist ─────────────────────────────────────────────

const SAFE_KEYS = [
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
    'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME',
    'PROGRAMFILES', 'SYSTEMROOT', 'WINDIR',
];

/**
 * Build a child-process environment from a safe allowlist.
 * Never leaks API keys, tokens, or secrets to child processes.
 */
export function safeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = {};
    for (const key of SAFE_KEYS) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return { ...env, ...extra };
}

// ─── Traced child-process primitives ────────────────────────────────────────
//
// Drop-in replacements for the `child_process` functions. With DEBUG_MODE off
// they call straight through; with it on, every command is recorded in the
// debug trace. Arguments, return values and thrown errors pass through
// untouched, and `child_process` is resolved at call time (promisify included)
// so `jest.mock('child_process')` / `jest.spyOn` keep working.

/** Command output keeps 80 % of its trace budget for the tail, where failures print. */
const OUTPUT_HEAD_RATIO = 0.2;

/** Commands whose non-zero exit is an expected answer rather than a failure. */
const PROBE_RE = /^(?:which|command -v)\s|\s--(?:quiet|verify)(?:\s|$)/;

type ExecRecordOptions = { cwd?: unknown; timeout?: unknown; input?: unknown } | undefined;

/** First real token of a shell command (skips `VAR=value` prefixes), as a program name. */
function firstToken(command: string): string {
    const tokens = command.trim().split(/\s+/);
    const token = tokens.find(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? tokens[0] ?? '';
    return path.basename(token.replace(/^["']|["']$/g, ''));
}

/** Program name for an execFile call — looks through `sh -c "<script>"`. */
function programOf(file: string, args: readonly unknown[]): string {
    const base = path.basename(file);
    if (/^(?:ba|z|da)?sh$/.test(base) && args[0] === '-c' && typeof args[1] === 'string') return firstToken(args[1]);
    return base;
}

function outputText(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return scrubText(Buffer.isBuffer(value) ? value.toString('utf-8') : String(value), OUTPUT_HEAD_RATIO);
}

function execFields(program: string, cmd: string, options: ExecRecordOptions): TraceRecord {
    return {
        kind: 'exec',
        program,
        cmd,
        cwd: options?.cwd !== undefined ? String(options.cwd) : process.cwd(),
        ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
        ...(options?.input !== undefined ? { stdin: outputText(options.input) } : {}),
        caller: callerSite(),
        ...(PROBE_RE.test(cmd) ? { probe: true } : {}),
    };
}

function execFailure(err: unknown): Record<string, unknown> {
    const e = err as { status?: unknown; code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown; name?: unknown; message?: unknown } | null;
    return {
        exitCode: typeof e?.status === 'number' ? e.status : (typeof e?.code === 'number' ? e.code : null),
        ...(e?.signal ? { signal: e.signal } : {}),
        timedOut: e?.code === 'ETIMEDOUT' || (e?.killed === true && e?.signal === 'SIGTERM'),
        stdout: outputText(e?.stdout),
        stderr: outputText(e?.stderr),
        error: {
            name: e?.name,
            ...(typeof e?.code === 'string' ? { code: e.code } : {}),
            message: String(e?.message ?? '').split('\n')[0],
        },
    };
}

/** Traced drop-in for `child_process.execSync`. */
export const execSync = ((...args: unknown[]) => {
    const call = () => (cpExecSync as unknown as (...a: unknown[]) => string | Buffer)(...args);
    if (!isDebugMode()) return call();
    const command = String(args[0]);
    return traceSync({
        fields: execFields(firstToken(command), command, args[1] as ExecRecordOptions),
        onResult: (out) => ({ exitCode: 0, stdout: outputText(out) }),
        onError: execFailure,
    }, call);
}) as typeof cpExecSync;

/** Traced drop-in for `child_process.execFileSync`. */
export const execFileSync = ((...args: unknown[]) => {
    const call = () => (cpExecFileSync as unknown as (...a: unknown[]) => string | Buffer)(...args);
    if (!isDebugMode()) return call();
    const file = String(args[0]);
    const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) as ExecRecordOptions;
    return traceSync({
        fields: { ...execFields(programOf(file, argv), [file, ...argv].join(' '), options), args: argv },
        onResult: (out) => ({ exitCode: 0, stdout: outputText(out) }),
        onError: execFailure,
    }, call);
}) as typeof cpExecFileSync;

/** Traced, promise-returning `execFile` — same result and rejection as `util.promisify(execFile)`. */
export function execFileAsync(
    file: string,
    args: readonly string[],
    options?: ExecFileOptions & { encoding?: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
    const call = () => (promisify(cpExecFile) as unknown as (...a: unknown[]) => Promise<{ stdout: string; stderr: string }>)(file, args, options);
    if (!isDebugMode()) return call();
    return traceAsync({
        fields: { ...execFields(programOf(file, args), [file, ...args].join(' '), options), args: [...args] },
        start: true,
        onResult: (out) => ({ exitCode: 0, stdout: outputText(out.stdout), stderr: outputText(out.stderr) }),
        onError: execFailure,
    }, call);
}

/**
 * Run a shell command via `child_process.exec` and resolve — never reject —
 * with its output and exit code (non-zero on failure or timeout). Traced.
 */
export function execCapture(
    command: string,
    options: ExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const call = () => new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        cpExec(command, options, (error, stdout, stderr) => {
            resolve({
                stdout: stdout?.toString() ?? '',
                stderr: stderr?.toString() ?? '',
                exitCode: error?.code ?? (error ? 1 : 0),
            });
        });
    });
    if (!isDebugMode()) return call();
    return traceAsync({
        fields: execFields(firstToken(command), command, options),
        start: true,
        onResult: (r) => ({ exitCode: r.exitCode, ok: r.exitCode === 0, stdout: outputText(r.stdout), stderr: outputText(r.stderr) }),
    }, call);
}

// ─── ExecFn type and default implementation ─────────────────────────────────

/** Injectable exec seam used by quality-gates, security-gates, and test-runner. */
export type ExecFn = (cmd: string, opts: { cwd: string; timeout: number }) => string;

/**
 * Default exec via `execSync` — merges stderr into stdout.
 *
 * @param cmd       Shell command string.
 * @param opts.cwd  Working directory.
 * @param opts.timeout  Timeout in milliseconds.
 * @param maxBuffer     Max output buffer size in bytes (default 10 MB).
 * @param envExtras     Additional env vars merged into `safeChildEnv()`.
 */
export function defaultExec(
    cmd: string,
    opts: { cwd: string; timeout: number },
    maxBuffer: number = 10 * 1024 * 1024,
    envExtras: Record<string, string> = { CI: 'true' },
): string {
    return execSync(cmd + ' 2>&1', {
        cwd: opts.cwd,
        encoding: 'utf-8',
        timeout: opts.timeout,
        maxBuffer,
        env: safeChildEnv(envExtras),
    });
}

// ─── Tool availability check ────────────────────────────────────────────────

/**
 * Check whether a tool is available on PATH.
 *
 * Special-cases `./gradlew`: checks file existence instead of `which`.
 */
export function isToolAvailable(
    tool: string,
    cwd: string,
    exec: ExecFn = defaultExec,
): boolean {
    if (tool === './gradlew') {
        return fs.existsSync(path.join(cwd, 'gradlew'));
    }
    try {
        exec(`which ${tool}`, { cwd, timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}

// ─── Async variants (Plan 25-11) ────────────────────────────────────────────

/** Async injectable exec seam — returns a promise instead of blocking. */
export type AsyncExecFn = (cmd: string, opts: { cwd: string; timeout: number }) => Promise<string>;

/**
 * Async exec via `execFile` with `/bin/sh -c` — merges stderr into stdout.
 * Does NOT block the event loop.
 */
export async function defaultExecAsync(
    cmd: string,
    opts: { cwd: string; timeout: number },
    maxBuffer: number = 10 * 1024 * 1024,
    envExtras: Record<string, string> = { CI: 'true' },
): Promise<string> {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd + ' 2>&1'], {
        cwd: opts.cwd,
        encoding: 'utf-8',
        timeout: opts.timeout,
        maxBuffer,
        env: safeChildEnv(envExtras),
    });
    return stdout;
}

/**
 * Async tool availability check — does NOT block the event loop.
 */
export async function isToolAvailableAsync(
    tool: string,
    cwd: string,
    exec: AsyncExecFn = defaultExecAsync,
): Promise<boolean> {
    if (tool === './gradlew') {
        return fs.existsSync(path.join(cwd, 'gradlew'));
    }
    try {
        await exec(`which ${tool}`, { cwd, timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}
