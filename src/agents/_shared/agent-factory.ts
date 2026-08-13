/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { LLM_BASE_URL, LLM_MODEL, RESPONSE_SCHEMA_COMPACT, RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS, HISTORY_COMPACTION_ENABLED, LLM_JSON_MODE, LLM_MAX_OUTPUT_TOKENS, LLM_REQUEST_TIMEOUT_MS } from '../../config';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { throttledFetch } from '../../utils/llm-throttle';
import { cassetteFetch, LLM_CASSETTE_MODE } from '../../utils/llm-cassette';
import { withLoopGuard } from './tool-loop-guard';
import { compactHistory, recordCompaction } from './history-compactor';
import { TokenUsageCallbackHandler } from '../../utils/token-callback';
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
}

/**
 * Build a LangGraph agent from a config object + API token.
 *
 * Each agent gets its own MemorySaver (checkpointer) so conversation
 * state is isolated per thread_id.
 */
export function buildAgent(apiKey: string, cfg: AgentConfig) {
    const checkpointer = new MemorySaver();

    const oauthFetch: typeof globalThis.fetch = async (url, init) => {
        const freshToken = await getAccessToken();
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${freshToken}`);
        return globalThis.fetch(url, { ...init, headers });
    };
    // Cassette sits inside throttledFetch: recordings capture real responses,
    // replays skip both the OAuth token fetch and the throttle's cooldowns.
    const base = LLM_CASSETTE_MODE === 'off' ? oauthFetch : cassetteFetch(oauthFetch);
    const throttled = throttledFetch(base);

    const modelName = cfg.model ?? LLM_MODEL;
    const tokenCallback = new TokenUsageCallbackHandler(cfg.id, modelName, cfg.phase ?? cfg.id);

    // Enable JSON mode when a response schema is set AND the agent has no tools
    // (tool-using agents produce intermediate non-JSON responses during the ReAct loop).
    const useJsonMode = LLM_JSON_MODE && !!cfg.responseFormat && cfg.tools.length === 0;

    const model = new ChatOpenAI({
        model: modelName,
        temperature: cfg.temperature ?? 0.3,
        // Retries are handled centrally: llm-throttle applies a global 429 cooldown
        // and retry.ts retries whole agent invocations. LangChain's own retries
        // multiplied request volume (5 x 6 = 30 HTTP calls per logical call) and
        // sustained the 429 storm seen in runs 5 & 6.
        maxRetries: 0,
        maxTokens: cfg.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS,
        timeout: cfg.timeout ?? LLM_REQUEST_TIMEOUT_MS,
        openAIApiKey: apiKey,
        apiKey: apiKey,
        configuration: {
            baseURL: LLM_BASE_URL,
            fetch: throttled,
        },
        callbacks: [tokenCallback],
        ...(useJsonMode && {
            modelKwargs: { response_format: { type: 'json_object' } },
        }),
    });

    if (useJsonMode) {
        factoryLog.debug(`${cfg.id}: JSON mode enabled via response_format`);
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

    const preModelHook = HISTORY_COMPACTION_ENABLED
        ? RunnableLambda.from((state: { messages: BaseMessage[] }) => {
            const { messages, stats } = compactHistory(state.messages);
            recordCompaction(stats);
            if (stats.originalChars !== stats.compactedChars) {
                factoryLog.debug(
                    `${cfg.id}: history ${stats.originalChars} -> ${stats.compactedChars} chars ` +
                    `(${stats.toolResultsStubbed} results, ${stats.writeArgsStubbed} write args stubbed)`,
                );
            }
            return { llmInputMessages: messages };
        })
        : undefined;

    const agent = createReactAgent({
        llm: model,
        checkpointer,
        prompt,
        tools: guardedTools,
        preModelHook,
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
