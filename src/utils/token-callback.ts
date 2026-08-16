/**
 * LangChain callback handler that captures token usage from every LLM call
 * and records it into the global TokenTracker.
 *
 * Each agent gets its own handler instance with baked-in context
 * (agentId, model, phase) so usage is attributed correctly.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { tokenTracker } from './token-tracker';
import { normaliseUsage, sumUsageMetadata } from './token-usage-extractor';
import { getLogger } from './logger';

const log = getLogger('[TokenCallback]', 220);

export class TokenUsageCallbackHandler extends BaseCallbackHandler {
    name = 'TokenUsageCallbackHandler';

    /** `agentId::model` pairs already warned about, so the WARN fires once each. */
    private static _warnedNoUsage = new Set<string>();

    /** Clear the once-per-agent WARN dedupe (run start / tests). */
    static resetUsageWarnings(): void {
        TokenUsageCallbackHandler._warnedNoUsage.clear();
    }

    private agentId: string;
    private model: string;
    private phase: string;
    private _invocationId: string | undefined;

    constructor(agentId: string, model: string, phase: string) {
        super();
        this.agentId = agentId;
        this.model = model;
        this.phase = phase;
    }

    /** Update the phase context (e.g. when reusing an agent across phases). */
    setPhase(phase: string): void {
        this.phase = phase;
    }

    /** Set the current invocation ID so LLM calls are tagged for per-invocation attribution. */
    setInvocationId(id: string | undefined): void {
        this._invocationId = id;
    }

    /**
     * Called at the end of every LLM call. Extracts token usage from
     * the provider response and records it in the global tracker.
     *
     * Two-tier lookup (Plan 21, D) — no single field covers every provider:
     *
     * | Path                                     | Where usage lands                       |
     * |------------------------------------------|-----------------------------------------|
     * | OpenAI Chat Completions                  | `llmOutput.tokenUsage`                  |
     * | OpenAI Responses API (`*codex*`, `-pro`) | `llmOutput.estimatedTokenUsage`         |
     * | Anthropic, non-streaming                 | `llmOutput.usage`                       |
     * | Anthropic, streaming                     | `generations[…].message.usage_metadata` |
     * | Google Gemini                            | `generations[…].message.usage_metadata` |
     *
     * Reading only tier 1 left `MAX_RUN_COST_USD` unenforceable for a whole run.
     */
    handleLLMEnd(output: LLMResult): void {
        // Tier 1 — provider-level llmOutput.
        let totals = normaliseUsage(
            output.llmOutput?.tokenUsage
            ?? output.llmOutput?.token_usage
            ?? output.llmOutput?.usage
            ?? output.llmOutput?.estimatedTokenUsage,
        );

        // Tier 2 — per-generation usage_metadata. Only consulted when tier 1 is
        // absent, so providers that populate both are never double-counted.
        if (!totals) {
            const messages = (output.generations ?? [])
                .flat()
                .map((g: any) => g?.message)
                .filter(Boolean);
            totals = sumUsageMetadata(messages);
        }

        if (!totals) {
            // Was DEBUG. A silent zero here disables the run cost ceiling for the
            // whole run, so warn — but once per agent+model, not once per call.
            const key = `${this.agentId}::${this.model}`;
            if (!TokenUsageCallbackHandler._warnedNoUsage.has(key)) {
                TokenUsageCallbackHandler._warnedNoUsage.add(key);
                log.warn(`${this.agentId}: model "${this.model}" reported no token usage — cost tracking and MAX_RUN_COST_USD will under-count for this agent`);
            }
            return;
        }

        tokenTracker.recordCall({
            agentId: this.agentId,
            model: this.model,
            phase: this.phase,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.totalTokens,
            timestamp: new Date().toISOString(),
            ...(this._invocationId && { invocationId: this._invocationId }),
        });
    }
}
