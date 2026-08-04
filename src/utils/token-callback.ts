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
import { getLogger } from './logger';

const log = getLogger('[TokenCallback]', 220);

export class TokenUsageCallbackHandler extends BaseCallbackHandler {
    name = 'TokenUsageCallbackHandler';

    private agentId: string;
    private model: string;
    private phase: string;

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

    /**
     * Called at the end of every LLM call. Extracts token usage from
     * the provider response and records it in the global tracker.
     */
    handleLLMEnd(output: LLMResult): void {
        const usage = output.llmOutput?.tokenUsage
            ?? output.llmOutput?.token_usage
            ?? output.llmOutput?.usage
            ?? null;

        if (!usage) {
            log.debug(`${this.agentId}: No token usage in llmOutput (provider may not report it)`);
            return;
        }

        // OpenAI-compatible format (promptTokens/completionTokens or prompt_tokens/completion_tokens)
        const inputTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
        const outputTokens = usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0;
        const totalTokens = usage.totalTokens ?? usage.total_tokens ?? (inputTokens + outputTokens);

        if (totalTokens === 0) {
            return;
        }

        tokenTracker.recordCall({
            agentId: this.agentId,
            model: this.model,
            phase: this.phase,
            inputTokens,
            outputTokens,
            totalTokens,
            timestamp: new Date().toISOString(),
        });
    }
}
