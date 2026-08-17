/**
 * Run diagnosis report — automated failure-cause summary (Sub-Plan G3).
 *
 * Produces `run-diagnosis.md` containing:
 * 1. Per-agent cost table
 * 2. Per-invocation outliers (2x+ median in turns or tokens)
 * 3. Cache hit rate (overall + per-agent)
 * 4. Budget utilisation
 * 5. Top warning/error patterns from events
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import { estimateCost } from './cost';
import type { RunUsageSummary } from './token-tracker';
import { tokenTracker } from './token-tracker';
import type { BudgetStatus } from './run-budget';
import type { RunEvent } from './event-bus';

const log = getLogger('[RunDiagnosis]', 178);

// ─── Helpers ────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
    if (total === 0) return '0.0';
    return ((n / total) * 100).toFixed(1);
}

function usd(n: number): string {
    return `$${n.toFixed(4)}`;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a `run-diagnosis.md` file with cost, efficiency, cache, budget,
 * and error-pattern analysis. Returns the file path written.
 */
export function generateRunDiagnosis(
    outputPath: string,
    tokenSummary: RunUsageSummary,
    budgetStatus: BudgetStatus,
    events: RunEvent[],
    logPath?: string,
): string {
    const lines: string[] = [];
    lines.push('# Run Diagnosis');
    lines.push('');

    // ── 1. Per-agent cost table ─────────────────────────────────────────
    lines.push('## Per-Agent Cost');
    lines.push('');
    lines.push('| Agent | Model | Calls | Input | Output | USD | Share% |');
    lines.push('|-------|-------|------:|------:|-------:|----:|-------:|');

    const totalCost = tokenSummary.byAgent.reduce(
        (sum, a) => sum + estimateCost(a.model, a.inputTokens, a.outputTokens), 0,
    );

    for (const a of tokenSummary.byAgent) {
        const cost = estimateCost(a.model, a.inputTokens, a.outputTokens);
        const share = pct(cost, totalCost);
        lines.push(
            `| ${a.agentId} | ${a.model} | ${a.callCount} | ` +
            `${a.inputTokens.toLocaleString()} | ${a.outputTokens.toLocaleString()} | ` +
            `${usd(cost)} | ${share}% |`,
        );
    }
    lines.push(`| **Total** | | **${tokenSummary.totalCalls}** | ` +
        `**${tokenSummary.totalInputTokens.toLocaleString()}** | ` +
        `**${tokenSummary.totalOutputTokens.toLocaleString()}** | ` +
        `**${usd(totalCost)}** | 100.0% |`);
    lines.push('');

    // ── 2. Per-invocation outliers ──────────────────────────────────────
    lines.push('## Per-Invocation Outliers');
    lines.push('');
    lines.push('Invocations that exceeded the median by 2x+ in turns or tokens.');
    lines.push('');

    const invocationRows = tokenTracker.getInvocationSummaries();
    if (invocationRows.length > 0) {
        const callCounts = invocationRows.map(r => r.avgCallsPerInvocation);
        const inputAmounts = invocationRows.map(r => r.avgInputPerCall);
        const medianCalls = median(callCounts);
        const medianInput = median(inputAmounts);

        const outliers = invocationRows.filter(
            r => r.avgCallsPerInvocation >= medianCalls * 2 || r.avgInputPerCall >= medianInput * 2,
        );

        if (outliers.length > 0) {
            lines.push('| Agent | Invocations | Avg Calls/Inv | Avg Input/Call | Growth | Reason |');
            lines.push('|-------|------------:|--------------:|---------------:|-------:|--------|');
            for (const r of outliers) {
                const reasons: string[] = [];
                if (r.avgCallsPerInvocation >= medianCalls * 2) {
                    reasons.push(`calls ${r.avgCallsPerInvocation.toFixed(1)} vs median ${medianCalls.toFixed(1)}`);
                }
                if (r.avgInputPerCall >= medianInput * 2) {
                    reasons.push(`input ${r.avgInputPerCall.toLocaleString()} vs median ${medianInput.toLocaleString()}`);
                }
                lines.push(
                    `| ${r.agentId} | ${r.invocations} | ${r.avgCallsPerInvocation.toFixed(1)} | ` +
                    `${r.avgInputPerCall.toLocaleString()} | ${r.growthFactor}x | ${reasons.join('; ')} |`,
                );
            }
        } else {
            lines.push('No outliers detected (all invocations within 2x of the median).');
        }
    } else {
        lines.push('No invocation data recorded.');
    }
    lines.push('');

    // ── 3. Cache hit rate ───────────────────────────────────────────────
    lines.push('## Cache Hit Rate');
    lines.push('');

    const overallRate = tokenSummary.cacheHitRate;
    lines.push(`**Overall:** ${(overallRate * 100).toFixed(1)}% of input tokens served from cache`);
    lines.push(`  - Cache read tokens: ${tokenSummary.totalCacheReadTokens.toLocaleString()}`);
    lines.push(`  - Cache creation tokens: ${tokenSummary.totalCacheCreationTokens.toLocaleString()}`);
    lines.push('');

    // Per-agent cache stats (computed from the raw ledger snapshot)
    const snapshot = tokenTracker.getSnapshot();
    const agentCacheMap = new Map<string, { input: number; cacheRead: number }>();
    for (const r of snapshot) {
        const entry = agentCacheMap.get(r.agentId) ?? { input: 0, cacheRead: 0 };
        entry.input += r.inputTokens;
        entry.cacheRead += (r.cacheReadTokens ?? 0);
        agentCacheMap.set(r.agentId, entry);
    }

    if (agentCacheMap.size > 0) {
        lines.push('| Agent | Input Tokens | Cache Read | Hit Rate |');
        lines.push('|-------|------------:|-----------:|---------:|');
        for (const [agentId, stats] of [...agentCacheMap.entries()].sort((a, b) => b[1].input - a[1].input)) {
            const hitRate = stats.input > 0 ? (stats.cacheRead / stats.input * 100).toFixed(1) : '0.0';
            lines.push(`| ${agentId} | ${stats.input.toLocaleString()} | ${stats.cacheRead.toLocaleString()} | ${hitRate}% |`);
        }
    }
    lines.push('');

    // ── 4. Budget utilisation ───────────────────────────────────────────
    lines.push('## Budget Utilisation');
    lines.push('');

    lines.push(`| Metric | Value | Limit | Utilisation |`);
    lines.push(`|--------|------:|------:|------------:|`);
    lines.push(`| Tokens | ${budgetStatus.usedTokens.toLocaleString()} | ${budgetStatus.maxTokens === 0 ? 'unlimited' : budgetStatus.maxTokens.toLocaleString()} | ${budgetStatus.maxTokens > 0 ? pct(budgetStatus.usedTokens, budgetStatus.maxTokens) + '%' : 'n/a'} |`);
    lines.push(`| Cost | ${usd(budgetStatus.estCostUsd)} | ${budgetStatus.maxCostUsd === 0 ? 'unlimited' : usd(budgetStatus.maxCostUsd)} | ${budgetStatus.maxCostUsd > 0 ? pct(budgetStatus.estCostUsd, budgetStatus.maxCostUsd) + '%' : 'n/a'} |`);

    const elapsedSec = Math.round(budgetStatus.elapsedMs / 1000);
    const maxSec = budgetStatus.maxWallMs > 0 ? Math.round(budgetStatus.maxWallMs / 1000) : 0;
    lines.push(`| Wall clock | ${elapsedSec}s | ${maxSec === 0 ? 'unlimited' : maxSec + 's'} | ${maxSec > 0 ? pct(budgetStatus.elapsedMs, budgetStatus.maxWallMs) + '%' : 'n/a'} |`);
    lines.push('');

    lines.push(`**Binding limit:** ${budgetStatus.binding}`);
    lines.push(`**Final level:** ${budgetStatus.level}`);
    lines.push(`**Overall utilisation:** ${(budgetStatus.utilisation * 100).toFixed(1)}%`);
    lines.push('');

    // ── 5. Top warning/error patterns ───────────────────────────────────
    lines.push('## Top Warning/Error Patterns');
    lines.push('');

    // Aggregate event types that indicate problems
    const warningTypes = new Set<string>([
        'run:error', 'run:blocked',
        'pr:blocked', 'pr:conflict',
        'agent:budget-exhausted', 'agent:respawn',
        'integrity:finding',
        'review:abstained',
        'devops:fallback',
    ]);

    const typeCounts = new Map<string, number>();
    for (const e of events) {
        if (warningTypes.has(e.type)) {
            typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
        }
    }

    if (typeCounts.size > 0) {
        const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
        lines.push('| Event Type | Count |');
        lines.push('|------------|------:|');
        for (const [type, count] of sorted) {
            lines.push(`| ${type} | ${count} |`);
        }
    } else {
        lines.push('No warning or error events recorded.');
    }
    lines.push('');

    if (logPath) {
        lines.push(`---`);
        lines.push(`Full run log: \`${logPath}\``);
        lines.push('');
    }

    // ── Write to disk ───────────────────────────────────────────────────
    const md = lines.join('\n');
    const dest = path.join(outputPath, 'run-diagnosis.md');
    try {
        fs.writeFileSync(dest, md, 'utf-8');
        log.info(`Run diagnosis written: ${dest}`);
    } catch (err: any) {
        log.warn(`Failed to write run diagnosis: ${err?.message ?? err}`);
    }
    return dest;
}
