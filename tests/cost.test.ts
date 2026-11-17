jest.mock('../src/config', () => ({
    MODEL_PRICING: {
        'test-model': { inputPer1k: 0.01, outputPer1k: 0.03 },
        'cached-model': {
            inputPer1k: 0.01,
            outputPer1k: 0.03,
            cacheReadMultiplier: 0.1,
            cacheWriteMultiplier: 1.25,
        },
        'claude-opus-5': { inputPer1k: 0.005, outputPer1k: 0.025 },
        'claude-opus-5-1': { inputPer1k: 0.006, outputPer1k: 0.03 },
    },
}));
const mockWarn = jest.fn();
jest.mock('../src/utils/logger', () => ({
    getLogger: () => ({ info: () => undefined, warn: (...args: unknown[]) => mockWarn(...args), error: () => undefined, debug: () => undefined }),
}));

import {
    estimateCost, estimateRunCost, resolvePricing, billedCost, listCost, effectiveInputTokens,
    uncachedInputTokens, unpricedModels,
} from '../src/utils/cost';
import type { RunUsageSummary } from '../src/utils/token-tracker';

// ---- estimateCost -----------------------------------------------------------

describe('estimateCost', () => {
    it('returns 0 for an unknown model', () => {
        expect(estimateCost('nonexistent-model', 1000, 1000)).toBe(0);
    });

    it('computes basic cost without cache tokens', () => {
        // 1000 input * 0.01/1k + 500 output * 0.03/1k = 0.01 + 0.015 = 0.025
        const cost = estimateCost('test-model', 1000, 500);
        expect(cost).toBeCloseTo(0.025, 10);
    });

    it('computes cost with zero tokens', () => {
        expect(estimateCost('test-model', 0, 0)).toBe(0);
    });

    it('applies default cache multipliers when model has none', () => {
        // 'test-model' has no cache multipliers, so defaults apply:
        //   cacheRead = 200, cacheWrite = 100, uncached = 1000 - 200 - 100 = 700
        //   inputCost = (200 * 0.1 * 0.01 + 100 * 1.25 * 0.01 + 700 * 0.01) / 1000
        //            = (0.2 + 1.25 + 7.0) / 1000 = 8.45 / 1000 = 0.00845
        //   outputCost = 500 / 1000 * 0.03 = 0.015
        //   total = 0.02345
        const cost = estimateCost('test-model', 1000, 500, 200, 100);
        expect(cost).toBeCloseTo(0.02345, 10);
    });

    it('applies custom cache multipliers from the pricing entry', () => {
        // 'cached-model' has cacheReadMultiplier=0.1, cacheWriteMultiplier=1.25
        //   cacheRead = 300, cacheWrite = 200, uncached = 1000 - 300 - 200 = 500
        //   inputCost = (300 * 0.1 * 0.01 + 200 * 1.25 * 0.01 + 500 * 0.01) / 1000
        //            = (0.3 + 2.5 + 5.0) / 1000 = 7.8 / 1000 = 0.0078
        //   outputCost = 500 / 1000 * 0.03 = 0.015
        //   total = 0.0228
        const cost = estimateCost('cached-model', 1000, 500, 300, 200);
        expect(cost).toBeCloseTo(0.0228, 10);
    });

    it('clamps uncached input to zero when cache tokens exceed total', () => {
        // cacheRead=600 + cacheWrite=600 > inputTokens=1000
        // uncachedInput = max(0, 1000 - 600 - 600) = 0
        //   inputCost = (600 * 0.1 * 0.01 + 600 * 1.25 * 0.01 + 0) / 1000
        //            = (0.6 + 7.5) / 1000 = 0.0081
        //   outputCost = 0 / 1000 * 0.03 = 0
        const cost = estimateCost('cached-model', 1000, 0, 600, 600);
        expect(cost).toBeCloseTo(0.0081, 10);
    });

    it('treats missing cache tokens as zero', () => {
        const withoutCache = estimateCost('test-model', 1000, 500);
        const withZeroCache = estimateCost('test-model', 1000, 500, 0, 0);
        expect(withoutCache).toBe(withZeroCache);
    });
});

// ---- estimateRunCost --------------------------------------------------------

describe('estimateRunCost', () => {
    it('prices each agent with its OWN cache tokens (Plan 30-06 — no proportional spread)', () => {
        const summary: RunUsageSummary = {
            totalInputTokens: 2000,
            totalOutputTokens: 1000,
            totalTokens: 3000,
            totalCalls: 2,
            totalCacheReadTokens: 300,
            totalCacheCreationTokens: 100,
            cacheHitRate: 0.15,
            byAgent: [
                {
                    agentId: 'agent-a',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 1000,
                    outputTokens: 500,
                    totalTokens: 1500,
                    cacheReadTokens: 300,
                    cacheCreationTokens: 100,
                },
                {
                    agentId: 'agent-b',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 1000,
                    outputTokens: 500,
                    totalTokens: 1500,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
            ],
            byPhase: [],
            byModel: [],
        };

        // agent-a (default multipliers): uncached 600
        //   input = (300*0.1*0.01 + 100*1.25*0.01 + 600*0.01) / 1000 = (0.3 + 1.25 + 6) / 1000 = 0.00755
        //   output = 0.015 → 0.02255
        // agent-b: no cache → 0.01 + 0.015 = 0.025
        // The old proportional spread gave both agents half of the run's cache tokens.
        expect(estimateRunCost(summary)).toBeCloseTo(0.02255 + 0.025, 10);
    });

    it('handles a single-agent summary', () => {
        const summary: RunUsageSummary = {
            totalInputTokens: 1000,
            totalOutputTokens: 500,
            totalTokens: 1500,
            totalCalls: 1,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            cacheHitRate: 0,
            byAgent: [
                {
                    agentId: 'solo',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 1000,
                    outputTokens: 500,
                    totalTokens: 1500,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
            ],
            byPhase: [],
            byModel: [],
        };

        // No cache tokens, basic cost: 0.01 + 0.015 = 0.025
        expect(estimateRunCost(summary)).toBeCloseTo(0.025, 10);
    });

    it('returns 0 when all agents use unknown models', () => {
        const summary: RunUsageSummary = {
            totalInputTokens: 1000,
            totalOutputTokens: 500,
            totalTokens: 1500,
            totalCalls: 1,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            cacheHitRate: 0,
            byAgent: [
                {
                    agentId: 'x',
                    model: 'unknown-model',
                    callCount: 1,
                    inputTokens: 1000,
                    outputTokens: 500,
                    totalTokens: 1500,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
            ],
            byPhase: [],
            byModel: [],
        };

        expect(estimateRunCost(summary)).toBe(0);
    });

    it('equals the sum over call records when each row is one agent on one model', () => {
        const records = [
            { model: 'cached-model', inputTokens: 600, outputTokens: 100, cacheReadTokens: 400, cacheCreationTokens: 0 },
            { model: 'cached-model', inputTokens: 900, outputTokens: 200, cacheReadTokens: 500, cacheCreationTokens: 300 },
        ];
        const summary: RunUsageSummary = {
            totalInputTokens: 1500, totalOutputTokens: 300, totalTokens: 1800, totalCalls: 2,
            totalCacheReadTokens: 900, totalCacheCreationTokens: 300, cacheHitRate: 0.6,
            byAgent: [{
                agentId: 'dev', model: 'cached-model', callCount: 2, inputTokens: 1500, outputTokens: 300,
                totalTokens: 1800, cacheReadTokens: 900, cacheCreationTokens: 300,
            }],
            byPhase: [],
            byModel: [],
        };
        expect(estimateRunCost(summary)).toBeCloseTo(billedCost(records[0]) + billedCost(records[1]), 12);
    });

    it('handles empty byAgent array', () => {
        const summary: RunUsageSummary = {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            totalCalls: 0,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            cacheHitRate: 0,
            byAgent: [],
            byPhase: [],
            byModel: [],
        };
        expect(estimateRunCost(summary)).toBe(0);
    });
});

// ---- Plan 30-06: pricing resolution -----------------------------------------

describe('resolvePricing (Plan 30-06)', () => {
    beforeEach(() => mockWarn.mockClear());

    it('resolves a point release by its longest priced prefix', () => {
        // claude-opus-5-5 was priced at $0 in the claudeopus5 run (exact match only)
        expect(resolvePricing('claude-opus-5-5')).toEqual({ inputPer1k: 0.005, outputPer1k: 0.025 });
        expect(resolvePricing('claude-opus-5-1-20260301')).toEqual({ inputPer1k: 0.006, outputPer1k: 0.03 });
        expect(estimateCost('claude-opus-5-5', 1000, 1000)).toBeCloseTo(0.03, 10);
    });

    it('matches a prefix only at a separator', () => {
        expect(resolvePricing('claude-opus-50')).toBeNull();
        expect(resolvePricing('test-modelx')).toBeNull();
    });

    it('never invents a price: unpriced models cost 0, with one warning per model', () => {
        expect(estimateCost('mystery-model-9', 1000, 1000)).toBe(0);
        expect(estimateCost('mystery-model-9', 5000, 5000)).toBe(0);
        const warnings = mockWarn.mock.calls.filter(([msg]) => String(msg).includes('mystery-model-9'));
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0][0])).toContain('MODEL_PRICING_OVERRIDES');
    });

    it('lists the unpriced models among a set', () => {
        expect(unpricedModels(['test-model', 'claude-opus-5-5', 'zeta-x', 'alpha-y', 'zeta-x'])).toEqual(['alpha-y', 'zeta-x']);
    });
});

describe('list price, billed cost, effective input (Plan 30-06)', () => {
    const call = { model: 'test-model', inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 8_000, cacheCreationTokens: 1_000 };

    it('list price bills every input token at the full rate', () => {
        // (10000 * 0.01 + 1000 * 0.03) / 1000
        expect(listCost(call)).toBeCloseTo(0.13, 10);
    });

    it('billed cost applies the cache multipliers, so the saving is list − billed', () => {
        // uncached 1000 → 0.01; read 8000 × 0.1 → 0.008; write 1000 × 1.25 → 0.0125; output 0.03
        expect(billedCost(call)).toBeCloseTo(0.0605, 10);
        expect(listCost(call) - billedCost(call)).toBeCloseTo(0.0695, 10);
    });

    it('effective input weighs cache reads at 0.1 and writes at 1.25', () => {
        expect(uncachedInputTokens(call)).toBe(1_000);
        // 1000 + 1.25 × 1000 + 0.1 × 8000
        expect(effectiveInputTokens(call)).toBeCloseTo(3_050, 10);
    });

    it('effective input equals raw input without caching, and uses default multipliers for unpriced models', () => {
        expect(effectiveInputTokens({ model: 'test-model', inputTokens: 5_000 })).toBe(5_000);
        expect(effectiveInputTokens({ model: 'no-price', inputTokens: 2_000, cacheReadTokens: 1_000 })).toBeCloseTo(1_100, 10);
    });
});
