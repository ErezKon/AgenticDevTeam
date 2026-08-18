/**
 * HTML Token Usage Report Generator.
 *
 * Produces a self-contained HTML report with inline Chart.js charts
 * and tables summarising LLM token consumption per agent, phase, and model
 * along with estimated cost breakdowns.
 *
 * Also saves the raw token-usage data as JSON alongside the HTML.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import { MODEL_PRICING } from '../config';
import type { TokenCallRecord, RunUsageSummary, RunStatus } from './token-tracker';
import { tokenTracker } from './token-tracker';
import { getCumulativeCompactionStats } from '../agents/_shared/history-compactor';
import { getTruncationStats } from '../tools/_shared/truncate';
import { estimateRunCost } from './cost';

const log = getLogger('[TokenReport]', 220);

// ─── Cost helper ────────────────────────────────────────────────────────────

function estimateCostLocal(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

interface AgentCostRow {
    agentId: string;
    model: string;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
}

interface PhaseCostRow {
    phase: string;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

function buildAgentCostRows(summary: RunUsageSummary): AgentCostRow[] {
    return summary.byAgent.map(a => {
        const pricing = MODEL_PRICING[a.model];
        const inputCost = pricing ? (a.inputTokens / 1000) * pricing.inputPer1k : 0;
        const outputCost = pricing ? (a.outputTokens / 1000) * pricing.outputPer1k : 0;
        return { ...a, inputCost, outputCost, totalCost: inputCost + outputCost };
    });
}

// ─── Chart.js CDN (minified, SRI-pinned) ────────────────────────────────────
// Using a specific pinned version of Chart.js from CDN. The HTML includes a
// fallback message if the script fails to load (e.g. offline).
const CHARTJS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

// ─── Color palette ──────────────────────────────────────────────────────────

const CHART_COLORS = [
    '#36a2eb', '#ff6384', '#ffce56', '#4bc0c0', '#9966ff',
    '#ff9f40', '#c9cbcf', '#7bc043', '#ee4035', '#0392cf',
    '#f37736', '#fdf498', '#7bc8a4', '#d11141', '#00b159',
];

function pickColor(index: number): string {
    return CHART_COLORS[index % CHART_COLORS.length];
}

// ─── HTML generation ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNumber(n: number): string {
    return n.toLocaleString('en-US');
}

function formatCost(n: number): string {
    return `$${n.toFixed(4)}`;
}

function generateHtml(
    summary: RunUsageSummary,
    records: TokenCallRecord[],
    systemName: string,
    runStatus: RunStatus = 'completed',
): string {
    const agentRows = buildAgentCostRows(summary);
    const totalListCost = agentRows.reduce((s, r) => s + r.totalCost, 0);
    // Plan 24, C3: cache-aware billed cost
    const totalBilledCost = estimateRunCost(summary);
    const totalCost = totalBilledCost;
    const cacheSavings = totalListCost - totalBilledCost;
    const runDate = new Date().toISOString();

    // Prepare chart data as JSON for inline script
    const pieLabels = JSON.stringify(agentRows.map(r => r.agentId));
    const pieData = JSON.stringify(agentRows.map(r => r.totalTokens));
    const pieColors = JSON.stringify(agentRows.map((_, i) => pickColor(i)));

    const barAgentLabels = JSON.stringify(agentRows.map(r => r.agentId));
    const barInputData = JSON.stringify(agentRows.map(r => r.inputTokens));
    const barOutputData = JSON.stringify(agentRows.map(r => r.outputTokens));

    const phaseRows: PhaseCostRow[] = summary.byPhase;
    const barPhaseLabels = JSON.stringify(phaseRows.map(r => r.phase));
    const barPhaseData = JSON.stringify(phaseRows.map(r => r.totalTokens));
    const barPhaseColors = JSON.stringify(phaseRows.map((_, i) => pickColor(i)));

    // Cost by agent bar chart
    const costLabels = JSON.stringify(agentRows.map(r => r.agentId));
    const costInputData = JSON.stringify(agentRows.map(r => r.inputCost));
    const costOutputData = JSON.stringify(agentRows.map(r => r.outputCost));

    // Build detail table rows
    const detailRows = records.map(r => {
        const cost = estimateCostLocal(r.model, r.inputTokens, r.outputTokens);
        return `<tr>
            <td>${escapeHtml(r.agentId)}</td>
            <td>${escapeHtml(r.phase)}</td>
            <td>${escapeHtml(r.model)}</td>
            <td class="num">${formatNumber(r.inputTokens)}</td>
            <td class="num">${formatNumber(r.outputTokens)}</td>
            <td class="num">${formatNumber(r.totalTokens)}</td>
            <td class="num">${formatCost(cost)}</td>
            <td>${r.timestamp}</td>
        </tr>`;
    }).join('\n');

    // Agent summary table rows
    const agentTableRows = agentRows.map(r =>
        `<tr>
            <td>${escapeHtml(r.agentId)}</td>
            <td>${escapeHtml(r.model)}</td>
            <td class="num">${r.callCount}</td>
            <td class="num">${formatNumber(r.inputTokens)}</td>
            <td class="num">${formatNumber(r.outputTokens)}</td>
            <td class="num">${formatNumber(r.totalTokens)}</td>
            <td class="num">${formatCost(r.inputCost)}</td>
            <td class="num">${formatCost(r.outputCost)}</td>
            <td class="num">${formatCost(r.totalCost)}</td>
        </tr>`,
    ).join('\n');

    // Phase table rows
    const phaseTableRows = phaseRows.map(r =>
        `<tr>
            <td>${escapeHtml(r.phase)}</td>
            <td class="num">${r.callCount}</td>
            <td class="num">${formatNumber(r.inputTokens)}</td>
            <td class="num">${formatNumber(r.outputTokens)}</td>
            <td class="num">${formatNumber(r.totalTokens)}</td>
        </tr>`,
    ).join('\n');

    // Model table rows
    const modelTableRows = summary.byModel.map(r => {
        const cost = estimateCostLocal(r.model, r.inputTokens, r.outputTokens);
        return `<tr>
            <td>${escapeHtml(r.model)}</td>
            <td class="num">${r.callCount}</td>
            <td class="num">${formatNumber(r.inputTokens)}</td>
            <td class="num">${formatNumber(r.outputTokens)}</td>
            <td class="num">${formatNumber(r.totalTokens)}</td>
            <td class="num">${formatCost(cost)}</td>
        </tr>`;
    }).join('\n');

    // Pricing rates table
    const pricingRows = Object.entries(MODEL_PRICING).map(([model, pricing]) =>
        `<tr>
            <td>${escapeHtml(model)}</td>
            <td class="num">${formatCost(pricing.inputPer1k)}</td>
            <td class="num">${formatCost(pricing.outputPer1k)}</td>
        </tr>`,
    ).join('\n');

    // Invocation efficiency table
    const invocationRows = tokenTracker.getInvocationSummaries();
    const invocationTableRows = invocationRows.map(r =>
        `<tr>
            <td>${escapeHtml(r.agentId)}</td>
            <td class="num">${r.invocations}</td>
            <td class="num">${r.avgCallsPerInvocation}</td>
            <td class="num">${formatNumber(r.avgInputPerCall)}</td>
            <td class="num">${formatNumber(r.firstCallInput)}</td>
            <td class="num">${formatNumber(r.lastCallInput)}</td>
            <td class="num">${r.growthFactor}x</td>
            <td class="num">${r.respawns}</td>
        </tr>`,
    ).join('\n');

    // Compaction & truncation stats
    const compaction = getCumulativeCompactionStats();
    const truncation = getTruncationStats();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Token Usage Report - ${escapeHtml(systemName)}</title>
<style>
    :root {
        --bg-primary: #1a1b26;
        --bg-secondary: #24283b;
        --bg-card: #2f3346;
        --text-primary: #c0caf5;
        --text-secondary: #a9b1d6;
        --text-muted: #565f89;
        --accent-blue: #7aa2f7;
        --accent-green: #9ece6a;
        --accent-red: #f7768e;
        --accent-yellow: #e0af68;
        --accent-purple: #bb9af7;
        --border: #3b4261;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        line-height: 1.6;
        padding: 2rem;
    }
    h1 {
        font-size: 1.8rem;
        color: var(--accent-blue);
        margin-bottom: 0.25rem;
    }
    .subtitle {
        color: var(--text-muted);
        font-size: 0.9rem;
        margin-bottom: 2rem;
    }
    .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 1rem;
        margin-bottom: 2rem;
    }
    .summary-card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1.2rem;
        text-align: center;
    }
    .summary-card .value {
        font-size: 1.6rem;
        font-weight: 700;
        color: var(--accent-green);
    }
    .summary-card .label {
        font-size: 0.8rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: 0.25rem;
    }
    .summary-card.cost .value { color: var(--accent-yellow); }

    h2 {
        font-size: 1.2rem;
        color: var(--text-secondary);
        margin: 2rem 0 1rem;
        padding-bottom: 0.4rem;
        border-bottom: 1px solid var(--border);
    }
    .chart-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
        gap: 1.5rem;
        margin-bottom: 2rem;
    }
    .chart-container {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1.2rem;
        position: relative;
    }
    .chart-container h3 {
        font-size: 0.95rem;
        color: var(--text-muted);
        margin-bottom: 0.8rem;
    }
    .chart-container canvas { max-height: 320px; }

    table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 1.5rem;
        font-size: 0.85rem;
    }
    th, td {
        padding: 0.55rem 0.75rem;
        border-bottom: 1px solid var(--border);
        text-align: left;
    }
    th {
        background: var(--bg-secondary);
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.04em;
        position: sticky;
        top: 0;
    }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:hover td { background: rgba(122, 162, 247, 0.05); }
    tfoot td {
        font-weight: 700;
        border-top: 2px solid var(--border);
        background: var(--bg-secondary);
    }

    .detail-wrapper {
        max-height: 500px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: 8px;
    }
    .detail-wrapper table { margin-bottom: 0; }

    .footer {
        margin-top: 3rem;
        padding-top: 1rem;
        border-top: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.75rem;
        text-align: center;
    }
    .no-charts {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 2rem;
        text-align: center;
        color: var(--text-muted);
    }
    .status-banner {
        padding: 0.75rem 1.2rem;
        border-radius: 8px;
        margin-bottom: 1.5rem;
        font-weight: 600;
        font-size: 0.9rem;
    }
    .status-banner.in-progress {
        background: rgba(224, 175, 104, 0.15);
        border: 1px solid var(--accent-yellow);
        color: var(--accent-yellow);
    }
    .status-banner.failed {
        background: rgba(247, 118, 142, 0.15);
        border: 1px solid var(--accent-red);
        color: var(--accent-red);
    }
    .status-banner.completed {
        background: rgba(158, 206, 106, 0.15);
        border: 1px solid var(--accent-green);
        color: var(--accent-green);
    }
</style>
</head>
<body>
<h1>Token Usage Report</h1>
<p class="subtitle">${escapeHtml(systemName)} &mdash; ${runDate}</p>

${runStatus === 'in-progress'
    ? '<div class="status-banner in-progress">&#9203; Run in progress &mdash; this report updates automatically as agents complete their work.</div>'
    : runStatus === 'failed'
    ? '<div class="status-banner failed">&#10060; Run failed &mdash; this report contains partial data collected before the failure.</div>'
    : '<div class="status-banner completed">&#9989; Run completed successfully.</div>'}

<!-- Summary cards -->
<div class="summary-grid">
    <div class="summary-card">
        <div class="value">${formatNumber(summary.totalTokens)}</div>
        <div class="label">Total Tokens</div>
    </div>
    <div class="summary-card">
        <div class="value">${formatNumber(summary.totalInputTokens)}</div>
        <div class="label">Input Tokens</div>
    </div>
    <div class="summary-card">
        <div class="value">${formatNumber(summary.totalOutputTokens)}</div>
        <div class="label">Output Tokens</div>
    </div>
    <div class="summary-card">
        <div class="value">${summary.totalCalls}</div>
        <div class="label">LLM Calls</div>
    </div>
    <!-- Plan 22 D2: prompt-cache effectiveness. A run sitting at 0% is re-billing
         its system prompt, tool schemas and task context on every single call. -->
    <div class="summary-card">
        <div class="value">${(summary.cacheHitRate * 100).toFixed(1)}%</div>
        <div class="label">Prompt Cache Hit Rate</div>
    </div>
    <div class="summary-card">
        <div class="value">${formatNumber(summary.totalCacheReadTokens)}</div>
        <div class="label">Cached Input Tokens</div>
    </div>
    <div class="summary-card">
        <div class="value">${summary.totalOutputTokens > 0 ? (summary.totalInputTokens / summary.totalOutputTokens).toFixed(1) : '—'}:1</div>
        <div class="label">Input : Output Ratio</div>
    </div>
    <div class="summary-card">
        <div class="value">${agentRows.length}</div>
        <div class="label">Agents</div>
    </div>
    <div class="summary-card cost">
        <div class="value">${formatCost(totalCost)}</div>
        <div class="label">Estimated Cost</div>
    </div>
</div>

<!-- Charts -->
<div class="chart-grid">
    <div class="chart-container">
        <h3>Token Distribution by Agent</h3>
        <canvas id="pieChart"></canvas>
    </div>
    <div class="chart-container">
        <h3>Input vs Output Tokens by Agent</h3>
        <canvas id="barChart"></canvas>
    </div>
    <div class="chart-container">
        <h3>Tokens by Pipeline Phase</h3>
        <canvas id="phaseChart"></canvas>
    </div>
    <div class="chart-container">
        <h3>Estimated Cost by Agent (Input vs Output)</h3>
        <canvas id="costChart"></canvas>
    </div>
</div>
<noscript>
    <div class="no-charts">Charts require JavaScript. The tables below contain the same data.</div>
</noscript>

<!-- Cost Table -->
<h2>Cost Breakdown by Agent</h2>
<table>
    <thead>
        <tr>
            <th>Agent</th><th>Model</th><th>Calls</th>
            <th>Input Tokens</th><th>Output Tokens</th><th>Total Tokens</th>
            <th>Input Cost</th><th>Output Cost</th><th>Total Cost</th>
        </tr>
    </thead>
    <tbody>
        ${agentTableRows}
    </tbody>
    <tfoot>
        <tr>
            <td colspan="3">Total</td>
            <td class="num">${formatNumber(summary.totalInputTokens)}</td>
            <td class="num">${formatNumber(summary.totalOutputTokens)}</td>
            <td class="num">${formatNumber(summary.totalTokens)}</td>
            <td class="num">${formatCost(agentRows.reduce((s, r) => s + r.inputCost, 0))}</td>
            <td class="num">${formatCost(agentRows.reduce((s, r) => s + r.outputCost, 0))}</td>
            <td class="num">${formatCost(totalCost)}</td>
        </tr>
    </tfoot>
</table>

<!-- By Phase -->
<h2>Usage by Phase</h2>
<table>
    <thead>
        <tr><th>Phase</th><th>Calls</th><th>Input</th><th>Output</th><th>Total</th></tr>
    </thead>
    <tbody>${phaseTableRows}</tbody>
</table>

<!-- By Model -->
<h2>Usage by Model</h2>
<table>
    <thead>
        <tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Total</th><th>Est. Cost</th></tr>
    </thead>
    <tbody>${modelTableRows}</tbody>
</table>

<!-- Invocation Efficiency -->
${invocationRows.length > 0 ? `<h2>Invocation Efficiency</h2>
<table>
    <thead>
        <tr>
            <th>Agent</th><th>Invocations</th><th>Avg Calls/Inv</th>
            <th>Avg Input/Call</th><th>1st Call Input</th><th>Last Call Input</th>
            <th>Growth</th><th>Respawns</th>
        </tr>
    </thead>
    <tbody>${invocationTableRows}</tbody>
</table>` : '<!-- No invocation data -->'}

<!-- Billed vs List Cost (Plan 24, C3) -->
${cacheSavings > 0.001 ? `<h2>Billed vs List Cost</h2>
<table>
    <thead>
        <tr><th>Metric</th><th>Value</th></tr>
    </thead>
    <tbody>
        <tr><td>List price (no cache discounts)</td><td class="num">${formatCost(totalListCost)}</td></tr>
        <tr><td>Billed cost (cache-aware)</td><td class="num">${formatCost(totalBilledCost)}</td></tr>
        <tr><td>Savings from prompt caching</td><td class="num">${formatCost(cacheSavings)} (${totalListCost > 0 ? ((cacheSavings / totalListCost) * 100).toFixed(1) : '0'}%)</td></tr>
        <tr><td>Cache read tokens</td><td class="num">${formatNumber(summary.totalCacheReadTokens)}</td></tr>
        <tr><td>Cache creation tokens</td><td class="num">${formatNumber(summary.totalCacheCreationTokens)}</td></tr>
    </tbody>
</table>` : '<!-- No cache savings to report -->'}

<!-- History Compaction & Truncation -->
${(compaction.invocations > 0 || truncation.truncated > 0) ? `<h2>History Compaction &amp; Truncation</h2>
<table>
    <thead>
        <tr><th>Metric</th><th>Value</th></tr>
    </thead>
    <tbody>
        ${compaction.invocations > 0 ? `<tr><td>Compaction invocations</td><td class="num">${formatNumber(compaction.invocations)}</td></tr>
        <tr><td>Original chars</td><td class="num">${formatNumber(compaction.totalOriginalChars)}</td></tr>
        <tr><td>Compacted chars</td><td class="num">${formatNumber(compaction.totalCompactedChars)}</td></tr>
        <tr><td>Chars saved by compaction</td><td class="num">${formatNumber(compaction.savedChars)} (${compaction.savedPct}%)</td></tr>
        <tr><td>Tool results stubbed</td><td class="num">${formatNumber(compaction.totalToolResultsStubbed)}</td></tr>
        <tr><td>Write args stubbed</td><td class="num">${formatNumber(compaction.totalWriteArgsStubbed)}</td></tr>` : ''}
        ${truncation.truncated > 0 ? `<tr><td>Tool results truncated</td><td class="num">${formatNumber(truncation.truncated)}</td></tr>
        <tr><td>Chars removed by truncation</td><td class="num">${formatNumber(truncation.charsRemoved)}</td></tr>` : ''}
    </tbody>
</table>` : '<!-- No compaction/truncation data -->'}

<!-- Pricing Rates -->
<h2>Configured Pricing Rates</h2>
<table>
    <thead>
        <tr><th>Model</th><th>Input ($/1K tokens)</th><th>Output ($/1K tokens)</th></tr>
    </thead>
    <tbody>${pricingRows}</tbody>
</table>

<!-- Detailed invocations -->
<h2>All Invocations (${records.length} records)</h2>
<div class="detail-wrapper">
<table>
    <thead>
        <tr>
            <th>Agent</th><th>Phase</th><th>Model</th>
            <th>Input</th><th>Output</th><th>Total</th>
            <th>Cost</th><th>Timestamp</th>
        </tr>
    </thead>
    <tbody>${detailRows}</tbody>
</table>
</div>

<div class="footer">
    Generated by AgenticDevTeam Token Monitor &mdash; ${runDate}
</div>

<!-- Chart.js from CDN -->
<script src="${CHARTJS_CDN}"></script>
<script>
(function() {
    if (typeof Chart === 'undefined') return; // CDN failed to load

    Chart.defaults.color = '#a9b1d6';
    Chart.defaults.borderColor = '#3b4261';

    // Pie: token distribution by agent
    new Chart(document.getElementById('pieChart'), {
        type: 'doughnut',
        data: {
            labels: ${pieLabels},
            datasets: [{
                data: ${pieData},
                backgroundColor: ${pieColors},
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 14, padding: 10 } },
            },
        },
    });

    // Bar: input vs output by agent
    new Chart(document.getElementById('barChart'), {
        type: 'bar',
        data: {
            labels: ${barAgentLabels},
            datasets: [
                { label: 'Input', data: ${barInputData}, backgroundColor: '#36a2eb' },
                { label: 'Output', data: ${barOutputData}, backgroundColor: '#ff6384' },
            ],
        },
        options: {
            responsive: true,
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
            plugins: { legend: { position: 'top' } },
        },
    });

    // Bar: tokens by phase
    new Chart(document.getElementById('phaseChart'), {
        type: 'bar',
        data: {
            labels: ${barPhaseLabels},
            datasets: [{
                label: 'Total Tokens',
                data: ${barPhaseData},
                backgroundColor: ${barPhaseColors},
            }],
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            scales: { x: { beginAtZero: true } },
            plugins: { legend: { display: false } },
        },
    });

    // Bar: cost by agent (input vs output cost)
    new Chart(document.getElementById('costChart'), {
        type: 'bar',
        data: {
            labels: ${costLabels},
            datasets: [
                { label: 'Input Cost', data: ${costInputData}, backgroundColor: '#9ece6a' },
                { label: 'Output Cost', data: ${costOutputData}, backgroundColor: '#e0af68' },
            ],
        },
        options: {
            responsive: true,
            scales: {
                x: { stacked: true },
                y: { stacked: true, beginAtZero: true, ticks: { callback: function(v) { return '$' + v.toFixed(4); } } },
            },
            plugins: { legend: { position: 'top' } },
        },
    });
})();
</script>
</body>
</html>`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a self-contained HTML token usage report and save both
 * the raw JSON data and the HTML report to the specified output path.
 *
 * @param records  Raw token call records from the run
 * @param outputPath  Directory to write the report files into
 * @param systemName  Human-readable system/project name for the report header
 * @param runStatus  Current run status (shown as a banner in the HTML)
 */
export function generateTokenReport(
    records: TokenCallRecord[],
    outputPath: string,
    systemName: string,
    runStatus: RunStatus = 'completed',
): { jsonPath: string; htmlPath: string } {
    const summary = tokenTracker.getRunSummary();

    // Ensure output directory exists
    fs.mkdirSync(outputPath, { recursive: true });

    // Save raw JSON
    const jsonPath = path.join(outputPath, 'token-usage.json');
    fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2), 'utf-8');
    log.info(`Saved raw token data: ${jsonPath} (${records.length} records)`);

    // Generate and save HTML report
    const html = generateHtml(summary, records, systemName, runStatus);
    const htmlPath = path.join(outputPath, 'token-usage-report.html');
    fs.writeFileSync(htmlPath, html, 'utf-8');
    log.info(`Saved HTML report: ${htmlPath} (${html.length} chars)`);

    return { jsonPath, htmlPath };
}

/**
 * Regenerate the token usage report from the current TokenTracker state.
 *
 * No-op if persistence has not been enabled via `tokenTracker.enablePersistence()`.
 * Safe to call at any time (errors are caught and logged).
 */
export function refreshTokenReport(): { jsonPath: string; htmlPath: string } | null {
    const outputPath = tokenTracker.getOutputPath();
    const systemName = tokenTracker.getSystemName();
    if (!outputPath) return null;

    try {
        return generateTokenReport(
            tokenTracker.getSnapshot(),
            outputPath,
            systemName,
            tokenTracker.getRunStatus(),
        );
    } catch (e) {
        log.warn(`Failed to refresh token report: ${(e as Error).message}`);
        return null;
    }
}
