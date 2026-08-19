/**
 * Record/replay wrapper for LLM HTTP traffic.
 *
 * Sits INSIDE throttledFetch (i.e. wraps oauthFetch) so recordings capture
 * real gateway responses and replays skip the throttle's cooldowns entirely.
 * Enables deterministic, offline, seconds-long pipeline tests where the only
 * option today is an hours-long run against a rate-limited gateway (PART A12).
 *
 * Storage: tests/cassettes/<CASSETTE_NAME>.jsonl — one JSON object per line.
 * JSONL so a crashed recording is still usable and diffs are reviewable.
 *
 * Redaction on write: drops Authorization and any header or body field
 * matching /token|secret|key/i BEFORE writing. A cassette is committed to the
 * repo — this is mandatory, not optional.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
    LLM_CASSETTE_MODE, CASSETTE_NAME, LLM_CASSETTE_ON_MISS, CASSETTE_MAX_MB,
} from '../config';
import { getLogger } from './logger';
// Re-export LLM_CASSETTE_MODE so existing importers (e.g. agent-factory) keep working
export { LLM_CASSETTE_MODE } from '../config';

const log = getLogger('[llm-cassette]', 183);

// ─── Configuration ──────────────────────────────────────────────────────────

export type CassetteMode = 'off' | 'record' | 'replay';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CassetteEntry {
    key: string;
    seq: number;
    status: number;
    headers: Record<string, string>;
    body: string;
}

// ─── Module-level singleton state ───────────────────────────────────────────

/** Per-key sequence counters for record mode. */
let recordSeqMap = new Map<string, number>();

/** Replay entries loaded from the cassette file, keyed by `key:seq`. */
let replayStore = new Map<string, CassetteEntry>();

/** Per-key sequence counters for replay mode (tracks which seq to serve next). */
let replaySeqMap = new Map<string, number>();

/** Stats counters. */
let stats = { recorded: 0, replayed: 0, misses: 0 };

/** Whether the cassette file has been loaded for replay. */
let loaded = false;

/** File descriptor for writing during record mode. */
let writeStream: fs.WriteStream | null = null;

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface CassetteStats {
    mode: CassetteMode;
    recorded: number;
    replayed: number;
    misses: number;
}

export function getCassetteStats(): CassetteStats {
    return { mode: LLM_CASSETTE_MODE, ...stats };
}

/** Reset internal state (for testing only). */
export function _resetCassette(): void {
    recordSeqMap = new Map();
    replayStore = new Map();
    replaySeqMap = new Map();
    stats = { recorded: 0, replayed: 0, misses: 0 };
    loaded = false;
    if (writeStream) {
        writeStream.end();
        writeStream = null;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve the cassette file path from CASSETTE_NAME. */
export function resolveCassettePath(name?: string): string {
    const n = name ?? CASSETTE_NAME;
    if (!n) throw new Error('CASSETTE_NAME is required for record/replay mode');
    // Support both plain .jsonl and compressed .jsonl.gz
    const base = path.resolve('tests', 'cassettes', n);
    if (n.endsWith('.jsonl') || n.endsWith('.jsonl.gz')) return base;
    return `${base}.jsonl`;
}

/**
 * Volatile fields that vary between runs but don't change the response.
 * Removed from the request body before hashing for key stability.
 */
const VOLATILE_FIELDS = new Set([
    'thread_id', 'run_id', 'session_id', 'request_id',
    'stream', 'stream_options',
]);

/**
 * Build a stable key from a request's URL, method, and body.
 *
 * Removes volatile fields (thread_id, etc.) so that re-runs with
 * different thread IDs still hit the same cassette entries.
 */
export function buildCassetteKey(url: string, method: string, body: unknown): string {
    let cleanBody = body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const obj = { ...(body as Record<string, unknown>) };
        for (const field of VOLATILE_FIELDS) {
            delete obj[field];
        }
        cleanBody = obj;
    }
    const payload = JSON.stringify({ url, method, body: cleanBody });
    return createHash('sha256').update(payload).digest('hex');
}

/**
 * Redact sensitive fields from headers and body before writing to disk.
 *
 * Headers: drop Authorization and any key matching /token|secret|key/i.
 * Body: recursively drop any key matching /token|secret|key/i.
 */
const SENSITIVE_KEY_RE = /token|secret|key|password|credential|auth/i;

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'authorization') continue;
        if (SENSITIVE_KEY_RE.test(k)) continue;
        result[k] = v;
    }
    return result;
}

export function redactBody(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(redactBody);
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (SENSITIVE_KEY_RE.test(k)) {
                result[k] = '***REDACTED***';
            } else {
                result[k] = redactBody(v);
            }
        }
        return result;
    }
    return value;
}

/** Load the cassette file into memory for replay. */
function loadCassette(): void {
    if (loaded) return;
    loaded = true;

    const filePath = resolveCassettePath();
    if (!fs.existsSync(filePath)) {
        log.warn(`Cassette file not found: ${filePath} — all requests will miss`);
        return;
    }

    let content: string;
    if (filePath.endsWith('.gz')) {
        const compressed = fs.readFileSync(filePath);
        content = zlib.gunzipSync(compressed).toString('utf-8');
    } else {
        content = fs.readFileSync(filePath, 'utf-8');
    }

    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as CassetteEntry;
            replayStore.set(`${entry.key}:${entry.seq}`, entry);
        } catch {
            // Skip malformed lines (e.g. from a crashed recording)
        }
    }

    log.info(`Loaded ${replayStore.size} cassette entries from ${filePath}`);
}

/** Get the write stream for record mode, creating the cassette directory if needed. */
function getWriteStream(): fs.WriteStream {
    if (writeStream) return writeStream;
    const filePath = resolveCassettePath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    writeStream = fs.createWriteStream(filePath, { flags: 'a' });

    // Warn if the cassette is getting large
    if (fs.existsSync(filePath)) {
        const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
        if (sizeMB > CASSETTE_MAX_MB) {
            log.warn(`Cassette file is ${sizeMB.toFixed(1)} MB — exceeds CASSETTE_MAX_MB (${CASSETTE_MAX_MB}). Consider re-recording or using .jsonl.gz`);
        }
    }

    return writeStream;
}

/** Parse a request body from the fetch init, handling various input types. */
async function parseRequestBody(init?: RequestInit): Promise<unknown> {
    if (!init?.body) return null;
    if (typeof init.body === 'string') {
        try { return JSON.parse(init.body); } catch { return init.body; }
    }
    // ArrayBuffer, ReadableStream, etc. — try to get text
    try {
        const text = init.body.toString();
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Extract the URL string from the fetch input. */
function extractUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return String(input);
}

// ─── Exported cassette wrapper ──────────────────────────────────────────────

/**
 * Record/replay wrapper for LLM HTTP traffic.
 *
 * In `record` mode: passes through to `inner`, buffers the response,
 * appends a redacted line to the cassette file, returns the original response.
 *
 * In `replay` mode: returns a synthesised Response from the cassette.
 * On a miss, honours LLM_CASSETTE_ON_MISS (strict throws, passthrough calls inner).
 */
export function cassetteFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
    const wrapped: typeof globalThis.fetch = async (input, init?) => {
        const url = extractUrl(input);
        const method = (init?.method ?? 'POST').toUpperCase();
        const body = await parseRequestBody(init);
        const key = buildCassetteKey(url, method, body);

        if (LLM_CASSETTE_MODE === 'record') {
            // Pass through and record the response
            const response = await inner(input, init);

            // Clone so we can read the body without consuming it
            const clone = response.clone();
            const responseBody = await clone.text();

            // Build the redacted entry
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => { responseHeaders[k] = v; });

            const seq = recordSeqMap.get(key) ?? 0;
            recordSeqMap.set(key, seq + 1);

            const entry: CassetteEntry = {
                key,
                seq,
                status: response.status,
                headers: redactHeaders(responseHeaders),
                body: JSON.stringify(redactBody(JSON.parse(responseBody).error ? JSON.parse(responseBody) : JSON.parse(responseBody))),
            };

            // Handle non-JSON response bodies gracefully
            try {
                const parsed = JSON.parse(responseBody);
                entry.body = JSON.stringify(redactBody(parsed));
            } catch {
                entry.body = responseBody;
            }

            const stream = getWriteStream();
            stream.write(JSON.stringify(entry) + '\n');

            stats.recorded++;
            return response;
        }

        if (LLM_CASSETTE_MODE === 'replay') {
            loadCassette();

            const seq = replaySeqMap.get(key) ?? 0;
            const storeKey = `${key}:${seq}`;
            const entry = replayStore.get(storeKey);

            if (!entry) {
                stats.misses++;

                if (LLM_CASSETTE_ON_MISS === 'passthrough') {
                    log.warn(`Cassette miss (passthrough): key=${key.slice(0, 12)}... seq=${seq}`);
                    return inner(input, init);
                }

                // Strict mode: throw with diagnostic info
                const bodyObj = body as Record<string, unknown> | null;
                const model = bodyObj?.model ?? 'unknown';
                const messages = bodyObj?.messages as Array<{ role: string; content: string }> | undefined;
                const lastUserMsg = messages
                    ?.filter(m => m.role === 'user')
                    .pop()
                    ?.content?.slice(0, 200) ?? '';

                throw new Error(
                    `LLM cassette miss (strict mode). ` +
                    `key=${key.slice(0, 16)}..., seq=${seq}, model=${model}. ` +
                    `Last user message: "${lastUserMsg}..."`
                );
            }

            replaySeqMap.set(key, seq + 1);
            stats.replayed++;

            // Synthesise a Response from the stored entry
            return new Response(entry.body, {
                status: entry.status,
                headers: entry.headers,
            });
        }

        // Mode is 'off' — should not reach here, but just in case
        return inner(input, init);
    };

    return wrapped as typeof globalThis.fetch;
}

/**
 * Load cassette entries from raw JSONL content (for testing).
 * @internal
 */
export function _loadFromContent(content: string): void {
    loaded = true;
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as CassetteEntry;
            replayStore.set(`${entry.key}:${entry.seq}`, entry);
        } catch { /* skip */ }
    }
}
