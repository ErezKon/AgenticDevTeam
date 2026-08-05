/**
 * Shared agent factory — wraps LangChain createAgent() with
 * common configuration (model, checkpointer, logging).
 */
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LLM_BASE_URL, LLM_MODEL } from '../../config';
import { getAccessToken } from '../../utils/oauth-auth.util';
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

/** Max consecutive identical tool calls before the guard returns an error. */
const MAX_REPEATED_TOOL_CALLS = 2;

/**
 * Extra attempts after the first guard warning before throwing to
 * terminate the agent. Total identical calls before hard stop:
 * MAX_REPEATED_TOOL_CALLS + LOOP_TOLERANCE (2 + 1 = 3 by default).
 */
const LOOP_TOLERANCE = 1;

/**
 * Tool names that mutate the workspace (file writes, edits).
 *
 * When any of these tools is called, the per-tool repeat history is
 * cleared for *all* tools. This prevents false loop-detection on
 * tools like `run_command` that are legitimately re-invoked after
 * the agent has made code changes between calls.
 */
const MUTATING_TOOL_NAMES = new Set([
    'write_file', 'edit_file', 'create_file', 'delete_file',
]);

/**
 * Wrap tools with a loop-detection guard.
 *
 * Tracks each tool's recent call arguments. If the same tool is called
 * with identical arguments more than MAX_REPEATED_TOOL_CALLS times in a
 * row, it returns an error message asking the model to stop. If the
 * model still keeps calling after LOOP_TOLERANCE more attempts, the
 * guard "poisons" all tools — every subsequent call to ANY tool returns
 * an instant error without executing the underlying tool.
 *
 * Note: We cannot use `throw` to terminate the agent because LangGraph's
 * ToolNode catches all errors and converts them to error ToolMessages,
 * which the model then ignores and retries. The poisoned-flag approach
 * ensures no further tool side-effects occur. Combined with the per-type
 * recursion limits (PIPELINE_RECURSION_LIMIT, DEV_RECURSION_LIMIT,
 * REVIEWER_RECURSION_LIMIT), this keeps token waste to a minimum.
 */
/** Default ceiling for total tool calls across all tools. */
const DEFAULT_MAX_TOTAL_CALLS = 22;

function withLoopGuard(tools: StructuredToolInterface[], agentId: string, maxTotalCalls?: number): StructuredToolInterface[] {
    if (tools.length === 0) return tools;

    // Per-tool call tracking: maps tool name -> list of recent arg signatures
    const callHistory = new Map<string, string[]>();
    // Once poisoned, ALL tool calls return an instant error string
    let poisoned = false;
    // Counter for total tool calls across ALL tools (detects cross-tool loops).
    // Must be well below DEV_RECURSION_LIMIT (each tool call = 2 graph steps)
    // so this guard fires before LangGraph's hard recursion limit.
    let totalCalls = 0;
    const MAX_TOTAL_CALLS = maxTotalCalls ?? DEFAULT_MAX_TOTAL_CALLS;

    const POISON_MSG = JSON.stringify({
        error: `TERMINATED: Agent "${agentId}" is stuck in a tool loop. ` +
            'ALL tools are disabled and will return this error. ' +
            'You MUST stop calling tools immediately. ' +
            'Produce your final JSON response with whatever information you have gathered so far. ' +
            'If you have no information, return a minimal valid JSON object matching the response schema.',
    });

    return tools.map((originalTool) => {
        const wrappedFn = async (args: Record<string, any>) => {
            const toolName = originalTool.name;

            // Fast path: if already poisoned, return error immediately for ANY tool
            if (poisoned) {
                return POISON_MSG;
            }

            totalCalls++;
            // Safety net: if total tool calls across all tools exceed ceiling, poison
            if (totalCalls > MAX_TOTAL_CALLS) {
                factoryLog.error(
                    `${agentId}: exceeded ${MAX_TOTAL_CALLS} total tool calls — poisoning all tools`,
                );
                poisoned = true;
                return POISON_MSG;
            }

            const argSig = JSON.stringify(args);

            // If a mutating tool was invoked, the workspace has changed,
            // so re-running read/command tools with the same args is valid.
            // Clear per-tool repeat histories to prevent false positives.
            if (MUTATING_TOOL_NAMES.has(toolName)) {
                callHistory.clear();
            }

            const history = callHistory.get(toolName) ?? [];
            // Count consecutive identical calls at the tail of history
            let repeats = 0;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === argSig) repeats++;
                else break;
            }

            if (repeats >= MAX_REPEATED_TOOL_CALLS + LOOP_TOLERANCE) {
                factoryLog.error(
                    `${agentId}: tool "${toolName}" called ${repeats + 1} times with identical args — poisoning all tools`,
                );
                poisoned = true;
                return POISON_MSG;
            }

            if (repeats >= MAX_REPEATED_TOOL_CALLS) {
                factoryLog.warn(
                    `${agentId}: tool "${toolName}" called ${repeats + 1} times with identical args — breaking loop`,
                );
                history.push(argSig);
                callHistory.set(toolName, history);
                return JSON.stringify({
                    error: `Tool "${toolName}" has been called ${repeats + 1} times with the same arguments. ` +
                        'This indicates a loop. STOP calling tools and produce your final JSON response now. ' +
                        'Use the information you already have. Do NOT call any more tools.',
                });
            }

            history.push(argSig);
            callHistory.set(toolName, history);

            return originalTool.invoke(args);
        };

        return tool(wrappedFn, {
            name: originalTool.name,
            description: originalTool.description,
            schema: (originalTool as any).schema,
        });
    });
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

    const modelName = cfg.model ?? LLM_MODEL;
    const tokenCallback = new TokenUsageCallbackHandler(cfg.id, modelName, cfg.phase ?? cfg.id);

    const model = new ChatOpenAI({
        model: modelName,
        temperature: cfg.temperature ?? 0.3,
        maxRetries: 6,
        timeout: cfg.timeout ?? 120000,
        openAIApiKey: apiKey,
        apiKey: apiKey,
        configuration: {
            baseURL: LLM_BASE_URL,
            fetch: oauthFetch,
        },
        callbacks: [tokenCallback],
    });

    let prompt = cfg.systemPrompt;
    if (cfg.responseFormat) {
        const jsonSchema = JSON.stringify(z.toJSONSchema(cfg.responseFormat), null, 2);
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
