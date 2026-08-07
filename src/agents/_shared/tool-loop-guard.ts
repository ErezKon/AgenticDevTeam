/**
 * Tool loop guard — detects and stops agents stuck in tool-call loops.
 *
 * Extracted from agent-factory.ts for testability and separation of concerns.
 *
 * Changes vs. the original implementation:
 * - Counts TOTAL identical (tool, args) invocations, not just consecutive ones.
 *   Run 6 showed `list_dir . -> list_dir tests -> list_dir src -> list_dir .` —
 *   a non-consecutive repeat that the old guard missed entirely.
 * - Caches results of read-only tools so a duplicate call returns instantly
 *   without re-executing the underlying tool.
 * - Surfaces budget (totalCalls/MAX_TOTAL_CALLS) in warn and poison messages.
 */
import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { getLogger } from '../../utils/logger';

const guardLog = getLogger('[loop-guard]', 226);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Total identical (tool, args) invocations allowed before warning. */
const MAX_REPEATED_TOOL_CALLS = 2;   // 1st call runs, 2nd call warns

/** Extra identical attempts tolerated after the warning before poisoning. */
const LOOP_TOLERANCE = 1;

/** Default ceiling for total tool calls across all tools. */
const DEFAULT_MAX_TOTAL_CALLS = 22;

/**
 * Tool names that mutate the workspace (file writes, edits).
 *
 * When any of these tools is called, the per-call repeat counts AND result
 * cache are cleared for all tools. This prevents false loop-detection on
 * tools like `run_command` that are legitimately re-invoked after
 * the agent has made code changes between calls.
 */
const MUTATING_TOOL_NAMES = new Set([
    'write_file', 'edit_file', 'create_file', 'delete_file',
]);

/**
 * Read-only tools whose results can be served from cache within one agent run.
 * On the first call the result is stored; on a duplicate call the cached result
 * is returned with a prefix note instead of re-executing the tool.
 */
const CACHEABLE_TOOL_NAMES = new Set([
    'read_file', 'list_dir', 'search_code',
    'git_diff_file', 'git_diff_stat', 'git_merge_base_diff', 'git_log', 'git_status',
]);

// ─── Guard implementation ───────────────────────────────────────────────────

/**
 * Result of wrapping tools with a loop-detection guard.
 */
export interface LoopGuardResult {
    /** Guarded tools with loop-detection wrappers. */
    tools: StructuredToolInterface[];
    /** Returns true once the guard has poisoned all tools (total ceiling or repeated-call poison). */
    isCeilingReached: () => boolean;
}

/**
 * Wrap tools with a loop-detection guard.
 *
 * Tracks each (tool, args) pair's total invocation count. If the same tool is
 * called with identical arguments more than MAX_REPEATED_TOOL_CALLS times
 * (total, not just consecutive), it returns a cached result (for read-only
 * tools) or an error message asking the model to stop. If the model still
 * keeps calling after LOOP_TOLERANCE more attempts, the guard "poisons" all
 * tools — every subsequent call to ANY tool returns an instant error without
 * executing the underlying tool.
 *
 * Note: We cannot use `throw` to terminate the agent because LangGraph's
 * ToolNode catches all errors and converts them to error ToolMessages,
 * which the model then ignores and retries. The poisoned-flag approach
 * ensures no further tool side-effects occur. Combined with the per-type
 * recursion limits (PIPELINE_RECURSION_LIMIT, DEV_RECURSION_LIMIT,
 * REVIEWER_RECURSION_LIMIT), this keeps token waste to a minimum.
 */
export function withLoopGuard(
    tools: StructuredToolInterface[],
    agentId: string,
    maxTotalCalls?: number,
): LoopGuardResult {
    if (tools.length === 0) return { tools, isCeilingReached: () => false };

    // Total identical (tool, args) invocation counts: key = `toolName::argSig`
    const callCounts = new Map<string, number>();
    // Cache of results for read-only tools: key = `toolName::argSig`
    const resultCache = new Map<string, string>();
    // Once poisoned, ALL tool calls return an instant error string
    let poisoned = false;
    // Counter for total tool calls across ALL tools (detects cross-tool loops).
    let totalCalls = 0;
    const MAX_TOTAL_CALLS = maxTotalCalls ?? DEFAULT_MAX_TOTAL_CALLS;

    const POISON_MSG = JSON.stringify({
        error: `TERMINATED: Agent "${agentId}" is stuck in a tool loop. ` +
            'ALL tools are disabled and will return this error. ' +
            'You MUST stop calling tools immediately. ' +
            'Produce your final JSON response with whatever information you have gathered so far. ' +
            'If you have no information, return a minimal valid JSON object matching the response schema.',
    });

    const wrappedTools = tools.map((originalTool) => {
        const wrappedFn = async (args: Record<string, any>) => {
            const toolName = originalTool.name;

            // Fast path: if already poisoned, return error immediately for ANY tool
            if (poisoned) {
                return POISON_MSG;
            }

            totalCalls++;
            // Safety net: if total tool calls across all tools exceed ceiling, poison
            if (totalCalls > MAX_TOTAL_CALLS) {
                guardLog.error(
                    `${agentId}: exceeded ${MAX_TOTAL_CALLS} total tool calls (${totalCalls}/${MAX_TOTAL_CALLS}) — poisoning all tools`,
                );
                poisoned = true;
                return POISON_MSG;
            }

            const argSig = JSON.stringify(args);
            const key = `${toolName}::${argSig}`;

            // If a mutating tool was invoked, the workspace has changed,
            // so re-running read/command tools with the same args is valid.
            // Clear per-call repeat counts AND result cache to prevent false positives.
            if (MUTATING_TOOL_NAMES.has(toolName)) {
                // Keep this call's own count: repeating the *identical* mutation
                // (same file, same content) is still a loop, and clearing it
                // would make such a loop undetectable.
                const ownCount = callCounts.get(key) ?? 0;
                callCounts.clear();
                resultCache.clear();
                if (ownCount > 0) callCounts.set(key, ownCount);
            }

            // If run_command was invoked, files may have changed (npm install, etc.).
            // Clear result cache but NOT callCounts — run_command loops are still detected.
            if (toolName === 'run_command') {
                resultCache.clear();
            }

            // Increment the count for this (tool, args) pair BEFORE checking
            // thresholds so the count includes the current invocation.
            // With MAX_REPEATED_TOOL_CALLS = 2: 1st call → count=1 (runs),
            // 2nd call → count=2 (warns/caches), 3rd call → count=3 (poisons).
            const prev = callCounts.get(key) ?? 0;
            const count = prev + 1;
            callCounts.set(key, count);

            // Poisoning threshold: too many identical calls (total, not consecutive)
            if (count >= MAX_REPEATED_TOOL_CALLS + LOOP_TOLERANCE) {
                guardLog.error(
                    `${agentId}: tool "${toolName}" called ${count} times with identical args (total) ` +
                    `(${totalCalls}/${MAX_TOTAL_CALLS} total calls) — poisoning all tools`,
                );
                poisoned = true;
                return POISON_MSG;
            }

            // Warning threshold: return cached result or error, do not re-execute
            if (count >= MAX_REPEATED_TOOL_CALLS) {
                const cached = resultCache.get(key);

                if (cached !== undefined) {
                    guardLog.warn(
                        `${agentId}: tool "${toolName}" called ${count} times with identical args (total) ` +
                        `(${totalCalls}/${MAX_TOTAL_CALLS} total calls) — returning cached result`,
                    );
                    return `[CACHED — identical to your earlier call. Do not call this again.]\n${cached}`;
                }

                guardLog.warn(
                    `${agentId}: tool "${toolName}" called ${count} times with identical args (total) ` +
                    `(${totalCalls}/${MAX_TOTAL_CALLS} total calls) — breaking loop`,
                );
                return JSON.stringify({
                    error: `Tool "${toolName}" has been called ${count} times with the same arguments. ` +
                        'This indicates a loop. STOP calling tools and produce your final JSON response now. ' +
                        `Use the information you already have. Do NOT call any more tools. ` +
                        `You have ${MAX_TOTAL_CALLS - totalCalls} tool calls left.`,
                });
            }

            // Execute the tool
            const result = await originalTool.invoke(args);

            // Cache the result for read-only tools
            if (CACHEABLE_TOOL_NAMES.has(toolName)) {
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                resultCache.set(key, resultStr);
            }

            return result;
        };

        return tool(wrappedFn, {
            name: originalTool.name,
            description: originalTool.description,
            schema: (originalTool as any).schema,
        });
    });

    return {
        tools: wrappedTools,
        isCeilingReached: () => poisoned,
    };
}
