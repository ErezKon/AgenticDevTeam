/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { LLM_BASE_URL, LLM_MODEL, RESPONSE_SCHEMA_COMPACT, RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS, HISTORY_COMPACTION_ENABLED, LLM_JSON_MODE, LLM_MAX_OUTPUT_TOKENS, LLM_REQUEST_TIMEOUT_MS, OPENAI_API_KEY } from '../../config';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { throttledFetch } from '../../utils/llm-throttle';
import { cassetteFetch, LLM_CASSETTE_MODE } from '../../utils/llm-cassette';
import { withLoopGuard } from './tool-loop-guard';
import { compactHistory, recordCompaction } from './history-compactor';
import { TokenUsageCallbackHandler } from '../../utils/token-callback';
import { createChatModel, detectProvider } from './llm-provider';
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
        callbacks: [tokenCallback],
        // OpenAI-specific options (ignored by Anthropic/Google)
        apiKey: effectiveApiKey,
        baseURL: LLM_BASE_URL,
        customFetch,
        jsonMode: useJsonMode,
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

    const { tools: guardedTools, isCeilingReached } = withLoopGuard(cfg.tools, cfg.id, cfg.maxToolCalls);

    // History compaction runs inside wrapModelCall so the compacted messages are
    // only what the LLM sees — the persisted graph state keeps the full history.
    const historyCompaction = createMiddleware({
        name: 'history-compaction',
        wrapModelCall: (request, handler) => {
            const { messages, stats } = compactHistory(request.messages);
            recordCompaction(stats);
            if (stats.originalChars !== stats.compactedChars) {
                factoryLog.debug(
                    `${cfg.id}: history ${stats.originalChars} -> ${stats.compactedChars} chars ` +
                    `(${stats.toolResultsStubbed} results, ${stats.writeArgsStubbed} write args stubbed)`,
                );
            }
            return handler({ ...request, messages });
        },
    });

    const agent = createAgent({
        model,
        checkpointer,
        systemPrompt: prompt,
        tools: guardedTools,
        middleware: HISTORY_COMPACTION_ENABLED ? [historyCompaction] : [],
    });

    // Expose isCeilingReached and setInvocationId on the agent so callers
    // (e.g. respawn logic, invocation tracking) can interact with the agent.
    return Object.assign(agent, {
        isCeilingReached,
        /** Tag all subsequent LLM calls with an invocation ID for per-invocation attribution. */
        setInvocationId: (id: string | undefined) => tokenCallback.setInvocationId(id),
    });
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
