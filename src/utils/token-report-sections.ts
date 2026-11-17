/**
 * Token report sections (Plan 30-06): the report's cost model and the
 * attribution tables, kept out of token-report.ts (its HTML template).
 *
 * Fixes and additions over the Plan 24 report:
 *   - "List price" is the list price (every input token at the full rate). It was
 *     the sum of the agents' billed costs, so the cache savings showed $1.10
 *     where the claudeopus5 run really saved about $12.
 *   - Billed cost is priced per call record, each with its own cache tokens.
 *   - Effective input (cache-weighted) and the median uncached input per call:
 *     the measures the prompt-cache work is judged by.
 *   - Tokens by development round and by branch, the tokens spent on branches
 *     that did not merge, the budget-capped invocations, and a warning for
 *     unpriced models (their calls count as $0 in the report and the caps).
 */
import { MODEL_PRICING } from '../config';
import {
    billedCost, cacheMultipliers, costBuckets, effectiveInputTokens, listCost, uncachedInputTokens, unpricedModels,
    type CostBuckets,
} from './cost';
import type { AgentUsageSummary, BranchOutcome, InvocationRecord, RunUsageSummary, TokenCallRecord } from './token-tracker';

// ─── Formatting ─────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatNumber(n: number): string {
    return n.toLocaleString('en-US');
}

export function formatCost(n: number): string {
    return `$${n.toFixed(4)}`;
}

function sumOf<T>(items: T[], value: (item: T) => number): number {
    return items.reduce((total, item) => total + value(item), 0);
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Cost by agent ──────────────────────────────────────────────────────────

export interface AgentCostRow extends AgentUsageSummary {
    /** Billed (cache-aware) USD. */
    totalCost: number;
    /** List price minus billed cost: what the prompt cache saved. */
    cacheCost: number;
    /** Billed USD by bucket, for the cost chart. */
    costs: CostBuckets;
}

/** One row per agent and model, with its billed cost and cache savings. */
export function buildAgentCostRows(summary: RunUsageSummary): AgentCostRow[] {
    return summary.byAgent.map(a => {
        const totalCost = billedCost(a);
        return { ...a, totalCost, cacheCost: listCost(a) - totalCost, costs: costBuckets(a) };
    });
}

/** Configured pricing, with the effective cache rates. */
export function renderPricingRows(): string {
    return Object.entries(MODEL_PRICING).map(([model, pricing]) => {
        const { read, write } = cacheMultipliers(pricing);
        return `<tr>
            <td>${escapeHtml(model)}</td>
            <td class="num">${formatCost(pricing.inputPer1k)}</td>
            <td class="num">${formatCost(pricing.outputPer1k)}</td>
            <td class="num">${formatCost(pricing.inputPer1k * read)}</td>
            <td class="num">${formatCost(pricing.inputPer1k * write)}</td>
        </tr>`;
    }).join('\n');
}

// ─── Run totals ─────────────────────────────────────────────────────────────

export interface ReportTotals {
    listCost: number;
    billedCost: number;
    /** List price minus billed cost. */
    savings: number;
    /** Input tokens weighted by price (see `effectiveInputTokens`). */
    effectiveInput: number;
    medianUncachedPerCall: number;
    /** Tokens of invocations on branches whose latest outcome is not `merged`. */
    unmergedBranchTokens: number;
    budgetCappedInvocations: number;
    /** Models without pricing — their calls count as $0. */
    unpriced: string[];
}

/** Latest outcome per branch. */
function latestOutcomes(outcomes: BranchOutcome[]): Map<string, string> {
    return new Map(outcomes.map((o): [string, string] => [o.branch, o.status]));
}

export function computeReportTotals(
    records: TokenCallRecord[], invocations: InvocationRecord[], outcomes: BranchOutcome[],
): ReportTotals {
    const list = sumOf(records, listCost);
    const billed = sumOf(records, billedCost);
    const branchOf = new Map(invocations.map((i): [string, string | undefined] => [i.id, i.branch]));
    const latest = latestOutcomes(outcomes);
    const onUnmerged = (r: TokenCallRecord): boolean => {
        const status = latest.get(branchOf.get(r.invocationId ?? '') ?? '');
        return status !== undefined && status !== 'merged';
    };
    return {
        listCost: list,
        billedCost: billed,
        savings: list - billed,
        effectiveInput: sumOf(records, effectiveInputTokens),
        medianUncachedPerCall: median(records.map(uncachedInputTokens)),
        unmergedBranchTokens: sumOf(records.filter(onUnmerged), r => r.totalTokens),
        budgetCappedInvocations: invocations.filter(i => i.budgetCapped).length,
        unpriced: unpricedModels(records.map(r => r.model)),
    };
}

/** Summary cards for the Plan 30-06 measures. */
export function renderTotalsCards(t: ReportTotals): string {
    const card = (value: string, label: string): string =>
        `<div class="summary-card"><div class="value">${value}</div><div class="label">${label}</div></div>`;
    return [
        card(formatNumber(Math.round(t.effectiveInput)), 'Effective Input'),
        card(formatNumber(Math.round(t.medianUncachedPerCall)), 'Median Uncached Input / Call'),
        card(formatNumber(t.unmergedBranchTokens), 'Tokens on Unmerged Branches'),
        card(String(t.budgetCappedInvocations), 'Budget-Capped Invocations'),
    ].join('\n    ');
}

/** Warning banner for models the report could not price. */
export function renderUnpricedWarning(models: string[]): string {
    if (models.length === 0) return '';
    return `<div class="status-banner failed">Unpriced model(s): ${escapeHtml(models.join(', '))} — their calls count as $0 `
        + 'in this report and in MAX_RUN_COST_USD / MAX_BRANCH_COST_USD. Price them with MODEL_PRICING_OVERRIDES.</div>';
}

// ─── By dispatch round / by branch ──────────────────────────────────────────

interface GroupRow {
    key: string;
    calls: number;
    input: number;
    uncached: number;
    cacheRead: number;
    effective: number;
    billed: number;
}

/** Records grouped by a key; records whose key is undefined are left out. Insertion order. */
function groupRecords(records: TokenCallRecord[], keyOf: (r: TokenCallRecord) => string | undefined): GroupRow[] {
    const groups = new Map<string, GroupRow>();
    for (const r of records) {
        const key = keyOf(r);
        if (key === undefined) continue;
        const g = groups.get(key) ?? { key, calls: 0, input: 0, uncached: 0, cacheRead: 0, effective: 0, billed: 0 };
        g.calls++;
        g.input += r.inputTokens;
        g.uncached += uncachedInputTokens(r);
        g.cacheRead += r.cacheReadTokens ?? 0;
        g.effective += effectiveInputTokens(r);
        g.billed += billedCost(r);
        groups.set(key, g);
    }
    return [...groups.values()];
}

const TOKEN_HEADERS = '<th>Calls</th><th>Input</th><th>Uncached</th><th>Cache Read</th><th>Effective Input</th><th>Billed Cost</th>';

function tokenCells(g: GroupRow): string {
    return `<td class="num">${g.calls}</td><td class="num">${formatNumber(g.input)}</td>`
        + `<td class="num">${formatNumber(g.uncached)}</td><td class="num">${formatNumber(g.cacheRead)}</td>`
        + `<td class="num">${formatNumber(Math.round(g.effective))}</td><td class="num">${formatCost(g.billed)}</td>`;
}

/**
 * Tables of the tokens per development round and per branch, from the
 * invocations' attribution (`withTokenAttribution`). Empty when nothing is attributed.
 */
export function renderAttributionTables(
    records: TokenCallRecord[], invocations: InvocationRecord[], outcomes: BranchOutcome[],
): string {
    const byId = new Map(invocations.map((i): [string, InvocationRecord] => [i.id, i]));
    const invocationOf = (r: TokenCallRecord): InvocationRecord | undefined => byId.get(r.invocationId ?? '');
    const rounds = groupRecords(records, r => {
        const round = invocationOf(r)?.round;
        return round === undefined ? undefined : String(round);
    });
    const branches = groupRecords(records, r => invocationOf(r)?.branch).sort((a, b) => b.input - a.input);
    if (rounds.length === 0 && branches.length === 0) return '<!-- No round/branch attribution -->';

    const latest = latestOutcomes(outcomes);
    const roundRows = rounds.map(g => {
        const ended = outcomes.filter(o => String(o.round) === g.key);
        const merged = ended.filter(o => o.status === 'merged').length;
        return `<tr><td>Round ${escapeHtml(g.key)}</td><td class="num">${merged} / ${ended.length}</td>${tokenCells(g)}</tr>`;
    }).join('\n');
    const branchRows = branches.map(g => {
        const branchRounds = [...new Set(invocations.filter(i => i.branch === g.key && i.round !== undefined).map(i => i.round))];
        return `<tr><td>${escapeHtml(g.key)}</td><td>${branchRounds.join(', ') || '—'}</td>`
            + `<td>${escapeHtml(latest.get(g.key) ?? 'in progress')}</td>${tokenCells(g)}</tr>`;
    }).join('\n');

    return `<h2>Tokens by Development Round</h2>
<table>
    <thead><tr><th>Round</th><th>Branches Merged</th>${TOKEN_HEADERS}</tr></thead>
    <tbody>${roundRows}</tbody>
</table>
<h2>Tokens by Branch</h2>
<table>
    <thead><tr><th>Branch</th><th>Rounds</th><th>Latest Status</th>${TOKEN_HEADERS}</tr></thead>
    <tbody>${branchRows}</tbody>
</table>`;
}
