/**
 * Debug trace — verbose, structured, AI-ready diagnostics (DEBUG_MODE).
 *
 * With DEBUG_MODE=true every significant operation of a run is appended to
 * `outputs/<run>/debug/trace.jsonl` as one self-contained JSON record: LLM
 * requests and responses, agent tool calls, child processes (git, shell,
 * npm, docker, curl), GitHub API calls, graph nodes and routing decisions,
 * retries, log lines and crashes. Failures are also copied to
 * `errors.jsonl` (same `seq`); `summary.json` aggregates the run.
 *
 * Invariants:
 * - DEBUG_MODE=false → every export is a pass-through and nothing is written.
 * - Observe only → wrappers never change arguments, return values or the
 *   identity of thrown errors.
 * - Never throws → tracing failures are reported once on stderr.
 * - Every string is redacted (secret patterns + configured secret values)
 *   and then clipped to DEBUG_TRACE_MAX_FIELD_CHARS before it is written.
 * - Appends are synchronous (like run-ledger.ts) so records stay ordered and
 *   survive a crash or process.exit().
 *
 * Must not import logger, artifact-writer or git-exec: they import this
 * module directly or via shell-exec.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    DEBUG_MODE, DEBUG_TRACE_MAX_FIELD_CHARS,
    GITHUB_TOKEN, GITHUB_PROJECT_TOKEN,
    OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, OAUTH_CLIENT_SECRET,
} from '../config';
import { getRunContext, DebugTraceState, type DebugTraceStats, type RunContext } from './run-context';
import { redactSecrets, redactValues } from './redact';
import { buildDebugEnvironment } from './debug-environment';
import { renderDebugTraceReadme } from '../templates/debug-trace-readme.template';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TraceKind =
    | 'run' | 'node' | 'route' | 'llm' | 'tool' | 'exec' | 'http' | 'docker'
    | 'retry' | 'event' | 'ledger' | 'response' | 'log' | 'crash';

/** A record as passed to `trace()` — the envelope (seq, t, runId, context) is added on write. */
export interface TraceRecord {
    kind: TraceKind;
    event?: string;
    /** `false` routes the record to errors.jsonl. */
    ok?: boolean;
    durationMs?: number;
    [field: string]: unknown;
}

/** Ambient attribution merged into every record written inside `withTraceContext()`. */
export interface TraceContext {
    phase?: string;
    branch?: string;
    agentId?: string;
}

export interface TraceOptions {
    /** Run whose trace receives the record when the async context does not carry one. */
    ctx?: RunContext;
    /** Process-level record (crash, signal): fall back to the most recently initialised run. */
    processLevel?: boolean;
}

/** Declarative description of an operation for `traceSync()` / `traceAsync()`. */
export interface TracedOp<R> {
    /** Fields shared by the start / end / error records. */
    fields: TraceRecord;
    /** Also write a `start` record — for operations that can run for minutes. */
    start?: boolean;
    /** Extra end-record fields derived from the result. */
    onResult?: (result: R) => Record<string, unknown>;
    /** Error-record fields derived from the thrown error (default: `{ error }`). */
    onError?: (err: unknown) => Record<string, unknown>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEBUG_DIR_NAME = 'debug';
const TRACE_FILE = 'trace.jsonl';
const ERRORS_FILE = 'errors.jsonl';
const SUMMARY_FILE = 'summary.json';
const README_FILE = 'README.md';
const ENVIRONMENT_FILE = 'environment.json';

const DEFAULT_FIELD_CHARS = 20_000;
/** Records traced before `initDebugTrace()` are buffered up to this many. */
const PENDING_MAX = 2_000;
const SLOWEST_MAX = 15;
const FIRST_FAILURES_MAX = 50;
const LABEL_MAX_CHARS = 160;
/** A clipped string may exceed the cap by the length of its marker — never clip it twice. */
const CLIP_SLACK = 128;
/** A record larger than this many field caps is re-serialised with a tighter per-string cap. */
const RECORD_FIELD_MULTIPLE = 25;
const MAX_ERROR_CAUSE_DEPTH = 3;
const ERROR_SCALAR_KEYS = ['code', 'status', 'statusCode', 'signal', 'type', 'errno', 'syscall', 'killed', 'requestID', 'request_id'];
const HEADER_KEEP_RE = /request-id|retry-after|ratelimit|x-should-retry|cf-ray/i;
const TOOL_ERROR_RE = /^(?:Error:|\{"error")/;
const INTERNAL_FRAME_RE = /[\\/]utils[\\/](?:debug-trace|shell-exec|git-exec)\.[cm]?[jt]s:|[\\/]node_modules[\\/]|\(node:|\bat node:/;
const GITHUB_PARAM_KEYS = [
    'owner', 'repo', 'pull_number', 'issue_number', 'head', 'base', 'title', 'body',
    'state', 'merge_method', 'ref', 'name', 'private', 'event', 'per_page',
];
const GITHUB_DATA_KEYS = [
    'id', 'number', 'state', 'merged', 'sha', 'html_url', 'full_name', 'default_branch',
    'title', 'login', 'message', 'errors',
];

// ─── Singleton state ────────────────────────────────────────────────────────

let _default = new DebugTraceState();
/** Most recently initialised state — target of process-level records written outside any run. */
let _lastInitialised: DebugTraceState | null = null;
let _secretValues: string[] | null = null;
let _warned = false;
const _contextStore = new AsyncLocalStorage<TraceContext>();

/** Get the active debug-trace state — per-run scoped or module default. */
function _active(opts?: TraceOptions): DebugTraceState {
    const runCtx = opts?.ctx ?? getRunContext();
    if (runCtx) return runCtx.debugTrace;
    if (opts?.processLevel && !_default.dir && _lastInitialised) return _lastInitialised;
    return _default;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/** True when DEBUG_MODE is enabled. A missing value (partial config mock) counts as off. */
export function isDebugMode(): boolean {
    return DEBUG_MODE === true;
}

/**
 * Open `<outputPath>/debug/` for the active run: write README.md and
 * environment.json, flush records buffered before init and append a
 * `run`/`init` record. Re-initialising (continue-run) appends a new session.
 *
 * @returns the debug directory, or `null` when DEBUG_MODE is off or it cannot be created.
 */
export function initDebugTrace(outputPath: string, meta: Record<string, unknown> = {}): string | null {
    if (!isDebugMode()) return null;
    const state = _active();
    const dir = path.join(outputPath, DEBUG_DIR_NAME);
    const run = { runId: getRunContext()?.id ?? null, outputPath, ...meta };
    let environment: Record<string, unknown>;
    try {
        environment = buildDebugEnvironment(run);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, README_FILE), renderDebugTraceReadme({ maxFieldChars: fieldCap() }), 'utf-8');
        fs.writeFileSync(path.join(dir, ENVIRONMENT_FILE), serialize(environment, fieldCap(), 2) + '\n', 'utf-8');
    } catch (err) {
        warnOnce(`cannot initialise ${dir}: ${errorMessage(err)}`);
        return null;
    }
    state.dir = dir;
    _lastInitialised = state;
    for (const { line, failure } of state.pending.splice(0)) appendLines(state, line, failure);
    const droppedBeforeInit = state.droppedPending;
    state.droppedPending = 0;
    trace({ kind: 'run', event: 'init', ...run, app: environment.app, node: process.version, droppedBeforeInit });
    return dir;
}

/**
 * Write `debug/summary.json` from the in-memory aggregates. Best-effort.
 *
 * @returns the file written with headline counts, or `null` when there is nothing to write.
 */
export function writeDebugSummary(opts?: TraceOptions): { file: string; records: number; failures: number } | null {
    if (!isDebugMode()) return null;
    const state = _active(opts);
    if (!state.dir) return null;
    const file = path.join(state.dir, SUMMARY_FILE);
    try {
        const summary = { generatedAt: new Date().toISOString(), lastSeq: state.seq, ...state.stats };
        fs.writeFileSync(file, serialize(summary, fieldCap(), 2) + '\n', 'utf-8');
        return { file, records: state.stats.records, failures: state.stats.failures };
    } catch (err) {
        warnOnce(`cannot write ${file}: ${errorMessage(err)}`);
        return null;
    }
}

// ─── Recording ──────────────────────────────────────────────────────────────

/** Append one record to the active run's trace. No-op when DEBUG_MODE is off; never throws. */
export function trace(record: TraceRecord, opts?: TraceOptions): void {
    if (!isDebugMode()) return;
    try {
        const state = _active(opts);
        state.seq += 1;
        const { kind, event, ...fields } = record;
        const full: Record<string, unknown> = {
            seq: state.seq,
            t: new Date().toISOString(),
            runId: (opts?.ctx ?? getRunContext())?.id ?? null,
            kind,
            ...(event !== undefined ? { event } : {}),
            ..._contextStore.getStore(),
            ...fields,
        };
        const failure = isFailure(full);
        const line = serializeRecord(full);
        updateStats(state.stats, full, failure);
        if (state.dir) {
            appendLines(state, line, failure);
        } else if (state.pending.length < PENDING_MAX) {
            state.pending.push({ line, failure });
        } else {
            state.droppedPending += 1;
        }
    } catch (err) {
        warnOnce(`trace failed: ${errorMessage(err)}`);
    }
}

/** Mirror one logger line into the trace (called by logger.ts). */
export function traceLog(level: string, tag: string, message: string): void {
    if (!isDebugMode()) return;
    trace({ kind: 'log', level, ...(tag ? { tag } : {}), message });
}

/**
 * Run `fn` with extra attribution (phase / branch / agentId) merged into every
 * record it writes, including from nested async work. Plain `fn()` when off.
 */
export function withTraceContext<T>(patch: TraceContext, fn: () => T): T {
    if (!isDebugMode()) return fn();
    return _contextStore.run({ ..._contextStore.getStore(), ...patch }, fn);
}

/** Time a synchronous operation and record its outcome; rethrows the original error. */
export function traceSync<R>(op: TracedOp<R>, fn: () => R): R {
    if (!isDebugMode()) return fn();
    const startedAt = Date.now();
    let result: R;
    try {
        result = fn();
    } catch (err) {
        recordOutcome(op, 'error', startedAt, () => (op.onError ?? defaultOnError)(err));
        throw err;
    }
    recordOutcome(op, 'end', startedAt, () => op.onResult?.(result) ?? {});
    return result;
}

/** Async counterpart of `traceSync()`; optionally writes a `start` record first. */
export async function traceAsync<R>(op: TracedOp<R>, fn: () => Promise<R>): Promise<R> {
    if (!isDebugMode()) return fn();
    const startedAt = Date.now();
    if (op.start) trace({ ...op.fields, event: 'start' });
    let result: R;
    try {
        result = await fn();
    } catch (err) {
        recordOutcome(op, 'error', startedAt, () => (op.onError ?? defaultOnError)(err));
        throw err;
    }
    recordOutcome(op, 'end', startedAt, () => op.onResult?.(result) ?? {});
    return result;
}

/**
 * Wrap a loop-guarded tool function so every call is recorded with the agent,
 * the arguments, the result exactly as the agent saw it and the budget usage.
 * Nested commands inherit `agentId`. Errors are recorded and rethrown unchanged.
 */
export function traceToolCall<A, R>(
    agentId: string,
    toolName: string,
    fn: (args: A, config?: unknown) => Promise<R>,
    getUsage?: () => unknown,
): (args: A, config?: unknown) => Promise<R> {
    if (!isDebugMode()) return fn;
    return (args, config) => withTraceContext({ agentId }, () => {
        const callConfig = config as { toolCall?: { id?: string }; toolCallId?: string } | undefined;
        return traceAsync<R>({
            fields: { kind: 'tool', agentId, tool: toolName, toolCallId: callConfig?.toolCall?.id ?? callConfig?.toolCallId, args },
            onResult: (result) => {
                const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
                return { result, resultChars: text.length, ok: !TOOL_ERROR_RE.test(text.trimStart()), usage: getUsage?.() };
            },
            onError: (err) => ({ error: serializeError(err), usage: getUsage?.() }),
        }, () => fn(args, config));
    });
}

/**
 * Record every GitHub API call made through `octokit`: method, route, request
 * parameters, status and a summary of the response. Real Octokit instances
 * are hooked via `hook.wrap('request')`; the local stand-in (no hooks) is
 * wrapped in a Proxy. Identity when DEBUG_MODE is off.
 */
export function traceOctokit<T extends object>(octokit: T, service: string): T {
    if (!isDebugMode()) return octokit;
    const hook = (octokit as { hook?: { wrap?: (name: string, fn: (...args: any[]) => unknown) => void } }).hook;
    if (typeof hook?.wrap !== 'function') return proxyApiCalls(octokit, service);
    hook.wrap('request', (request: (options: any) => Promise<any>, options: any) => traceAsync({
        fields: { kind: 'http', service, method: options?.method, route: options?.url, params: pickKeys(options, GITHUB_PARAM_KEYS) },
        onResult: (res: any) => ({ status: res?.status, response: summarizeGithubData(res?.data) }),
        onError: (err: any) => ({ status: err?.status, error: serializeError(err), response: summarizeGithubData(err?.response?.data) }),
    }, () => request(options)));
    return octokit;
}

// ─── Helpers for callers ────────────────────────────────────────────────────

/** Plain-object view of an error: name, message, codes, provider body, useful headers, stack, cause chain. */
export function serializeError(err: unknown, depth = 0): Record<string, unknown> {
    if (err === null || typeof err !== 'object') return { message: String(err) };
    const e = err as Record<string, any>;
    const out: Record<string, unknown> = { name: e.name, message: e.message };
    for (const key of ERROR_SCALAR_KEYS) {
        if (e[key] !== undefined && e[key] !== null) out[key] = e[key];
    }
    if (e.error !== undefined && typeof e.error !== 'function') out.body = e.error;
    if (e.response?.data !== undefined) out.responseData = e.response.data;
    const headers = pickHeaders(e.headers ?? e.response?.headers);
    if (headers) out.headers = headers;
    if (typeof e.stack === 'string') out.stack = e.stack;
    if (e.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) out.cause = serializeError(e.cause, depth + 1);
    return out;
}

/** `file:line` of the first stack frame outside the tracing / exec plumbing. */
export function callerSite(): string | undefined {
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    for (const frame of frames) {
        if (INTERNAL_FRAME_RE.test(frame)) continue;
        const match = frame.match(/\(?([^()\s]+):(\d+):\d+\)?\s*$/);
        if (match) return `${path.relative(process.cwd(), match[1])}:${match[2]}`;
    }
    return undefined;
}

/**
 * Redact, then clip, a string for the trace. `headRatio` < 0.5 keeps more of
 * the tail (command output, where failures print).
 */
export function scrubText(text: string, headRatio = 0.6, cap: number = fieldCap()): string {
    return clipText(redact(text), cap, headRatio);
}

// ─── Internals ──────────────────────────────────────────────────────────────

function fieldCap(): number {
    const cap = typeof DEBUG_TRACE_MAX_FIELD_CHARS === 'number' ? DEBUG_TRACE_MAX_FIELD_CHARS : DEFAULT_FIELD_CHARS;
    return Math.max(0, cap);
}

function clipText(text: string, cap: number, headRatio: number): string {
    if (cap <= 0 || text.length <= cap + CLIP_SLACK) return text;
    const head = Math.floor(cap * headRatio);
    const tail = cap - head;
    const elided = text.length - head - tail;
    return `${text.slice(0, head)}\n…[debug-trace: ${elided} chars elided of ${text.length}]…\n${text.slice(text.length - tail)}`;
}

function knownSecretValues(): string[] {
    if (_secretValues) return _secretValues;
    const isSet = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const githubTokens = [GITHUB_TOKEN, GITHUB_PROJECT_TOKEN].filter(isSet);
    _secretValues = [...new Set([
        ...githubTokens,
        ...githubTokens.map(t => Buffer.from(`x-access-token:${t}`).toString('base64')),
        ...[OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, OAUTH_CLIENT_SECRET].filter(isSet),
    ])];
    return _secretValues;
}

function redact(text: string): string {
    return redactValues(redactSecrets(text), knownSecretValues());
}

/** JSON.stringify that redacts + clips every string and survives cycles, errors, Buffers, Maps and Sets. */
function serialize(value: unknown, cap: number, indent?: number): string {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, val) => {
        if (typeof val === 'string') return scrubText(val, 0.6, cap);
        if (typeof val === 'bigint') return val.toString();
        if (typeof val !== 'object' || val === null) return val;
        if (val.type === 'Buffer' && Array.isArray(val.data)) return scrubText(Buffer.from(val.data).toString('utf-8'), 0.6, cap);
        if (val instanceof Error) return serializeError(val);
        if (val instanceof Map) return Object.fromEntries(val);
        if (val instanceof Set) return [...val];
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
        return val;
    }, indent);
    return json ?? 'null';
}

function serializeRecord(record: Record<string, unknown>): string {
    const cap = fieldCap();
    const line = serialize(record, cap);
    if (cap === 0 || line.length <= cap * RECORD_FIELD_MULTIPLE) return line;
    return serialize({ ...record, recordShrunk: { originalChars: line.length } }, Math.max(500, Math.floor(cap / 10)));
}

function isFailure(rec: Record<string, unknown>): boolean {
    if (rec.probe === true) return false;
    return rec.event === 'error'
        || rec.ok === false
        || rec.kind === 'crash'
        || (rec.kind === 'run' && rec.event === 'crash')
        || (rec.kind === 'retry' && rec.event === 'giveup')
        || (rec.kind === 'log' && rec.level === 'ERROR');
}

function labelOf(rec: Record<string, any>): string {
    const label = rec.kind === 'exec' ? rec.cmd
        : rec.kind === 'llm' ? `${rec.agentId ?? '?'} ${rec.model ?? ''}`
            : rec.kind === 'tool' ? `${rec.agentId ?? '?'} ${rec.tool}`
                : rec.kind === 'node' ? rec.node
                    : rec.kind === 'http' ? `${rec.method ?? ''} ${rec.route ?? ''}`
                        : rec.kind === 'docker' ? `${rec.op ?? ''} ${rec.image ?? rec.container ?? ''}`
                            : rec.kind === 'log' ? rec.message
                                : (rec.event ?? rec.kind);
    return redact(String(label ?? '')).trim().slice(0, LABEL_MAX_CHARS);
}

function updateStats(stats: DebugTraceStats, rec: Record<string, any>, failure: boolean): void {
    stats.records += 1;
    stats.byKind[rec.kind] = (stats.byKind[rec.kind] ?? 0) + 1;
    if (failure) {
        stats.failures += 1;
        stats.failuresByKind[rec.kind] = (stats.failuresByKind[rec.kind] ?? 0) + 1;
        if (stats.firstFailures.length < FIRST_FAILURES_MAX) {
            stats.firstFailures.push({ seq: rec.seq, kind: rec.kind, label: labelOf(rec) });
        }
    }
    if (rec.event === 'start') return;
    if (rec.kind === 'llm') {
        const agent = stats.llmByAgent[rec.agentId ?? 'unknown'] ??= { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 };
        agent.calls += 1;
        if (rec.event === 'error') agent.errors += 1;
        agent.inputTokens += rec.usage?.inputTokens ?? 0;
        agent.outputTokens += rec.usage?.outputTokens ?? 0;
        agent.totalMs += rec.durationMs ?? 0;
    } else if (rec.kind === 'exec') {
        const program = stats.execByProgram[rec.program ?? 'unknown'] ??= { count: 0, failures: 0, totalMs: 0 };
        program.count += 1;
        if (failure) program.failures += 1;
        program.totalMs += rec.durationMs ?? 0;
    }
    if (typeof rec.durationMs === 'number' && rec.kind !== 'node') {
        insertSlowest(stats.slowest, { seq: rec.seq, kind: rec.kind, label: labelOf(rec), durationMs: rec.durationMs });
    }
}

function insertSlowest(list: DebugTraceStats['slowest'], entry: DebugTraceStats['slowest'][number]): void {
    if (list.length >= SLOWEST_MAX && entry.durationMs <= list[list.length - 1].durationMs) return;
    list.push(entry);
    list.sort((a, b) => b.durationMs - a.durationMs);
    if (list.length > SLOWEST_MAX) list.length = SLOWEST_MAX;
}

function appendLines(state: DebugTraceState, line: string, failure: boolean): void {
    if (!state.dir) return;
    try {
        fs.appendFileSync(path.join(state.dir, TRACE_FILE), line + '\n', 'utf-8');
        if (failure) fs.appendFileSync(path.join(state.dir, ERRORS_FILE), line + '\n', 'utf-8');
    } catch (err) {
        warnOnce(`cannot append to ${state.dir}: ${errorMessage(err)}`);
    }
}

function recordOutcome<R>(op: TracedOp<R>, event: 'end' | 'error', startedAt: number, extra: () => Record<string, unknown>): void {
    let fields: Record<string, unknown>;
    try {
        fields = extra();
    } catch (err) {
        fields = { traceError: errorMessage(err) };
    }
    trace({ ...op.fields, event, durationMs: Date.now() - startedAt, ...fields });
}

function defaultOnError(err: unknown): Record<string, unknown> {
    return { error: serializeError(err) };
}

function pickHeaders(headers: unknown): Record<string, string> | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const entries: Array<[string, unknown]> = [];
    if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
        (headers as { forEach: (cb: (value: unknown, key: string) => void) => void }).forEach((value, key) => entries.push([key, value]));
    } else {
        entries.push(...Object.entries(headers));
    }
    const kept = entries.filter(([key]) => HEADER_KEEP_RE.test(key));
    return kept.length > 0 ? Object.fromEntries(kept.map(([key, value]) => [key, String(value)])) : undefined;
}

function pickKeys(source: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
    if (!source || typeof source !== 'object') return undefined;
    const picked: Record<string, unknown> = {};
    for (const key of keys) {
        const value = (source as Record<string, unknown>)[key];
        if (value !== undefined) picked[key] = value;
    }
    return Object.keys(picked).length > 0 ? picked : undefined;
}

function summarizeGithubData(data: unknown): unknown {
    if (Array.isArray(data)) {
        return {
            count: data.length,
            items: data.slice(0, 10).map(item => ({ ...pickKeys(item, GITHUB_DATA_KEYS), ...(item?.head?.ref ? { head: item.head.ref } : {}) })),
        };
    }
    return pickKeys(data, GITHUB_DATA_KEYS) ?? (typeof data === 'string' ? data : undefined);
}

/** Proxy for the local GitHub stand-in: records each `namespace.method(params)` call. */
function proxyApiCalls<T extends object>(api: T, service: string): T {
    return new Proxy(api, {
        get(target, namespace, receiver) {
            const group = Reflect.get(target, namespace, receiver);
            if (!group || typeof group !== 'object') return group;
            return new Proxy(group, {
                get(groupTarget, method, groupReceiver) {
                    const fn = Reflect.get(groupTarget, method, groupReceiver);
                    if (typeof fn !== 'function') return fn;
                    return (params?: unknown) => traceAsync({
                        fields: { kind: 'http', service, method: `${String(namespace)}.${String(method)}`, params: pickKeys(params, GITHUB_PARAM_KEYS) },
                        onResult: (res: any) => ({ response: summarizeGithubData(res?.data) }),
                    }, async () => fn.call(groupTarget, params));
                },
            });
        },
    });
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function warnOnce(message: string): void {
    if (_warned) return;
    _warned = true;
    console.error(`[debug-trace] ${message}`);
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset module-level state — tests only. @internal */
export function _resetDebugTrace(): void {
    _default = new DebugTraceState();
    _lastInitialised = null;
    _secretValues = null;
    _warned = false;
}
