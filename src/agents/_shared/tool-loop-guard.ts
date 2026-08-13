/**
 * Tool loop guard — detects and stops agents stuck in tool-call loops.
 *
 * Sub-Plan 08 rewrite:
 * - NEVER poison unrelated tools.  A repeated `list_dir` blocks only `list_dir`,
 *   not `write_file`.
 * - Separate read / write / shell ceilings so reconnaissance loops cannot
 *   prevent an agent from writing code.
 * - Progress bonus: agents that are producing real writes get extra budget.
 * - Cached responses are FREE — they do not consume any budget counter.
 * - Budget exhaustion injects a terminal guidance message instead of
 *   silently poisoning everything.
 */
import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { getLogger } from '../../utils/logger';

const guardLog = getLogger('[loop-guard]', 226);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Total identical (tool, args) invocations allowed before blocking THAT tool. */
const MAX_REPEATED_TOOL_CALLS = 2;   // 1st call runs, 2nd returns cached/warns

/** Extra identical attempts tolerated after the warning before blocking. */
const LOOP_TOLERANCE = 1;

// ─── Tool classification ────────────────────────────────────────────────────

/** Tool names that mutate the workspace (file writes, edits). */
const MUTATING_TOOL_NAMES = new Set([
    'write_file', 'edit_file', 'create_file', 'delete_file',
]);

/** Read-only tools whose results can be served from cache. */
const CACHEABLE_TOOL_NAMES = new Set([
    'read_file', 'list_dir', 'search_code',
    'git_diff_file', 'git_diff_stat', 'git_merge_base_diff', 'git_log', 'git_status',
]);

/** Shell execution tools. */
const SHELL_TOOL_NAMES = new Set(['run_command']);

type ToolCategory = 'read' | 'write' | 'shell';

function classifyTool(name: string): ToolCategory {
    if (MUTATING_TOOL_NAMES.has(name)) return 'write';
    if (SHELL_TOOL_NAMES.has(name)) return 'shell';
    return 'read';
}

// ─── Per-rank budget defaults ───────────────────────────────────────────────

export interface ToolBudgets {
    reads: number;
    writes: number;
    shell: number;
}

const DEFAULT_BUDGETS: Record<string, ToolBudgets> = {
    principal: { reads: 30, writes: 25, shell: 10 },
    senior:    { reads: 25, writes: 20, shell: 8 },
    junior:    { reads: 20, writes: 15, shell: 8 },
    default:   { reads: 25, writes: 20, shell: 8 },
};

/**
 * Resolve per-rank budgets, with optional JSON override from config.
 */
export function resolveToolBudgets(rank: string, jsonOverride?: string): ToolBudgets {
    if (jsonOverride) {
        try {
            const parsed = JSON.parse(jsonOverride);
            if (parsed[rank]) return parsed[rank];
        } catch { /* use defaults */ }
    }
    return DEFAULT_BUDGETS[rank] ?? DEFAULT_BUDGETS.default;
}

// ─── Guard implementation ───────────────────────────────────────────────────

export interface LoopGuardOptions {
    /** Per-category budgets (reads / writes / shell). */
    budgets?: ToolBudgets;
    /** Legacy total-calls ceiling (used when budgets is not provided). */
    maxTotalCalls?: number;
    /** Progress bonus calls when agent has produced writes. */
    progressBonus?: number;
    /** Absolute hard ceiling for all calls combined. */
    hardCeiling?: number;
}

/**
 * Result of wrapping tools with a loop-detection guard.
 */
export interface LoopGuardResult {
    /** Guarded tools with loop-detection wrappers. */
    tools: StructuredToolInterface[];
    /** Returns true once the guard has exhausted all budgets or hit the hard ceiling. */
    isCeilingReached: () => boolean;
}

/**
 * Wrap tools with a loop-detection guard.
 *
 * Key changes from the pre-Sub-Plan-08 implementation:
 * 1. Repeated identical calls block ONLY the offending tool, not all tools.
 * 2. Read/write/shell budgets are separate — exhausting reads cannot block writes.
 * 3. Cached responses are free — they do not increment any budget counter.
 * 4. Progress bonus: recent successful writes grant extra read budget.
 * 5. Terminal guidance message when budget is exhausted.
 */
export function withLoopGuard(
    tools: StructuredToolInterface[],
    agentId: string,
    opts?: number | LoopGuardOptions,
): LoopGuardResult {
    if (tools.length === 0) return { tools, isCeilingReached: () => false };

    // Parse options: legacy number = maxTotalCalls, object = full options
    const options: LoopGuardOptions = typeof opts === 'number'
        ? { maxTotalCalls: opts }
        : (opts ?? {});

    const budgets = options.budgets ?? null;
    const progressBonus = options.progressBonus ?? 10;
    const hardCeiling = options.hardCeiling ?? 80;

    // ── Per-category counters ────────────────────────────────────────────
    let readCalls = 0;
    let writeCalls = 0;
    let shellCalls = 0;
    let totalCalls = 0;

    // Legacy mode: if no budgets, use maxTotalCalls as a flat ceiling
    const legacyMaxCalls = budgets ? null : (options.maxTotalCalls ?? 22);

    // Max budget per category (mutable — progress bonus can extend reads)
    let maxReads = budgets?.reads ?? Infinity;
    let maxWrites = budgets?.writes ?? Infinity;
    let maxShell = budgets?.shell ?? Infinity;

    // ── Loop detection state ─────────────────────────────────────────────
    const callCounts = new Map<string, number>();
    const resultCache = new Map<string, string>();
    const blockedKeys = new Set<string>();   // per-(tool,args) blocks
    let allExhausted = false;
    let recentWriteCount = 0;       // writes in the last N calls (progress tracking)
    let bonusGranted = 0;           // total bonus already granted

    function isExhausted(): boolean {
        if (allExhausted) return true;
        if (totalCalls >= hardCeiling) return true;
        if (legacyMaxCalls !== null && totalCalls >= legacyMaxCalls) return true;
        // All categories exhausted (only when budgets are set)
        if (budgets && readCalls >= maxReads && writeCalls >= maxWrites && shellCalls >= maxShell) return true;
        return false;
    }

    // ── Terminal guidance message ────────────────────────────────────────
    const EXHAUSTED_MSG = JSON.stringify({
        error: `BUDGET EXHAUSTED: Agent "${agentId}" has used all available tool calls. ` +
            'Return your JSON output now, listing exactly the files you actually wrote. ' +
            'Do not claim files you did not write. ' +
            'Produce your final JSON response matching the response schema.',
    });

    const wrappedTools = tools.map((originalTool) => {
        const wrappedFn = async (args: Record<string, any>) => {
            const toolName = originalTool.name;
            const category = classifyTool(toolName);
            const argSig = JSON.stringify(args);
            const key = `${toolName}::${argSig}`;

            // Fast path: if all budgets exhausted, return terminal guidance
            if (isExhausted()) {
                if (!allExhausted) {
                    guardLog.error(`${agentId}: all tool budgets exhausted (total=${totalCalls}) — returning terminal guidance`);
                    allExhausted = true;
                }
                return EXHAUSTED_MSG;
            }

            // ── Per-(tool,args) block check ──────────────────────────────
            if (blockedKeys.has(key)) {
                // This specific (tool,args) is blocked — but other tools still work
                return JSON.stringify({
                    error: `[BLOCKED] You already called ${toolName}('${argSig.slice(0, 80)}') ${MAX_REPEATED_TOOL_CALLS + LOOP_TOLERANCE} times. ` +
                        'The answer is in your prompt\'s Workspace Snapshot or earlier results. ' +
                        'Use a DIFFERENT tool or produce your final JSON response.',
                });
            }

            // ── Mutation clears read caches ──────────────────────────────
            if (MUTATING_TOOL_NAMES.has(toolName)) {
                const ownCount = callCounts.get(key) ?? 0;
                callCounts.clear();
                resultCache.clear();
                if (ownCount > 0) callCounts.set(key, ownCount);
                // Track progress
                recentWriteCount++;
            }

            if (SHELL_TOOL_NAMES.has(toolName)) {
                resultCache.clear();
            }

            // ── Repeat detection ─────────────────────────────────────────
            const prev = callCounts.get(key) ?? 0;
            const count = prev + 1;
            callCounts.set(key, count);

            // Block threshold: block THIS (tool,args) only
            if (count >= MAX_REPEATED_TOOL_CALLS + LOOP_TOLERANCE) {
                guardLog.warn(
                    `${agentId}: tool "${toolName}" called ${count} times with identical args — blocking this call only`,
                );
                blockedKeys.add(key);
                return JSON.stringify({
                    error: `[BLOCKED] You already called ${toolName}('${argSig.slice(0, 80)}') ${count} times. ` +
                        'The answer is in your prompt\'s Workspace Snapshot or earlier results. ' +
                        'Use a DIFFERENT tool or produce your final JSON response.',
                });
            }

            // Warning threshold: return cached result (FREE — no budget consumed)
            if (count >= MAX_REPEATED_TOOL_CALLS) {
                const cached = resultCache.get(key);

                if (cached !== undefined) {
                    guardLog.warn(
                        `${agentId}: tool "${toolName}" called ${count} times with identical args — returning cached result (free)`,
                    );
                    // Cached responses are FREE — do not increment any counter
                    return `[CACHED — identical to your earlier call. Do not call this again.]\n${cached}`;
                }

                guardLog.warn(
                    `${agentId}: tool "${toolName}" called ${count} times with identical args — breaking loop`,
                );
                // Non-cacheable repeat — still don't count against budget
                return JSON.stringify({
                    error: `Tool "${toolName}" has been called ${count} times with the same arguments. ` +
                        'This indicates a loop. Use the information you already have.',
                });
            }

            // ── Budget check (per-category) ──────────────────────────────
            if (budgets) {
                // Progress bonus: if agent has written files recently, extend read budget
                if (recentWriteCount > 0 && bonusGranted < progressBonus) {
                    const bonus = Math.min(progressBonus - bonusGranted, progressBonus);
                    maxReads += bonus;
                    bonusGranted += bonus;
                    recentWriteCount = 0;
                    guardLog.info(
                        `${agentId}: progress detected (writes) — granting ${bonus} bonus read calls (total reads budget: ${maxReads})`,
                    );
                }

                const categoryExhausted =
                    (category === 'read' && readCalls >= maxReads) ||
                    (category === 'write' && writeCalls >= maxWrites) ||
                    (category === 'shell' && shellCalls >= maxShell);

                if (categoryExhausted) {
                    guardLog.warn(
                        `${agentId}: ${category} budget exhausted (reads=${readCalls}/${maxReads}, writes=${writeCalls}/${maxWrites}, shell=${shellCalls}/${maxShell})`,
                    );
                    // Check if ALL categories are now exhausted
                    if (readCalls >= maxReads && writeCalls >= maxWrites && shellCalls >= maxShell) {
                        allExhausted = true;
                        return EXHAUSTED_MSG;
                    }
                    return JSON.stringify({
                        error: `Your ${category} tool budget is exhausted (${category === 'read' ? readCalls : category === 'write' ? writeCalls : shellCalls} calls used). ` +
                            `You can still use ${category === 'read' ? 'write and shell' : category === 'write' ? 'read and shell' : 'read and write'} tools. ` +
                            'If your work is complete, return your JSON output now.',
                    });
                }
            }

            // ── Legacy flat ceiling ──────────────────────────────────────
            totalCalls++;
            if (legacyMaxCalls !== null && totalCalls > legacyMaxCalls) {
                guardLog.error(
                    `${agentId}: exceeded ${legacyMaxCalls} total tool calls (${totalCalls}/${legacyMaxCalls})`,
                );
                allExhausted = true;
                return EXHAUSTED_MSG;
            }

            // Hard ceiling
            if (totalCalls >= hardCeiling) {
                guardLog.error(`${agentId}: hit hard ceiling of ${hardCeiling} total calls`);
                allExhausted = true;
                return EXHAUSTED_MSG;
            }

            // ── Increment category counter ───────────────────────────────
            if (category === 'read') readCalls++;
            else if (category === 'write') writeCalls++;
            else shellCalls++;

            // ── Execute the tool ─────────────────────────────────────────
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
        isCeilingReached: () => isExhausted(),
    };
}
