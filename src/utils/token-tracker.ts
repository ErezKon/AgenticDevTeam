/**
 * Token usage tracking — singleton tracker that accumulates LLM token
 * consumption per agent, model, and pipeline phase across an entire run.
 */
import { getLogger } from './logger';

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

// ─── Singleton ──────────────────────────────────────────────────────────────

class TokenTracker {
    private ledger: TokenCallRecord[] = [];

    /** Record a single LLM call's token usage. */
    recordCall(record: TokenCallRecord): void {
        this.ledger.push(record);
        log.debug(
            `${record.agentId} [${record.model}] ${record.phase}: `
            + `in=${record.inputTokens} out=${record.outputTokens} total=${record.totalTokens}`,
        );
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

    /** Clear all tracked data (call at run start). */
    reset(): void {
        this.ledger = [];
        log.info('Token tracker reset');
    }
}

/** Module-level singleton — shared across all agents in a run. */
export const tokenTracker = new TokenTracker();
