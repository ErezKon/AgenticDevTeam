/**
 * Full-response logging — the raw LLM/agent conversation, verbatim, on disk.
 *
 * `run.log` records what the pipeline *decided*; it does not record what the
 * model actually said. When an agent returns an unexpected shape (content
 * blocks instead of a string, reasoning-only output, a truncated payload) the
 * run log shows only the symptom (`0 components`), never the cause.
 *
 * Every agent invocation therefore dumps its complete LangGraph result —
 * messages (serialised via LangChain's `toJSON`), `structuredResponse` when
 * present, plus token usage — to:
 *
 *   outputs/<run>/full-responses/<seq>-<agentId>-<phase>[-<kind>].json
 *   outputs/<run>/full-responses/index.jsonl     (one summary line per file)
 *
 * The JSON shape mirrors what `JSON.stringify(await agent.invoke(...))`
 * produces, under a `model_request` key, so files can be diffed against
 * reference dumps captured outside the pipeline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import {
    FULL_RESPONSE_LOG_ENABLED,
    FULL_RESPONSE_LOG_MAX_CHARS,
    FULL_RESPONSE_LOG_DIR_NAME,
} from '../config';
import { extractAgentText } from './structured-output';

const log = getLogger('[ResponseLog]', 141);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Which invocation produced the response — used in the filename. */
export type ResponseLogKind = 'invoke' | 'repair' | 'continuation' | 'respawn';

export interface ResponseLogMeta {
    agentId: string;
    /** Pipeline phase, e.g. 'architect', 'development', 'review'. */
    phase: string;
    /** Resolved model name for this invocation. */
    model?: string;
    /** LangGraph thread id, so a repair can be tied back to its parent call. */
    threadId?: string;
    /** Token-tracker invocation id, for cross-referencing token-usage.json. */
    invocationId?: string;
    kind?: ResponseLogKind;
    /** Repair/continuation attempt number (1-based) when kind !== 'invoke'. */
    attempt?: number;
    /** The user message sent to the agent — the other half of the conversation. */
    userMessage?: string;
    /** The agent's assembled system prompt (`agent.systemPromptText`). Recorded
     *  once per agent id; later dumps carry a pointer instead of a copy. */
    systemPrompt?: string;
    durationMs?: number;
}

export interface ResponseLogEntry extends ResponseLogMeta {
    t: string;
    seq: number;
    file: string;
    messageCount: number;
    /** Block-type census of the final message, e.g. `text×1` or `reasoning×2`. */
    finalContentBlocks: string;
    /** Where the payload text was found — `none` means the agent produced nothing usable. */
    textSource: string;
    textChars: number;
    truncatedByTokenLimit: boolean;
    hasStructuredResponse: boolean;
    /** True when the dump was clipped by FULL_RESPONSE_LOG_MAX_CHARS. */
    clipped: boolean;
}

// ─── Singleton state ────────────────────────────────────────────────────────

let _dir: string | null = null;
let _seq = 0;
/** agentId -> file that already carries this agent's system prompt verbatim. */
const _systemPromptSeen = new Map<string, string>();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Point the response log at a run output directory. Called once from intake.
 * Creates `<outputPath>/full-responses/` eagerly so its absence in a finished
 * run unambiguously means "logging was disabled", not "nothing was written".
 */
export function initResponseLog(outputPath: string): void {
    if (!FULL_RESPONSE_LOG_ENABLED) return;
    _seq = 0;
    _systemPromptSeen.clear();
    const dir = path.join(outputPath, FULL_RESPONSE_LOG_DIR_NAME);
    try {
        fs.mkdirSync(dir, { recursive: true });
        _dir = dir;
        log.info(`Full-response logging enabled → ${dir}`);
    } catch (err: any) {
        _dir = null;
        log.warn(`Could not create full-response log dir: ${err.message}`);
    }
}

/**
 * Write one agent result to its own JSON file and append a summary line to
 * `index.jsonl`. Never throws — logging must not be able to fail a run.
 *
 * @returns the absolute file path written, or `null` when logging is off.
 */
export function logAgentResponse(meta: ResponseLogMeta, result: unknown): string | null {
    if (!FULL_RESPONSE_LOG_ENABLED || !_dir) return null;
    try {
        const seq = ++_seq;
        const kind = meta.kind ?? 'invoke';
        const suffix = kind === 'invoke' ? '' : `-${kind}${meta.attempt ?? ''}`;
        const file = `${String(seq).padStart(3, '0')}-${slug(meta.agentId)}-${slug(meta.phase)}${suffix}.json`;
        const filePath = path.join(_dir, file);

        const messages: unknown[] = Array.isArray((result as any)?.messages) ? (result as any).messages : [];
        const extraction = extractAgentText(messages);
        const structuredResponse = (result as any)?.structuredResponse;

        const payload = {
            meta: {
                t: new Date().toISOString(),
                seq, kind,
                agentId: meta.agentId,
                phase: meta.phase,
                model: meta.model,
                threadId: meta.threadId,
                invocationId: meta.invocationId,
                attempt: meta.attempt,
                durationMs: meta.durationMs,
                textSource: extraction.source,
                textChars: extraction.text?.length ?? 0,
                finalContentBlocks: extraction.blockTypes,
                truncatedByTokenLimit: extraction.truncatedByTokenLimit,
            },
            // The system prompt is identical for every call to a given agent and
            // includes the injected JSON schema, so it is stored once per agent.
            system_prompt: meta.systemPrompt === undefined
                ? undefined
                : (_systemPromptSeen.has(meta.agentId)
                    ? { see: _systemPromptSeen.get(meta.agentId) }
                    : meta.systemPrompt),
            user_message: meta.userMessage,
            model_request: {
                messages,
                ...(structuredResponse !== undefined ? { structuredResponse } : {}),
            },
        };

        let body = safeStringify(payload);
        let clipped = false;
        if (FULL_RESPONSE_LOG_MAX_CHARS > 0 && body.length > FULL_RESPONSE_LOG_MAX_CHARS) {
            // Keep valid JSON: re-serialise a clipped-marker envelope around the
            // raw dump rather than truncating mid-structure.
            clipped = true;
            body = safeStringify({
                ...payload,
                model_request: { clipped: true, originalChars: body.length },
                clipped_dump: body.slice(0, FULL_RESPONSE_LOG_MAX_CHARS),
            });
        }
        fs.writeFileSync(filePath, body, 'utf-8');
        if (meta.systemPrompt !== undefined && !_systemPromptSeen.has(meta.agentId)) {
            _systemPromptSeen.set(meta.agentId, file);
        }

        const entry: ResponseLogEntry = {
            t: payload.meta.t,
            seq, file,
            agentId: meta.agentId,
            phase: meta.phase,
            model: meta.model,
            threadId: meta.threadId,
            invocationId: meta.invocationId,
            kind, attempt: meta.attempt,
            durationMs: meta.durationMs,
            messageCount: messages.length,
            finalContentBlocks: extraction.blockTypes,
            textSource: extraction.source,
            textChars: extraction.text?.length ?? 0,
            truncatedByTokenLimit: extraction.truncatedByTokenLimit,
            hasStructuredResponse: structuredResponse !== undefined,
            clipped,
        };
        fs.appendFileSync(path.join(_dir, 'index.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
        return filePath;
    } catch (err: any) {
        log.warn(`Full-response log write failed: ${err.message}`);
        return null;
    }
}

/** Read back the index for a finished run (diagnostics / tests). */
export function readResponseLogIndex(outputPath: string): ResponseLogEntry[] {
    const filePath = path.join(outputPath, FULL_RESPONSE_LOG_DIR_NAME, 'index.jsonl');
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as ResponseLogEntry]; } catch { return []; }
    });
}

// ─── Internals ──────────────────────────────────────────────────────────────

function slug(s: string): string {
    return (s || 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60);
}

/**
 * Stringify with cycle protection. LangChain messages implement `toJSON`, so
 * `JSON.stringify` already yields the canonical `{ lc, type, id, kwargs }`
 * serialisation; the seen-set only guards against cyclic non-message payloads.
 */
function safeStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
        }
        return val;
    }, 2);
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset singleton state — tests only. @internal */
export function _resetResponseLog(): void {
    _dir = null;
    _seq = 0;
    _systemPromptSeen.clear();
}
