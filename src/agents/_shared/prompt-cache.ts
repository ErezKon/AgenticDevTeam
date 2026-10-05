/**
 * Anthropic prompt caching (Plan 22, D1; reworked in Plan 30-06).
 *
 * ## Why
 *
 * In the pacmanclaude run every one of the 227 Anthropic calls reported
 * `input_token_details = { cache_read: 0, cache_creation: 0 }`. The persona, the
 * tool schemas, the injected JSON response schema and the task context — roughly
 * 6 kB that is byte-identical on every turn of an invocation — were re-billed at
 * full price each time (Plan 22). In the claudeopus5 run that static prefix was
 * cached and nothing else: each of junior-angular's 912 calls re-sent ~8k uncached
 * tokens of history after a constant 7,374-token cached prefix. The rolling history
 * breakpoint was never placed, because it required the AI message's own text to
 * reach the cache minimum, and the minimums table was wrong for Haiku 4.5, Opus 4.6
 * and Opus 5 (Plan 30-06).
 *
 * ## How
 *
 * Anthropic assembles a request as `tools` → `system` → `messages` and caches the
 * longest matching prefix ending at a `cache_control` breakpoint (max 4 per
 * request). Two explicit breakpoints:
 *
 *   1. **end of the system message** — this also covers `tools`, because tools are
 *      serialised *before* `system`. One breakpoint, both blocks of fixed overhead.
 *   2. **end of the first human message** — the task, fixed for the whole invocation.
 *
 * The conversation is cached by Anthropic's **automatic caching**: a top-level
 * `cache_control` on the request (the agent factory sets it as `modelSettings`)
 * puts a breakpoint on the last cacheable block and moves it forward every turn.
 * Behind a proxy that may not forward that field (`ANTHROPIC_AUTO_CACHE=false`),
 * the last block of the last message gets an explicit breakpoint instead. Either
 * way a request carries three breakpoints.
 *
 * A breakpoint is placed whatever the length of the block it ends: the minimum
 * cacheable length applies to the whole prefix, and the API silently ignores a
 * breakpoint below it. The minimums table is for diagnostics only.
 *
 * `@langchain/anthropic@1.5.x` forwards `cache_control` from any content block
 * verbatim (`utils/message_inputs.js`) and from the call options as a top-level
 * request field (`invocationParams`).
 */
import {
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    isAIMessage,
    isHumanMessage,
    isToolMessage,
    type BaseMessage,
} from '@langchain/core/messages';
import { longestIdPrefix } from '../../utils/model-id';
import { getRunContext } from '../../utils/run-context';
import { getLogger } from '../../utils/logger';

const cacheLog = getLogger('[prompt-cache]', 226);

/** Anthropic's hard limit on `cache_control` breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** An ephemeral (5-minute) cache breakpoint — on a block, or top-level for automatic caching. */
export const EPHEMERAL = { type: 'ephemeral' as const };

// ─── Minimum cacheable prefix (Plan 30-06 — diagnostics only) ───────────────

/**
 * Minimum cacheable prefix in tokens, by model id (Anthropic prompt-caching docs).
 * Matched by longest prefix, so dated ids and point releases resolve too.
 */
export const CACHE_MIN_TOKENS_BY_MODEL: Readonly<Record<string, number>> = {
    'claude-opus-5': 512, 'claude-fable-5': 512, 'claude-mythos-5': 512,
    'claude-opus-4-8': 1024, 'claude-sonnet-5': 1024, 'claude-sonnet-4-6': 1024, 'claude-sonnet-4-5': 1024,
    'claude-opus-4-1': 1024, 'claude-opus-4': 1024, 'claude-sonnet-4': 1024,
    'claude-opus-4-7': 2048, 'claude-mythos-preview': 2048, 'claude-3-5-haiku': 2048,
    'claude-opus-4-6': 4096, 'claude-opus-4-5': 4096, 'claude-haiku-4-5': 4096,
};

/** Minimum cacheable prefix (tokens) of a model; 1024 when the table does not know it. */
export function getMinCacheableTokens(model: string): number {
    const id = longestIdPrefix(model, Object.keys(CACHE_MIN_TOKENS_BY_MODEL));
    return id ? CACHE_MIN_TOKENS_BY_MODEL[id] : 1024;
}

/** Rough chars-per-token estimate for the diagnostic. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Set of agent IDs for which we have already logged the static-prefix diagnostic. */
const _breakpointLoggedAgents = new Set<string>();

/** Get the active breakpoint-logged set — per-run scoped or module default. */
function _activeLoggedAgents(): Set<string> {
    const ctx = getRunContext();
    return ctx?.breakpointLoggedAgents ?? _breakpointLoggedAgents;
}

// ─── Block helpers ──────────────────────────────────────────────────────────

interface TextBlock { type: string; text?: string; cache_control?: unknown; [k: string]: unknown }

function contentChars(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) return JSON.stringify(content).length;
    return 0;
}

function hasCacheControl(content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    return content.some(b => b !== null && typeof b === 'object' && 'cache_control' in (b as object));
}

/**
 * Block types that must never carry `cache_control`.
 *
 * Anthropic's API rejects `cache_control` on `thinking` and `redacted_thinking`
 * blocks (`Extra inputs are not permitted`). When `sanitizeStreamingContentBlocks`
 * strips tool_use blocks and only thinking blocks remain, we must skip breakpoint
 * placement entirely.  (Plan 26, A1)
 */
const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/**
 * Return the message's content as a block array with `cache_control: ephemeral`
 * on the last non-thinking block. String content is promoted to a single text block.
 *
 * Returns `null` when:
 * - content is empty or not an array/string
 * - all blocks are thinking blocks (no valid target for cache_control)
 */
export function blocksWithTrailingBreakpoint(content: unknown): TextBlock[] | null {
    if (typeof content === 'string') {
        if (content.length === 0) return null;
        return [{ type: 'text', text: content, cache_control: EPHEMERAL }];
    }
    if (!Array.isArray(content) || content.length === 0) return null;
    const blocks = content.map(b => (b !== null && typeof b === 'object' ? { ...(b as TextBlock) } : b)) as TextBlock[];

    // Plan 26, A1: scan backwards for the last block whose type is NOT thinking.
    // Placing cache_control on a thinking block causes Anthropic API rejection.
    let targetIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b !== null && typeof b === 'object' && !THINKING_TYPES.has(b.type)) {
            targetIdx = i;
            break;
        }
    }
    if (targetIdx < 0) return null; // all blocks are thinking — skip breakpoint

    blocks[targetIdx].cache_control = EPHEMERAL;
    return blocks;
}

/** A copy of `m` with a breakpoint on its last non-thinking block; null when it already has one or cannot take one. */
function withTrailingBreakpoint(m: BaseMessage): BaseMessage | null {
    if (hasCacheControl(m.content)) return null;
    const blocks = blocksWithTrailingBreakpoint(m.content);
    if (!blocks) return null;
    const content = blocks as any;
    if (isHumanMessage(m)) return new HumanMessage({ content, id: m.id });
    if (isToolMessage(m)) return new ToolMessage({ content, tool_call_id: m.tool_call_id, name: m.name, status: m.status, id: m.id });
    if (isAIMessage(m)) {
        const toolCalls = m.tool_calls;
        return new AIMessage({ content, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}), id: m.id });
    }
    return null;
}

/**
 * Log once per agent how its static prefix (tools + system) compares with the
 * model's minimum. Below it, the system breakpoint caches nothing by itself; the
 * task and conversation breakpoints still cover it once the prefix is longer.
 */
function logStaticPrefix(agentId: string, model: string, systemChars: number, toolsChars: number): void {
    const logged = _activeLoggedAgents();
    if (!agentId || logged.has(`sys:${agentId}`)) return;
    logged.add(`sys:${agentId}`);
    const approxTokens = Math.round((systemChars + toolsChars) / CHARS_PER_TOKEN_ESTIMATE);
    const minTokens = getMinCacheableTokens(model);
    cacheLog.debug(
        `${agentId}: static prefix ≈${approxTokens} tokens (system ${systemChars} + tools ${toolsChars} chars) `
        + (approxTokens < minTokens
            ? `is below the ${minTokens}-token minimum of "${model}" — it is cached with the task and the conversation`
            : `meets the ${minTokens}-token minimum of "${model}"`),
    );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Add a trailing cache breakpoint to a system message.
 *
 * Because Anthropic serialises `tools` before `system`, this single breakpoint
 * caches the tool schemas *and* the persona *and* the injected response schema —
 * the fixed preamble that dominates input cost.
 *
 * Plan 30-06: placed whatever the size of the prompt (the minimum applies to the
 * whole prefix); `model` and `tools` only feed a once-per-agent diagnostic.
 * Returns the original message when it already carries a breakpoint.
 */
export function withSystemCacheBreakpoint(
    systemMessage: SystemMessage,
    opts?: { model?: string; tools?: unknown[]; agentId?: string },
): SystemMessage {
    if (hasCacheControl(systemMessage.content)) return systemMessage;
    const blocks = blocksWithTrailingBreakpoint(systemMessage.content);
    if (!blocks) return systemMessage;
    logStaticPrefix(
        opts?.agentId ?? '', opts?.model ?? '',
        contentChars(systemMessage.content), opts?.tools?.length ? JSON.stringify(opts.tools).length : 0,
    );
    return new SystemMessage({ content: blocks as any });
}

/**
 * Add explicit cache breakpoints to the message list: one on the first human
 * message (the task) and — when automatic caching is off — one on the last
 * message, whose last block then ends the cached conversation prefix.
 *
 * Operates on a copy — the persisted graph state is never mutated, matching the
 * invariant of `compactHistory` and `sanitizeStreamingContentBlocks`.
 *
 * @param opts.autoCache the request carries a top-level `cache_control` (it moves
 *                       along the conversation and takes one of the four slots).
 * @param opts.budget    breakpoints still available after the system message.
 */
export function withMessageCacheBreakpoints(
    messages: BaseMessage[],
    opts: { autoCache: boolean; budget?: number },
): { messages: BaseMessage[]; breakpoints: number } {
    const budget = opts.budget ?? MAX_CACHE_BREAKPOINTS - 1 - (opts.autoCache ? 1 : 0);
    if (budget <= 0 || messages.length === 0) return { messages, breakpoints: 0 };

    const targets: number[] = [];
    const firstHuman = messages.findIndex(isHumanMessage);
    if (firstHuman >= 0) targets.push(firstHuman);
    if (!opts.autoCache && messages.length - 1 !== firstHuman) targets.push(messages.length - 1);

    const out = [...messages];
    let breakpoints = 0;
    for (const i of targets) {
        if (breakpoints >= budget) break;
        const marked = withTrailingBreakpoint(out[i]);
        if (!marked) continue;
        out[i] = marked;
        breakpoints++;
    }
    return { messages: breakpoints > 0 ? out : messages, breakpoints };
}
