/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
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
        maxRetries: 6,
        timeout: cfg.timeout ?? 120000,
        openAIApiKey: apiKey,
        apiKey: apiKey,
        configuration: {
            baseURL: LLM_BASE_URL,
        },
    });

    let prompt = cfg.systemPrompt;
    if (cfg.responseFormat) {
        const jsonSchema = JSON.stringify(z.toJSONSchema(cfg.responseFormat), null, 2);
        prompt += `\n\n<response_format>\nCRITICAL: Your final response MUST be a single valid JSON object matching this JSON schema:\n${jsonSchema}\n\nDo NOT wrap the JSON in markdown code blocks or backticks.\nDo NOT include any text, commentary, or markdown before or after the JSON object.\nYour ENTIRE response must be parseable by JSON.parse().\n</response_format>`;
    }

    return createReactAgent({
        llm: model,
        checkpointer,
        prompt,
        tools: cfg.tools,
    });
}
