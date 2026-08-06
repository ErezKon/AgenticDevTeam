/**
 * Cost estimation utilities.
 *
 * Extracted from `finalizeNode` so the budget module and the finalize
 * summary can share a single implementation. Unknown models cost $0
 * so the calculation never throws.
 */
import { MODEL_PRICING } from '../config';
import type { RunUsageSummary } from './token-tracker';

// ─── Public API ─────────────────────────────────────────────────────────────

/** Estimated USD cost for one model's token counts. Unknown models cost 0. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

/** Estimated USD cost for a whole run summary. */
export function estimateRunCost(summary: RunUsageSummary): number {
    let total = 0;
    for (const a of summary.byAgent) {
        total += estimateCost(a.model, a.inputTokens, a.outputTokens);
    }
    return total;
}
