/**
 * Multi-provider LLM factory (Sub-Plan 20).
 *
 * Detects the LLM provider from the model name and creates the appropriate
 * LangChain chat model class (ChatOpenAI, ChatAnthropic, or ChatGoogleGenerativeAI).
 *
 * Provider detection:
 *   /claude|anthropic/i  -> 'anthropic'  (ChatAnthropic)
 *   /gemini/i            -> 'google'     (ChatGoogleGenerativeAI)
 *   everything else      -> 'openai'     (ChatOpenAI — covers gpt-*, o1-*, llama-*, mistral-*, etc.)
 *
 * The escape hatch `LLM_PROVIDER_DETECTION=openai` forces all models through
 * ChatOpenAI regardless of name (useful for OpenAI-compatible proxies).
 */
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
    ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL,
    GOOGLE_API_KEY,
    GOOGLE_BASE_URL,
    LLM_PROVIDER_DETECTION,
} from '../../config';
import { getLogger } from '../../utils/logger';

const log = getLogger('[llm-provider]', 226);

// ─── Types ──────────────────────────────────────────────────────────────────

export type LLMProvider = 'openai' | 'anthropic' | 'google';

export interface CreateModelOpts {
    modelName: string;
    temperature: number;
    maxTokens?: number;
    timeout?: number;
    callbacks: any[];
    // OpenAI-specific
    apiKey?: string;         // OAuth token
    baseURL?: string;
    customFetch?: typeof fetch;
    jsonMode?: boolean;
    topP?: number;
    topK?: number;
}

// ─── Provider Detection ─────────────────────────────────────────────────────

/**
 * Detect the LLM provider from a model name.
 *
 * - `/claude|anthropic/i` -> `'anthropic'`
 * - `/gemini/i`           -> `'google'`
 * - Everything else       -> `'openai'` (covers gpt-*, o1-*, llama-*, mistral-*, gemma-*, etc.)
 */
export function detectProvider(modelName: string): LLMProvider {
    if (LLM_PROVIDER_DETECTION === 'openai') return 'openai';

    const lower = modelName.toLowerCase();
    if (/claude|anthropic/.test(lower)) return 'anthropic';
    if (/gemini/.test(lower)) return 'google';
    return 'openai';
}

// ─── Model Factory ──────────────────────────────────────────────────────────

/**
 * Create the appropriate LangChain chat model for the detected provider.
 *
 * - **OpenAI**: Uses OAuth fetch chain, `LLM_BASE_URL`, JSON mode support.
 * - **Anthropic**: Uses `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`. No OAuth, no custom fetch.
 * - **Google**: Uses `GOOGLE_API_KEY`, optional `GOOGLE_BASE_URL`. No OAuth, no custom fetch.
 *
 * All providers: `maxRetries: 0` (retries handled centrally by retry.ts / llm-throttle.ts).
 */
export function createChatModel(opts: CreateModelOpts): BaseChatModel {
    const provider = detectProvider(opts.modelName);

    switch (provider) {
        case 'anthropic': {
            if (!ANTHROPIC_API_KEY) {
                log.warn(`Model "${opts.modelName}" detected as Anthropic but ANTHROPIC_API_KEY is not set`);
            }

            // Adaptive-only models (claude-opus-4-7+, claude-fable-5, claude-mythos-*)
            // reject temperature, topK, and topP at call time via
            // validateInvocationParamCompatibility in @langchain/anthropic.
            // Must stay in sync with ADAPTIVE_ONLY_MODEL_PREFIXES in the SDK.
            const adaptiveOnly = /^claude-(opus-4-[7-9]|opus-[5-9]|fable-5|mythos)/.test(opts.modelName);
            if (adaptiveOnly) {
                log.debug(`Model "${opts.modelName}" is adaptive-only — omitting temperature/topK/topP`);
            } else {
                log.debug(`Creating ChatAnthropic for model "${opts.modelName}"`);
            }

            return new ChatAnthropic({
                model: opts.modelName,
                // Sampling params — omitted entirely for adaptive-only models.
                ...(adaptiveOnly ? {} : {
                    temperature: opts.temperature,
                    ...(opts.topK !== undefined ? { topK: opts.topK } : {}),
                    ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
                }),
                maxTokens: opts.maxTokens,
                anthropicApiKey: ANTHROPIC_API_KEY,
                ...(ANTHROPIC_BASE_URL && { clientOptions: { baseURL: ANTHROPIC_BASE_URL } }),
                maxRetries: 0,
                // Streaming is required — Anthropic's HTTP endpoint times out after
                // ~10 minutes on non-streaming requests, killing long agent runs.
                // The sanitizeStreamingContentBlocks() middleware (Plan 21 A2, wired
                // in agent-factory.ts) strips `input_json_delta` residue from
                // AIMessage.content before every LLM call to prevent 400
                // "tool_use.id: Field required" errors.
                streaming: true,
                callbacks: opts.callbacks,
            });
        }

        case 'google': {
            if (!GOOGLE_API_KEY) {
                log.warn(`Model "${opts.modelName}" detected as Google but GOOGLE_API_KEY is not set`);
            }
            log.debug(`Creating ChatGoogleGenerativeAI for model "${opts.modelName}"`);
            return new ChatGoogleGenerativeAI({
                model: opts.modelName,
                temperature: opts.temperature,
                maxOutputTokens: opts.maxTokens,
                apiKey: GOOGLE_API_KEY,
                ...(GOOGLE_BASE_URL && { baseUrl: GOOGLE_BASE_URL }),
                maxRetries: 0,
                callbacks: opts.callbacks,
            });
        }

        case 'openai':
        default: {
            log.debug(`Creating ChatOpenAI for model "${opts.modelName}"`);
            const model = new ChatOpenAI({
                model: opts.modelName,
                temperature: opts.temperature,
                maxRetries: 0,
                maxTokens: opts.maxTokens,
                timeout: opts.timeout,
                apiKey: opts.apiKey,
                topP: opts?.topP ?? undefined,
                configuration: {
                    baseURL: opts.baseURL,
                    fetch: opts.customFetch,
                },
                callbacks: opts.callbacks,
            });

            // JSON mode is passed as a CALL OPTION, not a model kwarg (Plan 21, E2).
            // `modelKwargs.response_format` is spread verbatim into the request
            // body, which the Responses API (used for `*codex*` / `gpt-5.x-pro`
            // models) rejects with 400 "Unsupported parameter: 'response_format'".
            // `withConfig` routes it through `_getResponseFormat()`, which emits
            // `response_format` on Chat Completions and `text.format` on Responses.
            if (!opts.jsonMode) return model;
            return model.withConfig({ response_format: { type: 'json_object' } }) as unknown as BaseChatModel;
        }
    }
}
