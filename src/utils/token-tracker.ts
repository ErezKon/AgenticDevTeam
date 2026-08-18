/**
 * Token usage tracking — singleton tracker that accumulates LLM token
 * consumption per agent, model, and pipeline phase across an entire run.
 *
 * Supports crash-safe persistence: when enabled, the raw JSON ledger is
 * saved to disk after every LLM call, and an optional refresh callback
 * regenerates the HTML report on a debounced schedule.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import { emitRunEvent } from './event-bus';

const log = getLogger('[TokenTracker]', 220);

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single LLM call's token usage record. */
export interface TokenCallRecord {
    agentId: string;
    model: string;
    phase: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Input tokens served from the provider prompt cache (Plan 22, D2). */
    cacheReadTokens?: number;
    /** Input tokens written to the provider prompt cache (Plan 22, D2). */
    cacheCreationTokens?: number;
    timestamp: string;
    /** Optional invocation ID for per-invocation attribution. */
    invocationId?: string;
}

/** Aggregated usage summary for one agent. */
export interface AgentUsageSummary {
    agentId: string;
    model: string;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

/** Full run usage summary with per-agent breakdown. */
export interface RunUsageSummary {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCalls: number;
    /** Input tokens served from the provider prompt cache (Plan 22, D2). */
    totalCacheReadTokens: number;
    /** Input tokens written to the provider prompt cache (Plan 22, D2). */
    totalCacheCreationTokens: number;
    /** Share of input tokens served from cache, 0–1. The pacmanclaude run scored 0. */
    cacheHitRate: number;
    byAgent: AgentUsageSummary[];
    byPhase: { phase: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }[];
    byModel: { model: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }[];
}

// ─── Run status ─────────────────────────────────────────────────────────────

export type RunStatus = 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'inconclusive' | 'budget-exhausted';

/** Tracks a single agent invocation (multiple LLM calls) for the efficiency table. */
export interface InvocationRecord {
    id: string;
    agentId: string;
    phase: string;
    startedAt: number;
    endedAt?: number;
    respawns?: number;
}

/** Per-invocation efficiency summary for the report. */
interface InvocationEfficiencyRow {
    agentId: string;
    invocations: number;
    avgCallsPerInvocation: number;
    avgInputPerCall: number;
    firstCallInput: number;
    lastCallInput: number;
    growthFactor: number;
    respawns: number;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

class TokenTracker {
    private ledger: TokenCallRecord[] = [];
    private _invocations: Map<string, InvocationRecord> = new Map();
    private _nextInvocationId = 0;

    // ── Persistence fields ──────────────────────────────────────────────
    private _outputPath: string | null = null;
    private _systemName: string = '';
    private _runStatus: RunStatus = 'in-progress';
    private _refreshCallback: (() => void) | null = null;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly REFRESH_DEBOUNCE_MS = 3_000;

    // ── Persistence API ─────────────────────────────────────────────────

    /**
     * Enable crash-safe persistence. Creates the output directory and
     * writes an initial empty JSON snapshot so the report skeleton exists
     * on disk immediately.
     */
    enablePersistence(outputPath: string, systemName: string): void {
        this._outputPath = outputPath;
        this._systemName = systemName;
        this._runStatus = 'in-progress';
        fs.mkdirSync(outputPath, { recursive: true });
        this.saveJsonSnapshot();
        log.info(`Persistence enabled → ${outputPath}`);
    }

    /** Set a callback that regenerates the HTML report (debounced after each recordCall). */
    setRefreshCallback(cb: () => void): void {
        this._refreshCallback = cb;
    }

    setRunStatus(status: RunStatus): void { this._runStatus = status; }
    getOutputPath(): string | null { return this._outputPath; }
    getSystemName(): string { return this._systemName; }
    getRunStatus(): RunStatus { return this._runStatus; }

    /** Flush the JSON snapshot to disk immediately (no-op if persistence is disabled). */
    private saveJsonSnapshot(): void {
        if (!this._outputPath) return;
        try {
            const jsonPath = path.join(this._outputPath, 'token-usage.json');
            fs.writeFileSync(jsonPath, JSON.stringify(this.ledger, null, 2), 'utf-8');
        } catch (e) {
            log.warn(`Failed to save JSON snapshot: ${(e as Error).message}`);
        }
    }

    /** Schedule a debounced HTML report refresh. */
    private scheduleRefresh(): void {
        if (!this._refreshCallback) return;
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            try {
                this._refreshCallback?.();
            } catch (e) {
                log.warn(`Refresh callback failed: ${(e as Error).message}`);
            }
            // Emit tokens:update for the live dashboard
            try {
                const summary = this.getRunSummary();
                emitRunEvent('tokens:update', {
                    totalCalls: summary.totalCalls,
                    totalTokens: summary.totalTokens,
                    totalInputTokens: summary.totalInputTokens,
                    totalOutputTokens: summary.totalOutputTokens,
                });
            } catch { /* best-effort */ }
        }, TokenTracker.REFRESH_DEBOUNCE_MS);
    }

    // ── Core tracking API ───────────────────────────────────────────────

    /** Record a single LLM call's token usage. */
    recordCall(record: TokenCallRecord): void {
        this.ledger.push(record);
        log.debug(
            `${record.agentId} [${record.model}] ${record.phase}: `
            + `in=${record.inputTokens} out=${record.outputTokens} total=${record.totalTokens}`,
        );
        // Persist to disk after every call for crash safety
        this.saveJsonSnapshot();
        this.scheduleRefresh();
    }

    /** Get the full run usage summary with breakdowns. */
    getRunSummary(): RunUsageSummary {
        const byAgentMap = new Map<string, AgentUsageSummary>();
        const byPhaseMap = new Map<string, { phase: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }>();
        const byModelMap = new Map<string, { model: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }>();

        for (const r of this.ledger) {
            // By agent
            const agent = byAgentMap.get(r.agentId) ?? { agentId: r.agentId, model: r.model, callCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            agent.callCount++;
            agent.inputTokens += r.inputTokens;
            agent.outputTokens += r.outputTokens;
            agent.totalTokens += r.totalTokens;
            byAgentMap.set(r.agentId, agent);

            // By phase
            const phase = byPhaseMap.get(r.phase) ?? { phase: r.phase, inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0 };
            phase.callCount++;
            phase.inputTokens += r.inputTokens;
            phase.outputTokens += r.outputTokens;
            phase.totalTokens += r.totalTokens;
            byPhaseMap.set(r.phase, phase);

            // By model
            const model = byModelMap.get(r.model) ?? { model: r.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, callCount: 0 };
            model.callCount++;
            model.inputTokens += r.inputTokens;
            model.outputTokens += r.outputTokens;
            model.totalTokens += r.totalTokens;
            byModelMap.set(r.model, model);
        }

        const totalInputTokens = this.ledger.reduce((s, r) => s + r.inputTokens, 0);
        const totalCacheReadTokens = this.ledger.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);

        return {
            totalInputTokens,
            totalOutputTokens: this.ledger.reduce((s, r) => s + r.outputTokens, 0),
            totalTokens: this.ledger.reduce((s, r) => s + r.totalTokens, 0),
            totalCalls: this.ledger.length,
            totalCacheReadTokens,
            totalCacheCreationTokens: this.ledger.reduce((s, r) => s + (r.cacheCreationTokens ?? 0), 0),
            cacheHitRate: totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : 0,
            byAgent: [...byAgentMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
            byPhase: [...byPhaseMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
            byModel: [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
        };
    }

    // ── Invocation tracking API ───────────────────────────────────────────

    /**
     * Start tracking a new agent invocation. Returns a unique invocation ID
     * that should be threaded through TokenUsageCallbackHandler so all LLM
     * calls within this invocation are tagged.
     */
    startInvocation(agentId: string, phase: string): string {
        const id = `inv-${agentId}-${this._nextInvocationId++}`;
        this._invocations.set(id, { id, agentId, phase, startedAt: Date.now() });
        return id;
    }

    /** Mark an invocation as ended. */
    endInvocation(id: string, respawns?: number): void {
        const inv = this._invocations.get(id);
        if (inv) {
            inv.endedAt = Date.now();
            if (respawns !== undefined) inv.respawns = respawns;
        }
    }

    /**
     * Build the Invocation Efficiency summary table.
     * Groups by agentId, computes per-invocation call counts and growth factor.
     */
    getInvocationSummaries(): InvocationEfficiencyRow[] {
        // Group invocations by agentId
        const byAgent = new Map<string, InvocationRecord[]>();
        for (const inv of this._invocations.values()) {
            const list = byAgent.get(inv.agentId) ?? [];
            list.push(inv);
            byAgent.set(inv.agentId, list);
        }

        const rows: InvocationEfficiencyRow[] = [];
        for (const [agentId, invocations] of byAgent.entries()) {
            let totalCalls = 0;
            let totalInput = 0;
            let totalRespawns = 0;
            let globalFirstInput = 0;
            let globalLastInput = 0;

            for (const inv of invocations) {
                totalRespawns += inv.respawns ?? 0;
                // Find all records tagged with this invocation ID
                const records = this.ledger.filter(r => r.invocationId === inv.id);
                totalCalls += records.length;
                totalInput += records.reduce((s, r) => s + r.inputTokens, 0);

                if (records.length > 0) {
                    if (globalFirstInput === 0) globalFirstInput = records[0].inputTokens;
                    globalLastInput = records[records.length - 1].inputTokens;
                }
            }

            // Fallback: if no records were tagged with invocation IDs, use all records for this agent
            if (totalCalls === 0) {
                const agentRecords = this.ledger.filter(r => r.agentId === agentId);
                totalCalls = agentRecords.length;
                totalInput = agentRecords.reduce((s, r) => s + r.inputTokens, 0);
                if (agentRecords.length > 0) {
                    globalFirstInput = agentRecords[0].inputTokens;
                    globalLastInput = agentRecords[agentRecords.length - 1].inputTokens;
                }
            }

            const avgCalls = invocations.length > 0 ? totalCalls / invocations.length : 0;
            const avgInput = totalCalls > 0 ? totalInput / totalCalls : 0;
            const growth = globalFirstInput > 0 ? globalLastInput / globalFirstInput : 1;

            rows.push({
                agentId,
                invocations: invocations.length,
                avgCallsPerInvocation: Math.round(avgCalls * 10) / 10,
                avgInputPerCall: Math.round(avgInput),
                firstCallInput: globalFirstInput,
                lastCallInput: globalLastInput,
                growthFactor: Math.round(growth * 100) / 100,
                respawns: totalRespawns,
            });
        }

        return rows.sort((a, b) => b.invocations - a.invocations);
    }

    /** Sum of input tokens for all calls tagged with a given invocation ID (Plan 24, D1). */
    getInvocationInputTokens(invocationId: string): number {
        let total = 0;
        for (const r of this.ledger) {
            if (r.invocationId === invocationId) total += r.inputTokens;
        }
        return total;
    }

    /** Return the raw ledger as a serializable snapshot for state storage. */
    getSnapshot(): TokenCallRecord[] {
        return [...this.ledger];
    }

    /**
     * Import a token usage record from a previous run (continuation support).
     *
     * The record is added to the ledger without triggering persistence or
     * refresh callbacks — we're restoring history, not recording new usage.
     * The budget system will see these records when calculating cumulative spend.
     */
    recordFromPreviousRun(record: Record<string, any>): void {
        // Best-effort: only add if it looks like a valid record
        if (typeof record === 'object' && record !== null && record.agentId) {
            this.ledger.push({
                agentId: record.agentId ?? 'unknown',
                model: record.model ?? 'unknown',
                phase: record.phase ?? 'unknown',
                inputTokens: record.inputTokens ?? 0,
                outputTokens: record.outputTokens ?? 0,
                totalTokens: record.totalTokens ?? 0,
                cacheReadTokens: record.cacheReadTokens,
                cacheCreationTokens: record.cacheCreationTokens,
                timestamp: record.timestamp ?? '',
                invocationId: record.invocationId,
            });
        }
    }

    /** Clear all tracked data and persistence config (call at run start). */
    reset(): void {
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
        this.ledger = [];
        this._invocations.clear();
        this._nextInvocationId = 0;
        this._outputPath = null;
        this._systemName = '';
        this._runStatus = 'in-progress';
        this._refreshCallback = null;
        log.info('Token tracker reset');
    }
}

/** Module-level singleton — shared across all agents in a run. */
export const tokenTracker = new TokenTracker();
