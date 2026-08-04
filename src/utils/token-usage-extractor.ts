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
 */
import { AIMessage } from '@langchain/core/messages';
import type { TokenCallRecord } from './token-tracker';

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

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let found = false;

    for (const msg of result.messages) {
        if (!AIMessage.isInstance(msg)) continue;
        const usage = msg.usage_metadata;
        if (!usage || !usage.total_tokens) continue;
        found = true;
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        totalTokens += usage.total_tokens ?? 0;
    }

    if (!found) return null;

    return {
        agentId,
        model,
        phase,
        inputTokens,
        outputTokens,
        totalTokens,
        timestamp: new Date().toISOString(),
    };
}
