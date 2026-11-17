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
 *
 * Plan 30-06:
 *   - An id that is not priced is resolved by its longest priced prefix
 *     (`claude-opus-5-5` → `claude-opus-5`). A model with no priced prefix is
 *     warned about once per run and costs $0 — prices are never invented; pin one
 *     with MODEL_PRICING_OVERRIDES.
 *   - Every usage row is priced with its own cache tokens. The run cost used to
 *     spread the run's cache tokens over the agents by input share.
 *   - `effectiveInputTokens()` weighs input by price relative to uncached input,
 *     the measure the invocation soft landing uses.
 */
import { MODEL_PRICING, type ModelPricingEntry } from '../config';
import { longestIdPrefix } from './model-id';
import { getRunContext } from './run-context';
import { getLogger } from './logger';
import type { RunUsageSummary } from './token-tracker';

const log = getLogger('[Cost]', 220);

// ─── Default cache multipliers ──────────────────────────────────────────────

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

// ─── Pricing resolution (Plan 30-06) ────────────────────────────────────────

/** Token counts of one usage row: a call record, or an agent or model total. */
export interface PricedUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** Input tokens served from the prompt cache (included in `inputTokens`). */
    cacheReadTokens?: number;
    /** Input tokens written to the prompt cache (included in `inputTokens`). */
    cacheCreationTokens?: number;
}

/** Models already warned about as unpriced — per run (RunContext), module default otherwise. */
const _warnedUnpriced = new Set<string>();

function _activeWarned(): Set<string> {
    return getRunContext()?.unpricedModelsWarned ?? _warnedUnpriced;
}

/** Pricing entry for an exact id, else for its longest priced prefix; null when unpriced. */
function lookupPricing(model: string): ModelPricingEntry | null {
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];
    const prefix = longestIdPrefix(model, Object.keys(MODEL_PRICING));
    return prefix ? MODEL_PRICING[prefix] : null;
}

/**
 * Pricing of `model`: the exact entry, else the entry of its longest priced
 * prefix. Null for an unpriced model, which is warned about once per run.
 */
export function resolvePricing(model: string): ModelPricingEntry | null {
    const pricing = lookupPricing(model);
    if (pricing) return pricing;
    const warned = _activeWarned();
    if (!warned.has(model)) {
        warned.add(model);
        log.warn(`No pricing for model "${model}": its calls count as $0, so MAX_RUN_COST_USD and MAX_BRANCH_COST_USD `
            + 'cannot see them. Price it with MODEL_PRICING_OVERRIDES.');
    }
    return null;
}

/** The models among `models` that have no pricing, sorted (the token report lists them). */
export function unpricedModels(models: Iterable<string>): string[] {
    return [...new Set(models)].filter(m => !lookupPricing(m)).sort();
}

/** Input split into its billing buckets. `inputTokens` includes cache reads and writes. */
function inputBuckets(u: Omit<PricedUsage, 'outputTokens'>): { uncached: number; cacheRead: number; cacheWrite: number } {
    const cacheRead = u.cacheReadTokens ?? 0;
    const cacheWrite = u.cacheCreationTokens ?? 0;
    return { uncached: Math.max(0, u.inputTokens - cacheRead - cacheWrite), cacheRead, cacheWrite };
}

/** Cache-read and cache-write price multipliers of a pricing entry (default: Anthropic's published rates). */
export function cacheMultipliers(pricing: ModelPricingEntry | null): { read: number; write: number } {
    return {
        read: pricing?.cacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER,
        write: pricing?.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER,
    };
}

/** USD of one usage row by billing bucket. */
export interface CostBuckets {
    uncached: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Billed USD of one usage row, by bucket — all zero for an unpriced model. */
export function costBuckets(u: PricedUsage): CostBuckets {
    const pricing = resolvePricing(u.model);
    if (!pricing) return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const { read, write } = cacheMultipliers(pricing);
    const { uncached, cacheRead, cacheWrite } = inputBuckets(u);
    const perInputToken = pricing.inputPer1k / 1000;
    return {
        uncached: uncached * perInputToken,
        cacheRead: cacheRead * read * perInputToken,
        cacheWrite: cacheWrite * write * perInputToken,
        output: (u.outputTokens / 1000) * pricing.outputPer1k,
    };
}

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
    const b = costBuckets({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });
    return b.uncached + b.cacheRead + b.cacheWrite + b.output;
}

/** Billed (cache-aware) USD of one usage row. */
export function billedCost(u: PricedUsage): number {
    return estimateCost(u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens);
}

/** List-price USD of one usage row: every input token at the full input rate, no cache discount. */
export function listCost(u: PricedUsage): number {
    const pricing = resolvePricing(u.model);
    if (!pricing) return 0;
    return (u.inputTokens * pricing.inputPer1k + u.outputTokens * pricing.outputPer1k) / 1000;
}

/** Input tokens not served from or written to the prompt cache. */
export function uncachedInputTokens(u: Omit<PricedUsage, 'outputTokens'>): number {
    return inputBuckets(u).uncached;
}

/**
 * Input tokens weighted by their price relative to uncached input (Plan 30-06):
 * uncached + 1.25 × cache write + 0.1 × cache read, with the model's own
 * multipliers when it has them. A cache read costs a tenth of an uncached token,
 * so this is what an invocation really spends.
 */
export function effectiveInputTokens(u: Omit<PricedUsage, 'outputTokens'>): number {
    const { read, write } = cacheMultipliers(lookupPricing(u.model));
    const { uncached, cacheRead, cacheWrite } = inputBuckets(u);
    return uncached + cacheWrite * write + cacheRead * read;
}

/**
 * Estimated USD cost for a whole run summary (cache-aware). Each agent row is
 * one agent on one model and carries its own cache tokens (Plan 30-06), so this
 * equals the sum over the call records.
 */
export function estimateRunCost(summary: RunUsageSummary): number {
    return summary.byAgent.reduce((total, a) => total + billedCost(a), 0);
}
