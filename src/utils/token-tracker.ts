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
    timestamp: string;
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
    byAgent: AgentUsageSummary[];
    byPhase: { phase: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }[];
    byModel: { model: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }[];
}

// ─── Run status ─────────────────────────────────────────────────────────────

export type RunStatus = 'in-progress' | 'completed' | 'failed' | 'cancelled';

// ─── Singleton ──────────────────────────────────────────────────────────────

class TokenTracker {
    private ledger: TokenCallRecord[] = [];

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

    /** Get aggregated usage for a single agent. */
    getAgentSummary(agentId: string): AgentUsageSummary {
        const calls = this.ledger.filter(r => r.agentId === agentId);
        return {
            agentId,
            model: calls[0]?.model ?? 'unknown',
            callCount: calls.length,
            inputTokens: calls.reduce((s, r) => s + r.inputTokens, 0),
            outputTokens: calls.reduce((s, r) => s + r.outputTokens, 0),
            totalTokens: calls.reduce((s, r) => s + r.totalTokens, 0),
        };
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

        return {
            totalInputTokens: this.ledger.reduce((s, r) => s + r.inputTokens, 0),
            totalOutputTokens: this.ledger.reduce((s, r) => s + r.outputTokens, 0),
            totalTokens: this.ledger.reduce((s, r) => s + r.totalTokens, 0),
            totalCalls: this.ledger.length,
            byAgent: [...byAgentMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
            byPhase: [...byPhaseMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
            byModel: [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
        };
    }

    /** Return the raw ledger as a serializable snapshot for state storage. */
    getSnapshot(): TokenCallRecord[] {
        return [...this.ledger];
    }

    /** Clear all tracked data and persistence config (call at run start). */
    reset(): void {
        if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
        this.ledger = [];
        this._outputPath = null;
        this._systemName = '';
        this._runStatus = 'in-progress';
        this._refreshCallback = null;
        log.info('Token tracker reset');
    }
}

/** Module-level singleton — shared across all agents in a run. */
export const tokenTracker = new TokenTracker();
