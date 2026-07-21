/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod';
import { LLM_BASE_URL, LLM_MODEL } from '../../config';

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
}

/**
 * Build a LangGraph agent from a config object + API token.
 *
 * Each agent gets its own MemorySaver (checkpointer) so conversation
 * state is isolated per thread_id.
 */
export function buildAgent(apiKey: string, cfg: AgentConfig) {
    const checkpointer = new MemorySaver();

    const model = new ChatOpenAI({
        model: cfg.model ?? LLM_MODEL,
        temperature: cfg.temperature ?? 0.3,
        maxRetries: 3,
        timeout: cfg.timeout ?? 120000,
        openAIApiKey: apiKey,
        apiKey: apiKey,
        configuration: {
            baseURL: LLM_BASE_URL,
        },
    });

    const boundModel = cfg.responseFormat
        ? model.withStructuredOutput(cfg.responseFormat)
        : model;

    return createReactAgent({
        llm: model,
        checkpointer,
        prompt: cfg.systemPrompt,
        tools: cfg.tools,
    });
}
