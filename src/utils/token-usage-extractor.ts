/**
 * Token usage extraction from LangGraph agent invocation results.
 *
 * Scans all AIMessages in the result for `usage_metadata` and aggregates
 * them into a single per-invocation TokenCallRecord.
 *
 * Note: This does NOT record into the global tokenTracker — the
 * TokenUsageCallbackHandler already handles per-LLM-call recording.
 * This function provides per-agent-invocation aggregated records
 * for incremental state persistence.
 *
 * The normalisation helpers below are shared with `token-callback.ts` so the
 * per-call and per-invocation paths cannot drift (Plan 21, D).
 */
import { AIMessage } from '@langchain/core/messages';
import type { TokenCallRecord } from './token-tracker';

// ─── Shared normalisation helpers ───────────────────────────────────────────

/** Provider-agnostic token totals. */
export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Input tokens served from the provider's prompt cache (Plan 22, D2). */
    cacheReadTokens?: number;
    /** Input tokens written to the provider's prompt cache (Plan 22, D2). */
    cacheCreationTokens?: number;
}

/**
 * Extract cache-token counts from any provider usage shape (Plan 22, D2).
 *
 * These numbers were already present on every Anthropic response and were being
 * discarded, so a total cache miss — 2.32M billed input tokens in the pacmanclaude
 * run with `cache_read: 0` on all 227 calls — was invisible.
 */
function extractCacheTokens(usage: any): { cacheReadTokens: number; cacheCreationTokens: number } {
    const details = usage.input_token_details ?? usage.inputTokenDetails ?? {};
    return {
        cacheReadTokens:
            usage.cache_read_input_tokens ?? details.cache_read ?? details.cacheRead ?? 0,
        cacheCreationTokens:
            usage.cache_creation_input_tokens ?? details.cache_creation ?? details.cacheCreation ?? 0,
    };
}

/**
 * Normalise a single provider usage object into `UsageTotals`.
 *
 * Handles every spelling observed across the providers we support:
 *   - OpenAI Chat Completions:  `{ promptTokens, completionTokens, totalTokens }`
 *   - OpenAI raw / Responses:   `{ prompt_tokens, completion_tokens, total_tokens }`
 *   - Anthropic raw:            `{ input_tokens, output_tokens,
 *                                  cache_creation_input_tokens, cache_read_input_tokens }`
 *   - LangChain `usage_metadata`: `{ input_tokens, output_tokens, total_tokens }`
 *
 * Anthropic's **raw** `input_tokens` excludes cache reads/creations, so those are
 * added back. LangChain's `usage_metadata.input_tokens` already includes them
 * (see `@langchain/anthropic` `buildUsageMetadata`), and is detected via the
 * presence of `total_tokens` / `input_token_details` so they are not counted twice.
 */
export function normaliseUsage(usage: any): UsageTotals | null {
    if (!usage || typeof usage !== 'object') return null;

    let inputTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0;

    // Anthropic raw usage: cache tokens are reported separately from input_tokens.
    // LangChain-normalised usage_metadata has already folded them in.
    const alreadyNormalised = usage.total_tokens != null || usage.totalTokens != null || usage.input_token_details != null;
    if (!alreadyNormalised) {
        inputTokens += (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    }

    const totalTokens = usage.totalTokens ?? usage.total_tokens ?? (inputTokens + outputTokens);
    if (totalTokens === 0) return null;

    return { inputTokens, outputTokens, totalTokens, ...extractCacheTokens(usage) };
}

/**
 * Sum `usage_metadata` across a list of message-like objects.
 *
 * This is where streaming Anthropic and Google Gemini put their usage —
 * `llmOutput` carries nothing for those providers.
 */
export function sumUsageMetadata(messages: any[] | undefined): UsageTotals | null {
    if (!messages?.length) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let found = false;

    for (const msg of messages) {
        const totals = normaliseUsage(msg?.usage_metadata);
        if (!totals) continue;
        found = true;
        inputTokens += totals.inputTokens;
        outputTokens += totals.outputTokens;
        totalTokens += totals.totalTokens;
        cacheReadTokens += totals.cacheReadTokens ?? 0;
        cacheCreationTokens += totals.cacheCreationTokens ?? 0;
    }

    return found
        ? { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheCreationTokens }
        : null;
}

// ─── Per-invocation aggregation ─────────────────────────────────────────────

/**
 * Extract and aggregate token usage from all AIMessages in an agent
 * invocation result into a single TokenCallRecord.
 *
 * Returns null if no usage metadata is found (provider doesn't report it).
 *
 * @param result   The raw result from `agent.invoke()`
 * @param agentId  The agent that produced the result
 * @param model    The model name used
 * @param phase    The pipeline phase
 */
export function extractTokenUsageFromMessages(
    result: { messages?: any[] },
    agentId: string,
    model: string,
    phase: string,
): TokenCallRecord | null {
    if (!result?.messages) return null;

    const totals = sumUsageMetadata(result.messages.filter(m => AIMessage.isInstance(m)));
    if (!totals) return null;

    return {
        agentId,
        model,
        phase,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        timestamp: new Date().toISOString(),
    };
}
