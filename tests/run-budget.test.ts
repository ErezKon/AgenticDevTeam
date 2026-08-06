/**
 * Run budget guard — unit tests.
 *
 * All tests are pure: no LLM, no git, no network.
 * Uses jest fake timers to test wall-clock limits.
 */

// ─── computeBudgetLevel ─────────────────────────────────────────────────────

describe('computeBudgetLevel', () => {
    // Import the function freshly each time with clean config
    afterEach(() => {
        jest.resetModules();
    });

    it.each([
        [0,    'ok'],
        [0.69, 'ok'],
        [0.70, 'warn'],
        [0.89, 'warn'],
        [0.90, 'degrade'],
        [0.99, 'degrade'],
        [1.0,  'stop'],
        [1.5,  'stop'],
    ])('utilisation=%s → %s', (utilisation, expected) => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
        }));
        const { computeBudgetLevel } = require('../src/utils/run-budget');
        expect(computeBudgetLevel(utilisation)).toBe(expected);
    });
});

// ─── getEffectiveLimits ─────────────────────────────────────────────────────

describe('getEffectiveLimits', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('level=ok returns config values', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 0,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
            MAX_REVIEW_ITERATIONS: 5,
            MAX_BUGFIX_ITERATIONS: 3,
            PR_TEST_REPAIR_ATTEMPTS: 1,
        }));
        const { getEffectiveLimits, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const limits = getEffectiveLimits();
        expect(limits.maxReviewIterations).toBe(5);
        expect(limits.maxReviewers).toBe(2);
        expect(limits.prTestRepairAttempts).toBe(1);
        expect(limits.maxBugfixIterations).toBe(3);
        expect(limits.allowNewBranchWorkflows).toBe(true);
    });

    it('level=warn returns same limits as ok (with log)', () => {
        // To reach warn level, set a token limit and feed data
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 1000,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
            MAX_REVIEW_ITERATIONS: 5,
            MAX_BUGFIX_ITERATIONS: 3,
            PR_TEST_REPAIR_ATTEMPTS: 1,
        }));
        const { tokenTracker } = require('../src/utils/token-tracker');
        tokenTracker.reset();
        // Feed 700 tokens to hit 70% = warn
        tokenTracker.recordCall({
            agentId: 'test', model: 'test-model', phase: 'test',
            inputTokens: 350, outputTokens: 350, totalTokens: 700,
            timestamp: new Date().toISOString(),
        });
        const { getEffectiveLimits, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const limits = getEffectiveLimits();
        expect(limits.maxReviewIterations).toBe(5);
        expect(limits.maxReviewers).toBe(2);
        expect(limits.prTestRepairAttempts).toBe(1);
        expect(limits.maxBugfixIterations).toBe(3);
        expect(limits.allowNewBranchWorkflows).toBe(true);
        tokenTracker.reset();
    });

    it('level=degrade drops review iterations to 1, reviewers to 1, repair/bugfix to 0', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 1000,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
            MAX_REVIEW_ITERATIONS: 5,
            MAX_BUGFIX_ITERATIONS: 3,
            PR_TEST_REPAIR_ATTEMPTS: 1,
        }));
        const { tokenTracker } = require('../src/utils/token-tracker');
        tokenTracker.reset();
        // Feed 900 tokens to hit 90% = degrade
        tokenTracker.recordCall({
            agentId: 'test', model: 'test-model', phase: 'test',
            inputTokens: 450, outputTokens: 450, totalTokens: 900,
            timestamp: new Date().toISOString(),
        });
        const { getEffectiveLimits, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const limits = getEffectiveLimits();
        expect(limits.maxReviewIterations).toBe(1);
        expect(limits.maxReviewers).toBe(1);
        expect(limits.prTestRepairAttempts).toBe(0);
        expect(limits.maxBugfixIterations).toBe(0);
        expect(limits.allowNewBranchWorkflows).toBe(true);
        tokenTracker.reset();
    });

    it('level=stop drops reviewers to 0 and disallows new branch workflows', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 1000,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
            MAX_REVIEW_ITERATIONS: 5,
            MAX_BUGFIX_ITERATIONS: 3,
            PR_TEST_REPAIR_ATTEMPTS: 1,
        }));
        const { tokenTracker } = require('../src/utils/token-tracker');
        tokenTracker.reset();
        // Feed 1000 tokens to hit 100% = stop
        tokenTracker.recordCall({
            agentId: 'test', model: 'test-model', phase: 'test',
            inputTokens: 500, outputTokens: 500, totalTokens: 1000,
            timestamp: new Date().toISOString(),
        });
        const { getEffectiveLimits, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const limits = getEffectiveLimits();
        expect(limits.maxReviewIterations).toBe(1);
        expect(limits.maxReviewers).toBe(0);
        expect(limits.prTestRepairAttempts).toBe(0);
        expect(limits.maxBugfixIterations).toBe(0);
        expect(limits.allowNewBranchWorkflows).toBe(false);
        tokenTracker.reset();
    });
});

// ─── getBudgetStatus ────────────────────────────────────────────────────────

describe('getBudgetStatus', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('all limits 0 → level=ok, binding=none, config values passed through', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 0,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
        }));
        const { getBudgetStatus, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const status = getBudgetStatus();
        expect(status.level).toBe('ok');
        expect(status.binding).toBe('none');
        expect(status.utilisation).toBe(0);
        expect(status.maxTokens).toBe(0);
        expect(status.maxCostUsd).toBe(0);
        expect(status.maxWallMs).toBe(0);
    });

    it('token limit binding: crossing MAX_RUN_TOKENS triggers stop', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 100,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
        }));
        const { tokenTracker } = require('../src/utils/token-tracker');
        tokenTracker.reset();
        tokenTracker.recordCall({
            agentId: 'test', model: 'test-model', phase: 'test',
            inputTokens: 60, outputTokens: 60, totalTokens: 120,
            timestamp: new Date().toISOString(),
        });
        const { getBudgetStatus, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const status = getBudgetStatus();
        expect(status.level).toBe('stop');
        expect(status.binding).toBe('tokens');
        expect(status.usedTokens).toBe(120);
        expect(status.utilisation).toBeGreaterThanOrEqual(1.0);
        tokenTracker.reset();
    });

    it('cost binding: crossing MAX_RUN_COST_USD triggers level change', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 0,
            MAX_RUN_COST_USD: 0.001,
            MAX_RUN_WALL_MS: 0,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
            MODEL_PRICING: {
                'test-model': { inputPer1k: 0.01, outputPer1k: 0.02 },
            },
        }));
        const { tokenTracker } = require('../src/utils/token-tracker');
        tokenTracker.reset();
        // Cost = (500/1000)*0.01 + (500/1000)*0.02 = 0.005 + 0.01 = 0.015
        // This is well above 0.001, so utilisation > 1 → stop
        tokenTracker.recordCall({
            agentId: 'test', model: 'test-model', phase: 'test',
            inputTokens: 500, outputTokens: 500, totalTokens: 1000,
            timestamp: new Date().toISOString(),
        });
        const { getBudgetStatus, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        const status = getBudgetStatus();
        expect(status.level).toBe('stop');
        expect(status.binding).toBe('cost');
        expect(status.estCostUsd).toBeGreaterThan(0);
        tokenTracker.reset();
    });

    it('wall-clock binding: elapsed past MAX_RUN_WALL_MS triggers stop', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 0,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 1000,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
        }));
        const { getBudgetStatus, _setRunStartMs, _resetRunBudget } = require('../src/utils/run-budget');
        _resetRunBudget();
        // Set start time to 2 seconds ago so elapsed > MAX_RUN_WALL_MS (1000ms)
        _setRunStartMs(Date.now() - 2000);
        const status = getBudgetStatus();
        expect(status.level).toBe('stop');
        expect(status.binding).toBe('wall');
        expect(status.elapsedMs).toBeGreaterThanOrEqual(1000);
    });
});

// ─── estimateCost ───────────────────────────────────────────────────────────

describe('estimateCost', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('unknown model returns 0 and does not throw', () => {
        const { estimateCost } = require('../src/utils/cost');
        expect(estimateCost('totally-unknown-model', 1000, 1000)).toBe(0);
    });

    it('known model returns correct cost', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MODEL_PRICING: {
                'test-model': { inputPer1k: 0.01, outputPer1k: 0.02 },
            },
        }));
        const { estimateCost } = require('../src/utils/cost');
        // (2000/1000)*0.01 + (3000/1000)*0.02 = 0.02 + 0.06 = 0.08
        expect(estimateCost('test-model', 2000, 3000)).toBeCloseTo(0.08, 6);
    });

    it('estimateRunCost sums across agents', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MODEL_PRICING: {
                'model-a': { inputPer1k: 0.001, outputPer1k: 0.002 },
                'model-b': { inputPer1k: 0.003, outputPer1k: 0.006 },
            },
        }));
        const { estimateRunCost } = require('../src/utils/cost');
        const summary = {
            totalInputTokens: 5000,
            totalOutputTokens: 5000,
            totalTokens: 10000,
            totalCalls: 2,
            byAgent: [
                { agentId: 'a1', model: 'model-a', callCount: 1, inputTokens: 2000, outputTokens: 2000, totalTokens: 4000 },
                { agentId: 'a2', model: 'model-b', callCount: 1, inputTokens: 3000, outputTokens: 3000, totalTokens: 6000 },
            ],
            byPhase: [],
            byModel: [],
        };
        // a1: (2000/1000)*0.001 + (2000/1000)*0.002 = 0.002 + 0.004 = 0.006
        // a2: (3000/1000)*0.003 + (3000/1000)*0.006 = 0.009 + 0.018 = 0.027
        // total: 0.033
        expect(estimateRunCost(summary)).toBeCloseTo(0.033, 6);
    });
});

// ─── startRunBudget ─────────────────────────────────────────────────────────

describe('startRunBudget', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('resets elapsed time', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_RUN_TOKENS: 0,
            MAX_RUN_COST_USD: 0,
            MAX_RUN_WALL_MS: 10000,
            BUDGET_WARN_AT: 0.70,
            BUDGET_DEGRADE_AT: 0.90,
        }));
        const { startRunBudget, getBudgetStatus, _setRunStartMs } = require('../src/utils/run-budget');
        // Set start time far in the past
        _setRunStartMs(Date.now() - 100_000);
        const before = getBudgetStatus();
        expect(before.elapsedMs).toBeGreaterThanOrEqual(100_000);

        // Now reset
        startRunBudget();
        const after = getBudgetStatus();
        expect(after.elapsedMs).toBeLessThan(1000);
    });
});
