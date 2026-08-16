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
import { SANITY_ASSERT_CACHE, SANITY_ASSERT_CACHE_AFTER, ANTHROPIC_PROMPT_CACHE_ENABLED } from '../config';

const log = getLogger('[TokenCallback]', 220);

export class TokenUsageCallbackHandler extends BaseCallbackHandler {
    name = 'TokenUsageCallbackHandler';

    /** `agentId::model` pairs already warned about, so the WARN fires once each. */
    private static _warnedNoUsage = new Set<string>();

    // ── Prompt-cache sanity assertion (Plan 22, D2) ──────────────────────
    // A cache that silently never engages is the single most expensive failure
    // mode available: the pacmanclaude run billed 2.32M input tokens with
    // `cache_read: 0` on every one of its 227 Anthropic calls, and nothing said so.
    private static _cacheEligibleCalls = 0;
    private static _cacheReadTotal = 0;
    private static _cacheAssertionFired = false;

    /** Clear the once-per-agent WARN dedupe (run start / tests). */
    static resetUsageWarnings(): void {
        TokenUsageCallbackHandler._warnedNoUsage.clear();
        TokenUsageCallbackHandler._cacheEligibleCalls = 0;
        TokenUsageCallbackHandler._cacheReadTotal = 0;
        TokenUsageCallbackHandler._cacheAssertionFired = false;
    }

    /**
     * Track cache effectiveness for models that should be caching, and shout once
     * if the cache is not engaging after `SANITY_ASSERT_CACHE_AFTER` calls.
     */
    private trackCacheEffectiveness(cacheRead: number): void {
        if (!SANITY_ASSERT_CACHE || !ANTHROPIC_PROMPT_CACHE_ENABLED) return;
        if (!/claude|anthropic/i.test(this.model)) return;

        const cls = TokenUsageCallbackHandler;
        cls._cacheEligibleCalls++;
        cls._cacheReadTotal += cacheRead;

        if (cls._cacheAssertionFired) return;
        if (cls._cacheEligibleCalls < SANITY_ASSERT_CACHE_AFTER) return;

        cls._cacheAssertionFired = true;
        if (cls._cacheReadTotal === 0) {
            log.error(
                `Anthropic prompt cache is NOT engaging: 0 cache-read tokens after `
                + `${cls._cacheEligibleCalls} calls. Every call is re-billing the full system prompt, `
                + 'tool schemas and task context. Check ANTHROPIC_PROMPT_CACHE_ENABLED, the model\'s '
                + 'minimum cacheable prefix, and that the system prompt is stable across calls.',
            );
        } else {
            log.info(`Anthropic prompt cache active: ${cls._cacheReadTotal.toLocaleString()} cache-read tokens over ${cls._cacheEligibleCalls} calls`);
        }
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

        this.trackCacheEffectiveness(totals.cacheReadTokens ?? 0);

        tokenTracker.recordCall({
            agentId: this.agentId,
            model: this.model,
            phase: this.phase,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.totalTokens,
            ...(totals.cacheReadTokens !== undefined && { cacheReadTokens: totals.cacheReadTokens }),
            ...(totals.cacheCreationTokens !== undefined && { cacheCreationTokens: totals.cacheCreationTokens }),
            timestamp: new Date().toISOString(),
            ...(this._invocationId && { invocationId: this._invocationId }),
        });
    }
}
