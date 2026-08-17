/**
 * Anthropic prompt caching (Plan 22, D1).
 *
 * ## Why
 *
 * In the pacmanclaude run every one of the 227 Anthropic calls reported
 * `input_token_details = { cache_read: 0, cache_creation: 0 }`. The persona, the
 * tool schemas, the injected JSON response schema and the task context — roughly
 * 6 kB that is byte-identical on every turn of an invocation — were re-billed at
 * full price each time. The run's input:output token ratio was **23:1**
 * (2,320,436 in / 99,731 out) for a single branch of fifteen.
 *
 * ## How
 *
 * Anthropic assembles a request as `tools` → `system` → `messages` and caches the
 * longest matching prefix ending at a `cache_control` breakpoint (max 4 per
 * request). We place three:
 *
 *   1. **end of the system message** — this also covers `tools`, because tools are
 *      serialised *before* `system`. One breakpoint, both blocks of fixed overhead.
 *   2. **end of the first human message** — the task + architecture context, fixed
 *      for the whole invocation.
 *   3. **rolling breakpoint on the newest AI message outside the recent window** —
 *      the compacted history prefix, which only changes when the window slides.
 *
 * `@langchain/anthropic@1.5.x` forwards `cache_control` from any content block
 * verbatim (`utils/message_inputs.js`), and passes `SystemMessage.content` through
 * to the `system` request field unchanged, so block-level breakpoints are the
 * supported mechanism.
 */
import {
    AIMessage,
    HumanMessage,
    SystemMessage,
    isAIMessage,
    isHumanMessage,
    type BaseMessage,
} from '@langchain/core/messages';
import { HISTORY_KEEP_RECENT_TURNS } from '../../config';
import { findTurnBoundary } from './history-compactor';
import { getLogger } from '../../utils/logger';

const cacheLog = getLogger('[prompt-cache]', 226);

/** Anthropic's hard limit on `cache_control` breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

// ─── Model-aware cache minimums (Plan 24, C2) ──────────────────────────────

/**
 * Minimum token count for a cacheable prefix, by model family.
 * Anthropic documents different minimums per model tier.
 */
export const CACHE_MIN_TOKENS_BY_FAMILY: Record<string, number> = {
    haiku: 2048,
    sonnet: 1024,
    opus: 1024,
};

/**
 * Return the minimum cacheable token count for a model name.
 * Matches model name against known family patterns; defaults to 1024.
 */
export function getMinCacheableTokens(model: string): number {
    const lower = model.toLowerCase();
    for (const [family, minTokens] of Object.entries(CACHE_MIN_TOKENS_BY_FAMILY)) {
        if (lower.includes(family)) return minTokens;
    }
    return 1024;
}

/** Rough chars-per-token estimate for the minimum check. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

const EPHEMERAL = { type: 'ephemeral' as const };

/** Set of agent IDs for which we have already logged breakpoint placement. */
const _breakpointLoggedAgents = new Set<string>();

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
 * Return the message's content as a block array with `cache_control: ephemeral`
 * on the final block. String content is promoted to a single text block.
 */
function blocksWithTrailingBreakpoint(content: unknown): TextBlock[] | null {
    if (typeof content === 'string') {
        if (content.length === 0) return null;
        return [{ type: 'text', text: content, cache_control: EPHEMERAL }];
    }
    if (!Array.isArray(content) || content.length === 0) return null;
    const blocks = content.map(b => (b !== null && typeof b === 'object' ? { ...(b as TextBlock) } : b)) as TextBlock[];
    const last = blocks[blocks.length - 1];
    if (last === null || typeof last !== 'object') return null;
    last.cache_control = EPHEMERAL;
    return blocks;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Add a trailing cache breakpoint to a system message.
 *
 * Because Anthropic serialises `tools` before `system`, this single breakpoint
 * caches the tool schemas *and* the persona *and* the injected response schema —
 * the fixed preamble that dominates input cost.
 *
 * Plan 24, C2: accepts `model` and `tools` parameters. The minimum threshold is
 * model-aware and the combined char count of tools + system message is checked
 * (not just the system message alone) because tools are serialised first and
 * form part of the cached prefix.
 *
 * Returns the original message when it is too small to be worth caching or
 * already carries a breakpoint.
 */
export function withSystemCacheBreakpoint(
    systemMessage: SystemMessage,
    opts?: { model?: string; tools?: unknown[]; agentId?: string },
): SystemMessage {
    const model = opts?.model ?? '';
    const agentId = opts?.agentId ?? '';
    const minTokens = getMinCacheableTokens(model);
    const minChars = minTokens * CHARS_PER_TOKEN_ESTIMATE;

    // Plan 24, C2: count tools + system message content together
    const systemChars = contentChars(systemMessage.content);
    const toolsChars = opts?.tools?.length ? JSON.stringify(opts.tools).length : 0;
    const combinedChars = systemChars + toolsChars;

    if (combinedChars < minChars) {
        if (agentId && !_breakpointLoggedAgents.has(`sys:${agentId}`)) {
            _breakpointLoggedAgents.add(`sys:${agentId}`);
            cacheLog.debug(
                `${agentId}: system breakpoint skipped — combined ${combinedChars} chars < ${minChars} min `
                + `(model="${model}", family min=${minTokens} tokens)`,
            );
        }
        return systemMessage;
    }
    if (hasCacheControl(systemMessage.content)) return systemMessage;
    const blocks = blocksWithTrailingBreakpoint(systemMessage.content);
    if (!blocks) return systemMessage;

    if (agentId && !_breakpointLoggedAgents.has(`sys:${agentId}`)) {
        _breakpointLoggedAgents.add(`sys:${agentId}`);
        cacheLog.debug(
            `${agentId}: system breakpoint placed — combined ${combinedChars} chars >= ${minChars} min `
            + `(system=${systemChars}, tools=${toolsChars}, model="${model}")`,
        );
    }
    return new SystemMessage({ content: blocks as any });
}

/**
 * Add cache breakpoints to the message list: one on the first human message (the
 * task) and one rolling breakpoint on the newest AI message that sits outside the
 * recent window.
 *
 * Operates on a copy — the persisted graph state is never mutated, matching the
 * invariant of `compactHistory` and `sanitizeStreamingContentBlocks`.
 *
 * Plan 24, C2: accepts `model` for model-aware minimum threshold.
 *
 * @param budget breakpoints still available after the system message.
 */
export function withMessageCacheBreakpoints(
    messages: BaseMessage[],
    budget: number = MAX_CACHE_BREAKPOINTS - 1,
    opts?: { model?: string; agentId?: string },
): { messages: BaseMessage[]; breakpoints: number } {
    if (budget <= 0 || messages.length === 0) return { messages, breakpoints: 0 };

    const model = opts?.model ?? '';
    const minTokens = getMinCacheableTokens(model);
    const minChars = minTokens * CHARS_PER_TOKEN_ESTIMATE;

    const targets = new Set<number>();

    // 1. The first human message — the task and its context.
    const firstHuman = messages.findIndex(isHumanMessage);
    if (firstHuman >= 0 && contentChars(messages[firstHuman].content) >= minChars) {
        targets.add(firstHuman);
    }

    // 2. Rolling breakpoint: newest AI message strictly before the recent window.
    //    Everything up to it is a stable prefix that survives until the window slides.
    if (targets.size < budget) {
        const boundary = findTurnBoundary(messages, HISTORY_KEEP_RECENT_TURNS);
        for (let i = Math.min(boundary, messages.length) - 1; i > firstHuman; i--) {
            const m = messages[i];
            if (!isAIMessage(m)) continue;
            if (contentChars(m.content) < minChars) continue;
            targets.add(i);
            break;
        }
    }

    if (targets.size === 0) return { messages, breakpoints: 0 };

    let breakpoints = 0;
    const out = messages.map((m, i) => {
        if (!targets.has(i) || breakpoints >= budget) return m;
        if (hasCacheControl(m.content)) return m;
        const blocks = blocksWithTrailingBreakpoint(m.content);
        if (!blocks) return m;
        breakpoints++;
        if (isHumanMessage(m)) return new HumanMessage({ content: blocks as any, id: m.id });
        const toolCalls = (m as AIMessage).tool_calls;
        return new AIMessage({
            content: blocks as any,
            ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
            id: m.id,
        });
    });

    return { messages: breakpoints > 0 ? out : messages, breakpoints };
}
