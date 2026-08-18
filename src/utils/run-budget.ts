/**
 * Run budget guard — graceful degradation when a run approaches its
 * token, cost, or wall-clock ceiling (fixes the A9 cost ceiling gap).
 *
 * Instead of running unbounded or killing a run outright, the budget
 * guard sheds the most expensive optional work (extra review rounds,
 * second reviewers, repair attempts, bug-fix loops) as a run
 * approaches its ceiling, so the pipeline can still reach `finalize`
 * and produce reports.
 *
 * Defaults of `0` (disabled) mean this module is inert until someone
 * opts in — deliberate, so it cannot surprise an existing run.
 */
import {
    MAX_RUN_TOKENS, MAX_RUN_COST_USD, MAX_RUN_WALL_MS,
    BUDGET_WARN_AT, BUDGET_DEGRADE_AT,
    MAX_REVIEW_ITERATIONS, MAX_BUGFIX_ITERATIONS,
    PR_TEST_REPAIR_ATTEMPTS,
} from '../config';
import { tokenTracker } from './token-tracker';
import { estimateRunCost } from './cost';
import { getLogger } from './logger';
import { emitRunEvent } from './event-bus';

const log = getLogger('[RunBudget]', 214);

// ─── Types ──────────────────────────────────────────────────────────────────

export type BudgetLevel = 'ok' | 'warn' | 'degrade' | 'stop';

export interface BudgetStatus {
    level: BudgetLevel;
    usedTokens: number;
    maxTokens: number;
    estCostUsd: number;
    maxCostUsd: number;
    elapsedMs: number;
    maxWallMs: number;
    /** Which limit is closest to being breached. */
    binding: 'tokens' | 'cost' | 'wall' | 'none';
    /** Highest utilisation across all three limits, 0..1+. */
    utilisation: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

let _runStartMs = Date.now();
let _lastLoggedLevel: BudgetLevel = 'ok';
/** Accumulated paused time (ms) excluded from wall utilisation (Plan 24, D4). */
let _pausedMs = 0;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Pure: level from utilisation. warn >= BUDGET_WARN_AT, degrade >= BUDGET_DEGRADE_AT, stop >= 1.0. */
export function computeBudgetLevel(utilisation: number): BudgetLevel {
    if (utilisation >= 1.0) return 'stop';
    if (utilisation >= BUDGET_DEGRADE_AT) return 'degrade';
    if (utilisation >= BUDGET_WARN_AT) return 'warn';
    return 'ok';
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/** Call once at run start (from intakeNode) to stamp the wall-clock origin. */
export function startRunBudget(): void {
    _runStartMs = Date.now();
    _lastLoggedLevel = 'ok';
    _pausedMs = 0;
    log.info('Run budget started');
}

// ─── Pause Accounting (Plan 24, D4) ─────────────────────────────────────────

// ─── Status ─────────────────────────────────────────────────────────────────

export function getBudgetStatus(): BudgetStatus {
    const summary = tokenTracker.getRunSummary();
    const usedTokens = summary.totalTokens;
    const estCostUsd = estimateRunCost(summary);
    // Plan 24 D4: subtract paused time from elapsed wall clock
    const elapsedMs = Math.max(0, Date.now() - _runStartMs - _pausedMs);

    // Compute per-limit utilisation (0 = disabled → 0 utilisation)
    const tokenUtil = MAX_RUN_TOKENS > 0 ? usedTokens / MAX_RUN_TOKENS : 0;
    const costUtil = MAX_RUN_COST_USD > 0 ? estCostUsd / MAX_RUN_COST_USD : 0;
    const wallUtil = MAX_RUN_WALL_MS > 0 ? elapsedMs / MAX_RUN_WALL_MS : 0;

    // The binding limit is whichever is closest to being breached
    let binding: 'tokens' | 'cost' | 'wall' | 'none' = 'none';
    let utilisation = 0;
    if (tokenUtil >= utilisation) { utilisation = tokenUtil; binding = 'tokens'; }
    if (costUtil > utilisation) { utilisation = costUtil; binding = 'cost'; }
    if (wallUtil > utilisation) { utilisation = wallUtil; binding = 'wall'; }

    // When all limits are 0 (disabled), binding stays 'none' and utilisation stays 0
    if (MAX_RUN_TOKENS === 0 && MAX_RUN_COST_USD === 0 && MAX_RUN_WALL_MS === 0) {
        binding = 'none';
        utilisation = 0;
    }

    const level = computeBudgetLevel(utilisation);

    // Log each level transition exactly once
    if (level !== _lastLoggedLevel) {
        const logLevel = level === 'stop' ? 'error' : 'warn';
        if (level !== 'ok') {
            log[logLevel](
                `Budget level: ${_lastLoggedLevel} → ${level} — binding=${binding}, ` +
                `utilisation=${(utilisation * 100).toFixed(1)}%, ` +
                `tokens=${usedTokens.toLocaleString()}/${MAX_RUN_TOKENS || '∞'}, ` +
                `cost=$${estCostUsd.toFixed(4)}/${MAX_RUN_COST_USD || '∞'}, ` +
                `wall=${(elapsedMs / 1000).toFixed(0)}s/${MAX_RUN_WALL_MS ? (MAX_RUN_WALL_MS / 1000).toFixed(0) + 's' : '∞'}`,
            );
        }
        _lastLoggedLevel = level;
        emitRunEvent('budget:level', { level, binding, utilisation, usedTokens, estCostUsd, elapsedMs });
    }

    return {
        level,
        usedTokens,
        maxTokens: MAX_RUN_TOKENS,
        estCostUsd,
        maxCostUsd: MAX_RUN_COST_USD,
        elapsedMs,
        maxWallMs: MAX_RUN_WALL_MS,
        binding,
        utilisation,
    };
}

// ─── Effective Limits ───────────────────────────────────────────────────────

/**
 * Cost-shaping limits adjusted for the current budget level.
 *
 * Read these instead of importing the config constants directly, so a run
 * approaching its ceiling sheds the most expensive optional work (extra review
 * rounds, second reviewers, repair attempts, bug-fix loops) instead of being
 * killed outright or running unbounded (PART A9).
 *
 * Degradation ladder:
 *
 * | level   | reviewIterations | reviewers | repairAttempts | bugfixIterations | new branch workflows |
 * |---------|------------------|-----------|----------------|------------------|----------------------|
 * | ok      | config           | 2         | config         | config           | yes                  |
 * | warn    | config           | 2         | config         | config           | yes (log WARN once)  |
 * | degrade | 1                | 1         | 0              | 0                | yes                  |
 * | stop    | 1                | 0         | 0              | 0                | no                   |
 */
export function getEffectiveLimits(): {
    maxReviewIterations: number;
    maxReviewers: number;
    prTestRepairAttempts: number;
    maxBugfixIterations: number;
    allowNewBranchWorkflows: boolean;
} {
    const { level } = getBudgetStatus();

    switch (level) {
        case 'ok':
        case 'warn':
            return {
                maxReviewIterations: MAX_REVIEW_ITERATIONS,
                maxReviewers: 2,
                prTestRepairAttempts: PR_TEST_REPAIR_ATTEMPTS,
                maxBugfixIterations: MAX_BUGFIX_ITERATIONS,
                allowNewBranchWorkflows: true,
            };
        case 'degrade':
            return {
                maxReviewIterations: 1,
                maxReviewers: 1,
                prTestRepairAttempts: 0,
                maxBugfixIterations: 0,
                allowNewBranchWorkflows: true,
            };
        case 'stop':
            return {
                maxReviewIterations: 1,
                maxReviewers: 0,
                prTestRepairAttempts: 0,
                maxBugfixIterations: 0,
                allowNewBranchWorkflows: false,
            };
    }
}

// ─── Run-level budget check (Plan 25) ───────────────────────────────────────

/**
 * Returns `true` when the run budget has reached the 'stop' level,
 * indicating that the run should cease starting new work and route to finalize.
 * Returns `false` when all budgets are disabled (level='ok').
 */
export function shouldStopRun(): boolean {
    const { level } = getBudgetStatus();
    return level === 'stop';
}

// ─── Invocation Budget Error (Plan 24, D1) ──────────────────────────────────

/**
 * Thrown when a single agent invocation exceeds MAX_INVOCATION_INPUT_TOKENS.
 * Handled like ToolBudgetExhaustedError — commits are already durable, the
 * agent stops gracefully.
 */
export class InvocationBudgetExceededError extends Error {
    constructor(
        public readonly invocationId: string,
        public readonly inputTokens: number,
        public readonly ceiling: number,
    ) {
        super(
            `Invocation "${invocationId}" exceeded input token ceiling: `
            + `${inputTokens.toLocaleString()} / ${ceiling.toLocaleString()}`,
        );
        this.name = 'InvocationBudgetExceededError';
    }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset the run budget state (for testing only). */
export function _resetRunBudget(): void {
    _runStartMs = Date.now();
    _lastLoggedLevel = 'ok';
    _pausedMs = 0;
}

/** Override the run start time (for testing only). */
export function _setRunStartMs(ms: number): void {
    _runStartMs = ms;
}
