/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { LLM_BASE_URL, LLM_MODEL, RESPONSE_SCHEMA_COMPACT, RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS, HISTORY_COMPACTION_ENABLED, SANITIZE_STREAM_BLOCKS, LLM_JSON_MODE, LLM_MAX_OUTPUT_TOKENS, LLM_REQUEST_TIMEOUT_MS, OPENAI_API_KEY, ANTHROPIC_PROMPT_CACHE_ENABLED, MAX_POST_EXHAUSTION_CALLS, LOOP_GUARD_HARD_CEILING, LOOP_GUARD_PROGRESS_BONUS, ANTHROPIC_AUTO_CACHE, HISTORY_COMPACTION_MODE, INVOCATION_SOFT_LANDING_EFFECTIVE_TOKENS, MAX_INVOCATION_INPUT_TOKENS } from '../../config';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { throttledFetch } from '../../utils/llm-throttle';
import { cassetteFetch, LLM_CASSETTE_MODE } from '../../utils/llm-cassette';
import { withLoopGuard, type ToolBudgets } from './tool-loop-guard';
import { compactHistory, recordCompaction, sanitizeStreamingContentBlocks, normaliseAIMessageForState } from './history-compactor';
import { createEpochCompactor } from './history-epoch';
import { withSystemCacheBreakpoint, withMessageCacheBreakpoints, MAX_CACHE_BREAKPOINTS, EPHEMERAL } from './prompt-cache';
import { TokenUsageCallbackHandler } from '../../utils/token-callback';
import { DebugTraceCallbackHandler } from '../../utils/debug-llm-callback';
import { isDebugMode } from '../../utils/debug-trace';
import { tokenTracker } from '../../utils/token-tracker';
import { emitRunEvent } from '../../utils/event-bus';
import { createChatModel, detectProvider, type LLMProvider } from './llm-provider';
import { getLogger } from '../../utils/logger';

const factoryLog = getLogger('[agent-factory]', 226);

export interface AgentConfig {
    /** Unique agent identifier (e.g. "architect", "junior-react"). */
    id: string;
    /** System prompt for the agent. */
    systemPrompt: string;
    /** Tools available to the agent. */
    tools: StructuredToolInterface[];
    /** Optional Zod schema for structured output. */
    responseFormat?: z.ZodTypeAny;
    /** LLM temperature (default 0.3). */
    temperature?: number;
    /** Model override (default from config.LLM_MODEL). */
    model?: string;
    /** Timeout in ms per LLM call (default LLM_REQUEST_TIMEOUT_MS). */
    timeout?: number;
    /** Pipeline phase for token tracking (e.g. "architect", "development"). */
    phase?: string;
    /** Max total tool calls before the loop guard poisons all tools (default 22, dev agents should use higher). */
    maxToolCalls?: number;
    /**
     * Per-category read/write/shell/turn budgets (Plan 22, A1). When set, this
     * takes priority over `maxToolCalls` and the guard runs in category mode, so
     * an agent that has spent its read budget can still write files.
     *
     * Before Plan 22 the factory always passed `maxToolCalls` (a number), which
     * selected the guard's legacy flat-ceiling path and left the whole category
     * system as dead code.
     */
    toolBudgets?: ToolBudgets;
    /** Effective input tokens per invocation after which the agent lands softly
     *  (default INVOCATION_SOFT_LANDING_EFFECTIVE_TOKENS; the strong fixer passes
     *  STRONG_FIXER_MAX_INPUT_TOKENS). 0 disables it (Plan 30-06). */
    softLandingEffectiveTokens?: number;
    /** Max output tokens for this agent (overrides LLM_MAX_OUTPUT_TOKENS). */
    maxOutputTokens?: number;
    /** If true, .describe() strings are preserved in the JSON Schema injected into the prompt.
     *  Planning agents need these for semantic guidance (P6). */
    keepSchemaDescriptions?: boolean;
    /** Does nucleus sampling, in which we compute the
     * cumulative distribution over all the options for each
     * subsequent token in decreasing probability order and
     * cut it off once it reaches a particular probability
     * specified by top_p. Defaults to -1, which disables it.
     * Note that you should either alter temperature or top_p,
     * but not both.
     */
    topP?: number;
    /** Only sample from the top K options for each subsequent
     * token. Used to remove "long tail" low probability
     * responses. Defaults to -1, which disables it.
     */
    topK?: number;
}

/**
 * Build a LangGraph agent from a config object + API token.
 *
 * Each agent gets its own MemorySaver (checkpointer) so conversation
 * state is isolated per thread_id.
 */
export function buildAgent(apiKey: string, cfg: AgentConfig) {
    const checkpointer = new MemorySaver();

    const modelName = cfg.model ?? LLM_MODEL;
    const provider = detectProvider(modelName);
    const tokenCallback = new TokenUsageCallbackHandler(cfg.id, modelName, cfg.phase ?? cfg.id);
    const debugCallback = isDebugMode() ? new DebugTraceCallbackHandler(cfg.id, modelName, cfg.phase ?? cfg.id) : null;

    // Enable JSON mode when a response schema is set AND the agent has no tools
    // (tool-using agents produce intermediate non-JSON responses during the ReAct loop).
    // JSON mode via response_format is only supported by OpenAI-compatible APIs.
    const useJsonMode = LLM_JSON_MODE && !!cfg.responseFormat && cfg.tools.length === 0 && provider === 'openai';

    // When OPENAI_API_KEY is set, use it directly — no OAuth fetch chain needed.
    // When absent, fall back to the OAuth client-credentials flow.
    // Anthropic and Google always use their own API keys and HTTP handling.
    let customFetch: typeof fetch | undefined;
    let effectiveApiKey = apiKey;
    if (provider === 'openai') {
        if (OPENAI_API_KEY) {
            // Direct API key — ChatOpenAI handles auth natively, no custom fetch needed.
            effectiveApiKey = OPENAI_API_KEY;
            factoryLog.debug(`${cfg.id}: using OPENAI_API_KEY (direct API key, no OAuth)`);
        } else {
            // OAuth fetch chain — token is refreshed on every request.
            const oauthFetch: typeof globalThis.fetch = async (url, init) => {
                const freshToken = await getAccessToken();
                const headers = new Headers(init?.headers);
                headers.set('Authorization', `Bearer ${freshToken}`);
                return globalThis.fetch(url, { ...init, headers });
            };
            // Cassette sits inside throttledFetch: recordings capture real responses,
            // replays skip both the OAuth token fetch and the throttle's cooldowns.
            const base = LLM_CASSETTE_MODE === 'off' ? oauthFetch : cassetteFetch(oauthFetch);
            customFetch = throttledFetch(base);
        }
    }

    const model = createChatModel({
        modelName,
        temperature: cfg.temperature ?? 0.3,
        maxTokens: cfg.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS,
        timeout: cfg.timeout ?? LLM_REQUEST_TIMEOUT_MS,
        callbacks: debugCallback ? [tokenCallback, debugCallback] : [tokenCallback],
        // OpenAI-specific options (ignored by Anthropic/Google)
        apiKey: effectiveApiKey,
        baseURL: LLM_BASE_URL,
        customFetch,
        jsonMode: useJsonMode,
        topP: cfg.topP,
        topK: cfg.topK,
    });

    if (useJsonMode) {
        factoryLog.debug(`${cfg.id}: JSON mode enabled via response_format`);
    }
    if (provider !== 'openai') {
        factoryLog.debug(`${cfg.id}: using ${provider} provider for model "${modelName}"`);
    }

    let prompt = cfg.systemPrompt;
    if (cfg.responseFormat) {
        const rawSchema = z.toJSONSchema(cfg.responseFormat);
        let jsonSchema: string;
        if (RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS && !cfg.keepSchemaDescriptions) {
            // Strip ALL descriptions and noise for maximum token savings
            const compacted = stripAllSchemaDescriptions(rawSchema);
            jsonSchema = JSON.stringify(compacted);
        } else if (RESPONSE_SCHEMA_COMPACT && !cfg.keepSchemaDescriptions) {
            // Strip deep description fields and emit compact JSON to save tokens
            const compacted = stripDeepDescriptions(rawSchema, 0);
            jsonSchema = JSON.stringify(compacted);
        } else {
            jsonSchema = JSON.stringify(rawSchema, null, 2);
        }
        prompt += `\n\n<response_format>\nCRITICAL: Your final response MUST be a single valid JSON object matching this JSON schema:\n${jsonSchema}\n\nDo NOT wrap the JSON in markdown code blocks or backticks.\nDo NOT include any text, commentary, or markdown before or after the JSON object.\nYour ENTIRE response must be parseable by JSON.parse().\n</response_format>`;
    }

    // Plan 22 A1: prefer per-category budgets; fall back to the legacy flat
    // ceiling for pipeline/reviewer agents that have not been migrated.
    const guard = withLoopGuard(cfg.tools, cfg.id, cfg.toolBudgets
        ? {
            budgets: cfg.toolBudgets,
            hardCeiling: LOOP_GUARD_HARD_CEILING,
            progressBonus: LOOP_GUARD_PROGRESS_BONUS,
            maxPostExhaustionCalls: MAX_POST_EXHAUSTION_CALLS,
        }
        : cfg.maxToolCalls);
    const { tools: guardedTools, isCeilingReached, isTerminationDemanded, requestTermination, noteElidedResults, getUsage } = guard;

    const cacheEligible = ANTHROPIC_PROMPT_CACHE_ENABLED && provider === 'anthropic';
    let cacheBreakpointsLogged = false;

    // Plan 30-06: epoch mode freezes the compacted view and appends to it, so every
    // request extends the previous one and is read from the prompt cache. Plan 24, C1:
    // the agent id scopes the compaction memo per agent instance (cleared on respawn).
    const compact = HISTORY_COMPACTION_MODE === 'epoch'
        ? createEpochCompactor({ threadId: cfg.id })
        : (messages: BaseMessage[]) => compactHistory(messages, { threadId: cfg.id });

    // ── Plan 30-06: real-time soft landing ───────────────────────────────
    // Before each model call: once the invocation has spent its effective-token
    // budget (or the raw MAX_INVOCATION_INPUT_TOKENS backstop), that call can use no
    // tool, so the agent returns its final JSON. It replaces discarding finished work
    // when an invocation crossed the raw ceiling.
    const softLandingAt = cfg.softLandingEffectiveTokens ?? INVOCATION_SOFT_LANDING_EFFECTIVE_TOKENS;
    let softLanding: string | null = null;
    const landIfOverBudget = (): void => {
        const invocationId = tokenCallback.getInvocationId();
        if (softLanding || cfg.tools.length === 0 || !invocationId) return;
        const effective = Math.round(tokenTracker.getInvocationEffectiveTokens(invocationId));
        const raw = tokenTracker.getInvocationInputTokens(invocationId);
        const reason = softLandingAt > 0 && effective >= softLandingAt
            ? `the invocation has spent its input budget (${effective.toLocaleString()} effective input tokens, soft landing at ${softLandingAt.toLocaleString()})`
            : MAX_INVOCATION_INPUT_TOKENS > 0 && raw >= MAX_INVOCATION_INPUT_TOKENS
                ? `the invocation has reached MAX_INVOCATION_INPUT_TOKENS (${raw.toLocaleString()} of ${MAX_INVOCATION_INPUT_TOKENS.toLocaleString()} input tokens)`
                : null;
        if (!reason) return;
        softLanding = reason;
        requestTermination(reason);
        factoryLog.warn(`${cfg.id}: soft landing — ${reason}; this model call can use no tool`);
        emitRunEvent('agent:budget-exhausted', {
            agentId: cfg.id, invocationId, softLanding: true, effectiveTokens: effective, inputTokens: raw,
            threshold: softLandingAt, ceiling: MAX_INVOCATION_INPUT_TOKENS,
        });
    };

    // History compaction runs inside wrapModelCall so the compacted messages are
    // only what the LLM sees — the persisted graph state keeps the full history.
    const historyCompaction = createMiddleware({
        name: 'history-compaction',
        // Also runs the streaming-residue sanitiser (Plan 21, A2), the tool
        // withdrawal that ends a post-exhaustion spin (Plan 22, A4) or lands an
        // invocation softly (Plan 30-06), and the Anthropic prompt cache (Plan 22,
        // D1; Plan 30-06) — hence it is registered whenever ANY of those applies.
        wrapModelCall: (request, handler) => {
            let incoming = request.messages;
            if (SANITIZE_STREAM_BLOCKS) {
                const sanitized = sanitizeStreamingContentBlocks(incoming);
                if (sanitized.blocksDropped > 0) {
                    factoryLog.warn(`${cfg.id}: dropped ${sanitized.blocksDropped} streaming residue content block(s) before the LLM call`);
                }
                incoming = sanitized.messages;
            }

            if (HISTORY_COMPACTION_ENABLED) {
                const { messages, stats, stubbedToolCallIds } = compact(incoming);
                recordCompaction(stats);
                // Plan 30-07: reads the model can no longer see may run again
                noteElidedResults(stubbedToolCallIds);
                if (stats.originalChars !== stats.compactedChars) {
                    factoryLog.debug(
                        `${cfg.id}: history ${stats.originalChars} -> ${stats.compactedChars} chars ` +
                        `(${stats.toolResultsStubbed} results, ${stats.writeArgsStubbed} write args stubbed)`,
                    );
                }
                incoming = messages;
            }

            const next: typeof request = { ...request, messages: incoming };

            // ── Plan 22 A4: end the post-exhaustion spin ─────────────────
            // The agent has been told twice that its budget is gone and is still
            // calling tools — or its invocation budget is spent (Plan 30-06). Make
            // the model unable to emit another tool call so the ReAct loop must
            // terminate with its final JSON. Throwing from a tool does not work:
            // LangGraph's ToolNode converts tool errors into ToolMessages and carries on.
            landIfOverBudget();
            if (isTerminationDemanded()) {
                factoryLog.warn(
                    `${cfg.id}: no tool calls in this model call — ${softLanding ?? 'budget exhausted'} (${JSON.stringify(getUsage())})`,
                );
                forbidToolCalls(next, provider);
            }

            // ── Plan 22 D1 + Plan 30-06: Anthropic prompt cache ──────────
            if (cacheEligible) {
                next.systemMessage = withSystemCacheBreakpoint(request.systemMessage, {
                    model: modelName,
                    tools: next.tools,
                    agentId: cfg.id,
                });
                const systemBreakpoints = next.systemMessage === request.systemMessage ? 0 : 1;
                const autoBreakpoints = ANTHROPIC_AUTO_CACHE ? 1 : 0;
                const cached = withMessageCacheBreakpoints(next.messages, {
                    autoCache: ANTHROPIC_AUTO_CACHE,
                    budget: MAX_CACHE_BREAKPOINTS - systemBreakpoints - autoBreakpoints,
                });
                next.messages = cached.messages;
                // Automatic caching: one top-level breakpoint that follows the conversation
                if (ANTHROPIC_AUTO_CACHE) next.modelSettings = { ...request.modelSettings, cache_control: EPHEMERAL };
                if (!cacheBreakpointsLogged) {
                    cacheBreakpointsLogged = true;
                    factoryLog.debug(
                        `${cfg.id}: anthropic prompt cache — ${systemBreakpoints + cached.breakpoints + autoBreakpoints} breakpoint(s) `
                        + `(system=${systemBreakpoints}, messages=${cached.breakpoints}, automatic=${autoBreakpoints})`,
                    );
                }
            }

            return handler(next);
        },

        // ── Plan 22 E2: normalise before the message reaches state ───────
        // `sanitizeStreamingContentBlocks` works on a copy by design, so residue
        // otherwise accumulates in the checkpoint and is re-scanned every turn —
        // the cause of the `dropped 2 … dropped 31` monotonic growth in the
        // pacmanclaude log. Cleaning the fresh chunk here makes that counter flat.
        afterModel: (state: any) => {
            if (!SANITIZE_STREAM_BLOCKS) return undefined;
            const messages = state?.messages;
            if (!Array.isArray(messages) || messages.length === 0) return undefined;
            const last = messages[messages.length - 1];
            const clean = normaliseAIMessageForState(last);
            if (clean === last) return undefined;
            return { messages: [clean] };
        },
    });

    const agent = createAgent({
        model,
        checkpointer,
        systemPrompt: prompt,
        tools: guardedTools,
        // Every agent with tools needs it for the termination paths (Plan 22 A4, Plan 30-06)
        middleware: (HISTORY_COMPACTION_ENABLED || SANITIZE_STREAM_BLOCKS || cacheEligible || cfg.tools.length > 0)
            ? [historyCompaction]
            : [],
    });

    // Expose isCeilingReached and setInvocationId on the agent so callers
    // (e.g. respawn logic, invocation tracking) can interact with the agent.
    return Object.assign(agent, {
        isCeilingReached,
        isTerminationDemanded,
        /** Why this instance landed softly (Plan 30-06), or null — a soft landing is never respawned. */
        softLanding: (): string | null => softLanding,
        /** Live tool-budget usage — surfaced in the respawn handoff (Plan 22, C2). */
        getToolUsage: getUsage,
        /** The fully-assembled system prompt (incl. the injected response schema).
         *  createAgent keeps it out of `result.messages`, so the full-response log
         *  reads it from here to record both halves of the conversation. */
        systemPromptText: prompt,
        /** Tag all subsequent LLM calls with an invocation ID for per-invocation attribution. */
        setInvocationId: (id: string | undefined) => {
            tokenCallback.setInvocationId(id);
            debugCallback?.setInvocationId(id);
        },
    });
}

/**
 * Make the model call unable to emit a tool call (Plan 22 A4, Plan 30-06).
 *
 * Anthropic and Google keep the tool definitions and get `tool_choice: none`: on
 * Anthropic the tools head the cached prompt prefix, and dropping them turns the
 * landing call into a full cache miss. OpenAI-compatible backends get no tools and
 * no tool_choice — OpenAI rejects a tool_choice without tools, and not every
 * compatible backend honours `none`.
 */
function forbidToolCalls(request: { tools: unknown[]; toolChoice?: unknown }, provider: LLMProvider): void {
    if (provider === 'openai') {
        request.tools = [];
        request.toolChoice = undefined;
    } else {
        request.toolChoice = 'none';
    }
}

/**
 * Strip `description` fields deeper than two levels from a JSON Schema object.
 * `z.toJSONSchema` output carries every `.describe()` string twice (once as
 * `description`, once inside nested `$defs`). Stripping the deep copies saves
 * tokens without losing top-level field names and their descriptions.
 */
function stripDeepDescriptions(obj: unknown, depth: number): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => stripDeepDescriptions(item, depth));
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (key === 'description' && depth > 2) continue;
        result[key] = stripDeepDescriptions(value, depth + 1);
    }
    return result;
}

/** Keys stripped from every level when RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS is true. */
const SCHEMA_NOISE_KEYS = new Set(['description', 'additionalProperties', '$schema']);

/**
 * Aggressively strip ALL description fields, `additionalProperties`,
 * `$schema`, and empty `required: []` arrays from a JSON Schema object.
 *
 * Field names in DeveloperOutputSchema / ReviewOutputSchema are
 * self-documenting (fileChanges, notes, mermaidDiagram, status, comments)
 * so descriptions are unnecessary overhead re-billed on every LLM call.
 */
function stripAllSchemaDescriptions(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => stripAllSchemaDescriptions(item));
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (SCHEMA_NOISE_KEYS.has(key)) continue;
        if (key === 'required' && Array.isArray(value) && value.length === 0) continue;
        result[key] = stripAllSchemaDescriptions(value);
    }
    return result;
}
