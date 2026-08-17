/**
 * Cost estimation utilities.
 *
 * Extracted from `finalizeNode` so the budget module and the finalize
 * summary can share a single implementation. Unknown models cost $0
 * so the calculation never throws.
 *
 * Plan 24, C3: cache-aware pricing.  When cache token counts are provided the
 * formula splits input tokens into three buckets:
 *   - cache reads  × cacheReadMultiplier  (default 0.1)
 *   - cache writes × cacheWriteMultiplier (default 1.25)
 *   - remaining    × 1.0
 */
import { MODEL_PRICING } from '../config';
import type { RunUsageSummary } from './token-tracker';

// ─── Default cache multipliers ──────────────────────────────────────────────

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Estimated USD cost for one model's token counts. Unknown models cost 0.
 *
 * Plan 24, C3: when `cacheReadTokens` and/or `cacheCreationTokens` are provided
 * the input cost is split into cache-read, cache-write, and uncached buckets
 * with appropriate multipliers.
 */
export function estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;

    const cacheRead = cacheReadTokens ?? 0;
    const cacheWrite = cacheCreationTokens ?? 0;
    const readMul = pricing.cacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER;
    const writeMul = pricing.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER;

    // Uncached input = total input minus cache-read and cache-write tokens
    const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheWrite);

    const inputCost = (
        cacheRead * readMul * pricing.inputPer1k
        + cacheWrite * writeMul * pricing.inputPer1k
        + uncachedInput * pricing.inputPer1k
    ) / 1000;

    const outputCost = (outputTokens / 1000) * pricing.outputPer1k;
    return inputCost + outputCost;
}

/**
 * Estimated USD cost at full list price (no cache discounts).
 * Used by the token report to show savings from caching.
 */
export function estimateListCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

/** Estimated USD cost for a whole run summary (cache-aware). */
export function estimateRunCost(summary: RunUsageSummary): number {
    let total = 0;
    // Use per-agent totals; cache tokens are only available at the run level,
    // so we distribute proportionally.
    const totalInput = summary.totalInputTokens || 1;
    const runCacheRead = summary.totalCacheReadTokens ?? 0;
    const runCacheWrite = summary.totalCacheCreationTokens ?? 0;
    for (const a of summary.byAgent) {
        // Proportional share of cache tokens for this agent
        const ratio = a.inputTokens / totalInput;
        const agentCacheRead = Math.round(runCacheRead * ratio);
        const agentCacheWrite = Math.round(runCacheWrite * ratio);
        total += estimateCost(a.model, a.inputTokens, a.outputTokens, agentCacheRead, agentCacheWrite);
    }
    return total;
}

/**
 * Estimated full list-price cost for a whole run summary (no cache discounts).
 * Used alongside `estimateRunCost` to show the savings from prompt caching.
 */
export function estimateRunListCost(summary: RunUsageSummary): number {
    let total = 0;
    for (const a of summary.byAgent) {
        total += estimateListCost(a.model, a.inputTokens, a.outputTokens);
    }
    return total;
}
