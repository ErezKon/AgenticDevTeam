jest.mock('../src/config', () => ({
    MODEL_PRICING: {
        'test-model': { inputPer1k: 0.01, outputPer1k: 0.03 },
        'cached-model': {
            inputPer1k: 0.01,
            outputPer1k: 0.03,
            cacheReadMultiplier: 0.1,
            cacheWriteMultiplier: 1.25,
        },
    },
}));

import { estimateCost, estimateRunCost } from '../src/utils/cost';
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
    it('sums costs across agents with proportional cache distribution', () => {
        const summary: RunUsageSummary = {
            totalInputTokens: 2000,
            totalOutputTokens: 1000,
            totalTokens: 3000,
            totalCalls: 2,
            totalCacheReadTokens: 400,
            totalCacheCreationTokens: 200,
            cacheHitRate: 0.2,
            byAgent: [
                {
                    agentId: 'agent-a',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 1000,    // 50% of totalInput
                    outputTokens: 500,
                    totalTokens: 1500,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
                {
                    agentId: 'agent-b',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 1000,    // 50% of totalInput
                    outputTokens: 500,
                    totalTokens: 1500,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
            ],
            byPhase: [],
            byModel: [],
        };

        // Each agent gets 50% of cache tokens:
        //   agentCacheRead = round(400 * 0.5) = 200
        //   agentCacheWrite = round(200 * 0.5) = 100
        // Per agent (test-model, default multipliers 0.1 read, 1.25 write):
        //   uncachedInput = max(0, 1000 - 200 - 100) = 700
        //   inputCost = (200 * 0.1 * 0.01 + 100 * 1.25 * 0.01 + 700 * 0.01) / 1000
        //            = (0.2 + 1.25 + 7.0) / 1000 = 0.00845
        //   outputCost = 500 / 1000 * 0.03 = 0.015
        //   perAgent = 0.02345
        // Total = 0.02345 * 2 = 0.0469
        const cost = estimateRunCost(summary);
        expect(cost).toBeCloseTo(0.0469, 10);
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

    it('distributes cache tokens proportionally by input share', () => {
        const summary: RunUsageSummary = {
            totalInputTokens: 1000,
            totalOutputTokens: 600,
            totalTokens: 1600,
            totalCalls: 2,
            totalCacheReadTokens: 100,
            totalCacheCreationTokens: 50,
            cacheHitRate: 0.1,
            byAgent: [
                {
                    agentId: 'heavy',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 800,    // 80%
                    outputTokens: 400,
                    totalTokens: 1200,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
                {
                    agentId: 'light',
                    model: 'test-model',
                    callCount: 1,
                    inputTokens: 200,    // 20%
                    outputTokens: 200,
                    totalTokens: 400,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                },
            ],
            byPhase: [],
            byModel: [],
        };

        // heavy: ratio=0.8 => cacheRead=round(100*0.8)=80, cacheWrite=round(50*0.8)=40
        //   uncached = max(0, 800-80-40) = 680
        //   inputCost = (80*0.1*0.01 + 40*1.25*0.01 + 680*0.01)/1000
        //             = (0.08 + 0.5 + 6.8)/1000 = 0.00738
        //   outputCost = 400/1000 * 0.03 = 0.012
        //   sub = 0.01938
        //
        // light: ratio=0.2 => cacheRead=round(100*0.2)=20, cacheWrite=round(50*0.2)=10
        //   uncached = max(0, 200-20-10) = 170
        //   inputCost = (20*0.1*0.01 + 10*1.25*0.01 + 170*0.01)/1000
        //             = (0.02 + 0.125 + 1.7)/1000 = 0.001845
        //   outputCost = 200/1000 * 0.03 = 0.006
        //   sub = 0.007845
        //
        // total = 0.01938 + 0.007845 = 0.027225
        const cost = estimateRunCost(summary);
        expect(cost).toBeCloseTo(0.027225, 10);
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
