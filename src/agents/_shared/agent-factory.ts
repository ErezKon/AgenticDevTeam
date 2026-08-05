/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { LLM_BASE_URL, LLM_MODEL, RESPONSE_SCHEMA_COMPACT } from '../../config';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { throttledFetch } from '../../utils/llm-throttle';
import { withLoopGuard } from './tool-loop-guard';
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
    /** Timeout in ms per LLM call (default 120000). */
    timeout?: number;
    /** Pipeline phase for token tracking (e.g. "architect", "development"). */
    phase?: string;
    /** Max total tool calls before the loop guard poisons all tools (default 22, dev agents should use higher). */
    maxToolCalls?: number;
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
    const throttled = throttledFetch(oauthFetch);

    const modelName = cfg.model ?? LLM_MODEL;
    const tokenCallback = new TokenUsageCallbackHandler(cfg.id, modelName, cfg.phase ?? cfg.id);

    const model = new ChatOpenAI({
        model: modelName,
        temperature: cfg.temperature ?? 0.3,
        // Retries are handled centrally: llm-throttle applies a global 429 cooldown
        // and retry.ts retries whole agent invocations. LangChain's own retries
        // multiplied request volume (5 x 6 = 30 HTTP calls per logical call) and
        // sustained the 429 storm seen in runs 5 & 6.
        maxRetries: 0,
        timeout: cfg.timeout ?? 120000,
        openAIApiKey: apiKey,
        apiKey: apiKey,
        configuration: {
            baseURL: LLM_BASE_URL,
            fetch: throttled,
        },
        callbacks: [tokenCallback],
    });

    let prompt = cfg.systemPrompt;
    if (cfg.responseFormat) {
        const rawSchema = z.toJSONSchema(cfg.responseFormat);
        let jsonSchema: string;
        if (RESPONSE_SCHEMA_COMPACT) {
            // Strip deep description fields and emit compact JSON to save tokens
            const compacted = stripDeepDescriptions(rawSchema, 0);
            jsonSchema = JSON.stringify(compacted);
        } else {
            jsonSchema = JSON.stringify(rawSchema, null, 2);
        }
        prompt += `\n\n<response_format>\nCRITICAL: Your final response MUST be a single valid JSON object matching this JSON schema:\n${jsonSchema}\n\nDo NOT wrap the JSON in markdown code blocks or backticks.\nDo NOT include any text, commentary, or markdown before or after the JSON object.\nYour ENTIRE response must be parseable by JSON.parse().\n</response_format>`;
    }

    const guardedTools = withLoopGuard(cfg.tools, cfg.id, cfg.maxToolCalls);

    return createReactAgent({
        llm: model,
        checkpointer,
        prompt,
        tools: guardedTools,
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
