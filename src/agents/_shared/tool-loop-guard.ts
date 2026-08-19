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
 *
 * Plan 22 (A1–A4) — parallel-tool-call models:
 * - Anthropic models emit up to 11 tool calls in a SINGLE turn.  A ceiling
 *   denominated in tool *calls* therefore gives Claude 5 turns where it gives
 *   an OpenAI model 26.  A separate `maxTurns` ceiling makes budget behaviour
 *   identical regardless of parallel fan-out (A2).
 * - Budget pressure is surfaced on every tool result once usage crosses 60%,
 *   so the agent can plan its landing instead of crashing into the ceiling (A3).
 * - `isTerminationDemanded()` lets the agent factory strip tools from the next
 *   model call, ending the post-exhaustion spin (A4).
 */
import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { getLogger } from '../../utils/logger';
import { MAX_TURN_TOOL_RESULT_CHARS, SHELL_READ_MAX_FILES } from '../../config';
import {
    branchReadCacheHit,
    branchReadCacheStore,
    branchReadCacheInvalidate,
    branchReadCacheInvalidateFile,
} from './branch-read-cache';

const guardLog = getLogger('[loop-guard]', 226);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Total identical (tool, args) invocations allowed before blocking THAT tool. */
const MAX_REPEATED_TOOL_CALLS = 2;   // 1st call runs, 2nd returns cached/warns

/** Extra identical attempts tolerated after the warning before blocking. */
const LOOP_TOLERANCE = 1;

/** Fraction of any budget above which a soft-pressure footer is appended. */
const PRESSURE_WARN_RATIO = 0.6;

/** Fraction of any budget above which the footer escalates to CRITICAL. */
const PRESSURE_CRITICAL_RATIO = 0.85;

/**
 * Calls arriving within this window of the first call of a batch are treated as
 * belonging to the same model turn.  Only used when the framework does not
 * expose a turn identifier (see `turnKeyFromConfig`).
 */
const TURN_BATCH_WINDOW_MS = 250;

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

// ─── Shell read detection (Plan 24, C5) ─────────────────────────────────────

/**
 * Regex patterns for shell commands that are pure reads.
 * These commands only read files and should be classified as 'read' for
 * budget purposes, not 'shell'.
 */
const SHELL_READ_PATTERNS: RegExp[] = [
    /^\s*cat\b/,
    /^\s*head\b/,
    /^\s*tail\b/,
    /^\s*sed\s+-n\b/,
    /^\s*less\b/,
    /^\s*find\b.*-name\b/,
];

/**
 * Returns true if a `run_command` command string is a pure read (cat, head,
 * tail, sed -n, less, find ... -name).
 */
function isShellReadCommand(command: string): boolean {
    // Handle pipes: check each segment; ALL must be reads
    const segments = command.split(/\|/).map(s => s.trim());
    return segments.every(seg => SHELL_READ_PATTERNS.some(p => p.test(seg)));
}

/**
 * Count distinct files touched by cat/head chains in a command.
 * Returns the number of file arguments.
 */
function countShellReadFiles(command: string): number {
    // Extract non-flag arguments from cat/head/tail commands
    const files = new Set<string>();
    const segments = command.split(/[|;]/).map(s => s.trim());
    for (const seg of segments) {
        const match = seg.match(/^\s*(cat|head|tail)\s+(.+)$/);
        if (!match) continue;
        const args = match[2].split(/\s+/).filter(a => !a.startsWith('-') && a.length > 0);
        for (const a of args) files.add(a);
    }
    return files.size;
}

/**
 * Normalise a shell read command for caching — strips whitespace variations.
 */
function normaliseShellReadCommand(command: string): string {
    return command.replace(/\s+/g, ' ').trim();
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown by `assertNotExhausted()` — never from inside a tool, because
 * LangGraph's ToolNode converts tool errors into ToolMessages and the loop
 * would continue regardless.  Callers use `isTerminationDemanded()` instead.
 */
export class ToolBudgetExhaustedError extends Error {
    constructor(agentId: string, public readonly usage: BudgetUsage) {
        super(`Agent "${agentId}" exhausted its tool budget (${describeUsage(usage)})`);
        this.name = 'ToolBudgetExhaustedError';
    }
}

// ─── Per-rank budget defaults ───────────────────────────────────────────────

export interface ToolBudgets {
    reads: number;
    writes: number;
    shell: number;
    /** Max model turns (Plan 22 A2). Optional for backward compatibility. */
    turns?: number;
}

/**
 * Plan 22 A1: retuned for models that batch tool calls.
 * Plan 27-C: raised aggressively — turns were the binding constraint in 100%
 * of 40+ budget exhaustion events. Claude batches 9-11 tool calls per turn,
 * so 35 turns ≈ 350 tool calls. The old 20 turns = ~200 tool calls was barely
 * enough for read→plan→write→test on a 5-file assignment.
 *
 * Reads are the cheap, batched category and were the binding constraint in the
 * pacmanclaude run (28 reads / 1 write in a 26-call flat ceiling).  Writes are
 * what the pipeline actually needs to survive, so they get their own pool that
 * reconnaissance can no longer drain.  `turns` is the real cost driver.
 */
const DEFAULT_BUDGETS: Record<string, Required<ToolBudgets>> = {
    principal: { reads: 80, writes: 40, shell: 20, turns: 45 },
    senior:    { reads: 70, writes: 35, shell: 18, turns: 40 },
    junior:    { reads: 60, writes: 30, shell: 16, turns: 35 },
    default:   { reads: 70, writes: 35, shell: 18, turns: 40 },
};

/**
 * Plan 26, B4: complexity multipliers for budget scaling.
 * Plan 27-C: removed the 0.75x penalty for trivial/simple — the TL's complexity
 * estimates are unreliable, and a "simple" assignment still needs turns for reading
 * context, writing code, running tests, and fixing issues. The 0.75x multiplier
 * cut junior turns from 20→15 in Plan 26, which was catastrophically low.
 *
 * Complex/very-complex get proportionally more so the agent can finish without
 * exhausting its budget and requiring a costly respawn.
 */
export const COMPLEXITY_MULTIPLIERS: Record<string, number> = {
    'trivial': 1.0,
    'simple': 1.0,
    'moderate': 1.0,
    'complex': 1.5,
    'very-complex': 2.0,
};

/**
 * Resolve per-rank budgets, with optional JSON override from config and
 * optional complexity scaling (Plan 26, B4).
 *
 * The override may specify a subset of fields; missing fields fall back to the
 * built-in defaults for that rank so a partial override cannot accidentally
 * zero out a category.
 *
 * When `complexity` is provided, `turns` and `writes` are scaled by the
 * corresponding multiplier. Reads and shell stay at base — they are rarely
 * the binding constraint.
 */
export function resolveToolBudgets(rank: string, jsonOverride?: string, complexity?: string): Required<ToolBudgets> {
    const base = DEFAULT_BUDGETS[rank] ?? DEFAULT_BUDGETS.default;
    let resolved = { ...base };
    if (jsonOverride) {
        try {
            const parsed = JSON.parse(jsonOverride);
            const entry = parsed?.[rank];
            if (entry && typeof entry === 'object') resolved = { ...resolved, ...entry };
        } catch {
            guardLog.warn(`TOOL_BUDGETS_JSON is not valid JSON — using defaults for rank "${rank}"`);
        }
    }

    // Plan 26, B4: apply complexity scaling to turns and writes
    const multiplier = COMPLEXITY_MULTIPLIERS[complexity ?? 'moderate'] ?? 1.0;
    if (multiplier !== 1.0) {
        resolved.turns = Math.round(resolved.turns * multiplier);
        resolved.writes = Math.round(resolved.writes * multiplier);
        // reads and shell stay at base — they're rarely the bottleneck
    }

    return resolved;
}

// ─── Guard implementation ───────────────────────────────────────────────────

export interface BudgetUsage {
    reads: number; maxReads: number;
    writes: number; maxWrites: number;
    shell: number; maxShell: number;
    turns: number; maxTurns: number;
    total: number;
}

function describeUsage(u: BudgetUsage): string {
    return `reads ${u.reads}/${fmt(u.maxReads)}, writes ${u.writes}/${fmt(u.maxWrites)}, `
        + `shell ${u.shell}/${fmt(u.maxShell)}, turns ${u.turns}/${fmt(u.maxTurns)}`;
}

function fmt(n: number): string {
    return Number.isFinite(n) ? String(n) : '∞';
}

export interface LoopGuardOptions {
    /** Per-category budgets (reads / writes / shell / turns). */
    budgets?: ToolBudgets;
    /** Legacy total-calls ceiling (used when budgets is not provided). */
    maxTotalCalls?: number;
    /** Progress bonus calls when agent has produced writes. */
    progressBonus?: number;
    /** Absolute hard ceiling for all calls combined. */
    hardCeiling?: number;
    /** Model turns allowed. Overrides `budgets.turns` when set. */
    maxTurns?: number;
    /** Terminal-guidance responses tolerated before termination is demanded. */
    maxPostExhaustionCalls?: number;
}

/**
 * Result of wrapping tools with a loop-detection guard.
 */
export interface LoopGuardResult {
    /** Guarded tools with loop-detection wrappers. */
    tools: StructuredToolInterface[];
    /** Returns true once the guard has exhausted all budgets or hit the hard ceiling. */
    isCeilingReached: () => boolean;
    /**
     * True once the agent has been told the budget is gone `maxPostExhaustionCalls`
     * times and is still calling tools.  The agent factory strips tools from the
     * next model call so the ReAct loop must terminate (Plan 22 A4).
     */
    isTerminationDemanded: () => boolean;
    /** Current budget usage — used for handoff summaries and diagnostics. */
    getUsage: () => BudgetUsage;
    /** Throws `ToolBudgetExhaustedError` when the ceiling has been reached. */
    assertNotExhausted: () => void;
}

/**
 * Wrap tools with a loop-detection guard.
 *
 * Key properties:
 * 1. Repeated identical calls block ONLY the offending tool, not all tools.
 * 2. Read/write/shell budgets are separate — exhausting reads cannot block writes.
 * 3. Cached responses are free — they do not increment any budget counter.
 * 4. Progress bonus: recent successful writes grant extra read budget.
 * 5. A model turn costs 1 turn regardless of how many tools it calls in parallel.
 * 6. Budget pressure is reported before it becomes terminal.
 */
export function withLoopGuard(
    tools: StructuredToolInterface[],
    agentId: string,
    opts?: number | LoopGuardOptions,
): LoopGuardResult {
    const noop: LoopGuardResult = {
        tools,
        isCeilingReached: () => false,
        isTerminationDemanded: () => false,
        getUsage: () => emptyUsage(),
        assertNotExhausted: () => { /* nothing to assert */ },
    };
    if (tools.length === 0) return noop;

    // Parse options: legacy number = maxTotalCalls, object = full options
    const options: LoopGuardOptions = typeof opts === 'number'
        ? { maxTotalCalls: opts }
        : (opts ?? {});

    const budgets = options.budgets ?? null;
    const progressBonus = options.progressBonus ?? 10;
    const hardCeiling = options.hardCeiling ?? 140;
    const maxPostExhaustionCalls = options.maxPostExhaustionCalls ?? 2;

    // ── Per-category counters ────────────────────────────────────────────
    let readCalls = 0;
    let writeCalls = 0;
    let shellCalls = 0;
    let totalCalls = 0;

    // ── Turn tracking (Plan 22 A2) ───────────────────────────────────────
    let turns = 0;
    let lastTurnKey: string | null = null;
    let lastTurnAt = 0;

    // ── Per-turn aggregate tool-result budget (Plan 24, C4) ──────────────
    /** Accumulated result chars in the current turn, per turn key. */
    const turnResultChars = new Map<string, number>();
    let turnResultsShrunkLogged = false;

    // Legacy mode: if no budgets, use maxTotalCalls as a flat ceiling
    const legacyMaxCalls = budgets ? null : (options.maxTotalCalls ?? 22);

    // Max budget per category (mutable — progress bonus can extend reads)
    let maxReads = budgets?.reads ?? Infinity;
    let maxWrites = budgets?.writes ?? Infinity;
    let maxShell = budgets?.shell ?? Infinity;
    // Plan 27-C: mutable — progress bonus can extend turns (the real bottleneck)
    let maxTurns = options.maxTurns ?? budgets?.turns ?? Infinity;

    // ── Loop detection state ─────────────────────────────────────────────
    const callCounts = new Map<string, number>();
    const resultCache = new Map<string, string>();
    const blockedKeys = new Set<string>();   // per-(tool,args) blocks
    let allExhausted = false;
    let postExhaustionCalls = 0;
    let recentWriteCount = 0;       // writes in the last N calls (progress tracking)
    let bonusGranted = 0;           // total bonus already granted

    function emptyUsage(): BudgetUsage {
        return {
            reads: 0, maxReads: Infinity, writes: 0, maxWrites: Infinity,
            shell: 0, maxShell: Infinity, turns: 0, maxTurns: Infinity, total: 0,
        };
    }

    function usage(): BudgetUsage {
        return {
            reads: readCalls, maxReads,
            writes: writeCalls, maxWrites,
            shell: shellCalls, maxShell,
            turns, maxTurns,
            total: totalCalls,
        };
    }

    function isExhausted(): boolean {
        if (allExhausted) return true;
        if (totalCalls >= hardCeiling) return true;
        if (turns >= maxTurns) return true;
        if (legacyMaxCalls !== null && totalCalls >= legacyMaxCalls) return true;
        // All categories exhausted (only when budgets are set)
        if (budgets && readCalls >= maxReads && writeCalls >= maxWrites && shellCalls >= maxShell) return true;
        return false;
    }

    /**
     * Register the model turn this call belongs to and return a stable
     * turn key for per-turn budget tracking (Plan 24, C4).
     *
     * LangGraph exposes a per-step identifier in `config.metadata.langgraph_step`;
     * one ToolNode execution == one model turn, so it is an exact turn key.  When
     * absent (direct `.invoke()` in tests, or a framework change) we fall back to
     * time-window batching: parallel calls from one turn all arrive within a few
     * milliseconds of each other.
     */
    function registerTurn(config: unknown): string {
        const key = turnKeyFromConfig(config);
        const now = Date.now();
        if (key !== null) {
            if (key !== lastTurnKey) { turns++; lastTurnKey = key; lastTurnAt = now; }
            return key;
        }
        if (lastTurnAt === 0 || now - lastTurnAt > TURN_BATCH_WINDOW_MS) {
            turns++;
            lastTurnKey = `time:${now}`;
        }
        lastTurnAt = now;
        return lastTurnKey ?? `time:${now}`;
    }

    /** Soft-pressure footer appended to successful tool results (Plan 22 A3). */
    function pressureFooter(): string {
        if (!budgets) return '';
        const ratios = [
            maxReads === Infinity ? 0 : readCalls / maxReads,
            maxWrites === Infinity ? 0 : writeCalls / maxWrites,
            maxShell === Infinity ? 0 : shellCalls / maxShell,
            maxTurns === Infinity ? 0 : turns / maxTurns,
        ];
        const worst = Math.max(...ratios);
        if (worst < PRESSURE_WARN_RATIO) return '';
        const state = `reads ${readCalls}/${fmt(maxReads)}, writes ${writeCalls}/${fmt(maxWrites)}, `
            + `shell ${shellCalls}/${fmt(maxShell)}, turns ${turns}/${fmt(maxTurns)}`;
        return worst >= PRESSURE_CRITICAL_RATIO
            ? `\n\n[BUDGET CRITICAL: ${state} — write your remaining files and return your final JSON on the NEXT turn.]`
            : `\n\n[BUDGET: ${state} — stop exploring and start writing files.]`;
    }

    /** Append the footer to a string result; leave non-string results alone. */
    function withFooter(result: unknown): unknown {
        const footer = pressureFooter();
        if (!footer) return result;
        if (typeof result === 'string') return result + footer;
        return `${JSON.stringify(result)}${footer}`;
    }

    /**
     * Plan 24, C4: enforce per-turn aggregate tool-result budget.
     * If the accumulated result chars for this turn exceed MAX_TURN_TOOL_RESULT_CHARS,
     * proportionally shrink this result to fit, with a 1500-char floor.
     */
    const TURN_RESULT_FLOOR = 1500;
    function applyTurnResultBudget(result: unknown, turnKey: string): unknown {
        if (MAX_TURN_TOOL_RESULT_CHARS <= 0) return result;
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const resultLen = resultStr.length;

        const accumulated = turnResultChars.get(turnKey) ?? 0;
        const newTotal = accumulated + resultLen;
        turnResultChars.set(turnKey, newTotal);

        if (newTotal <= MAX_TURN_TOOL_RESULT_CHARS) return result;

        // Budget exceeded — shrink this result proportionally
        const remaining = Math.max(0, MAX_TURN_TOOL_RESULT_CHARS - accumulated);
        const allowedLen = Math.max(TURN_RESULT_FLOOR, remaining);
        if (allowedLen >= resultLen) return result;

        const truncated = resultStr.slice(0, allowedLen)
            + `\n[turn budget: result shrunk from ${resultLen} to ${allowedLen} chars]`;
        if (!turnResultsShrunkLogged) {
            turnResultsShrunkLogged = true;
            guardLog.info(`${agentId}: per-turn tool result budget exceeded — shrinking results`);
        }
        return truncated;
    }

    // ── Terminal guidance message ────────────────────────────────────────
    function exhaustedMessage(): string {
        return JSON.stringify({
            error: `BUDGET EXHAUSTED: Agent "${agentId}" has used all available tool calls `
                + `(${describeUsage(usage())}). `
                + 'Return your JSON output now, listing exactly the files you actually wrote. '
                + 'Do not claim files you did not write. '
                + 'Produce your final JSON response matching the response schema.',
        });
    }

    // Plan 24, C5: shell read command cache (keyed by normalised command)
    const shellReadCache = new Map<string, string>();

    const wrappedTools = tools.map((originalTool) => {
        const wrappedFn = async (args: Record<string, any>, config?: unknown) => {
            const toolName = originalTool.name;
            let category = classifyTool(toolName);
            const argSig = JSON.stringify(args);
            const key = `${toolName}::${argSig}`;

            // Plan 24, C6: extract read_file path for branch-scoped cache (checked post-exec)
            const readFilePath = toolName === 'read_file' ? (args.filePath ?? args.path ?? '') as string : '';

            // Plan 24, C5: reclassify pure-read shell commands as 'read'
            const commandStr = toolName === 'run_command' ? (args.command ?? args.cmd ?? '') as string : '';
            const isShellRead = toolName === 'run_command' && commandStr && isShellReadCommand(commandStr);
            if (isShellRead) {
                // Check file count limit
                const fileCount = countShellReadFiles(commandStr);
                if (fileCount > SHELL_READ_MAX_FILES) {
                    return JSON.stringify({
                        error: `This command reads ${fileCount} files (limit: ${SHELL_READ_MAX_FILES}). `
                            + 'Use read_file instead for individual files.',
                    });
                }
                category = 'read';

                // Return cached result if available
                const normCmd = normaliseShellReadCommand(commandStr);
                const cachedResult = shellReadCache.get(normCmd);
                if (cachedResult !== undefined) {
                    guardLog.debug(`${agentId}: shell read cache hit for "${normCmd.slice(0, 60)}"`);
                    return `[CACHED — identical to your earlier call. Do not call this again.]\n${cachedResult}`;
                }
            }

            const currentTurnKey = registerTurn(config);

            // Fast path: if all budgets exhausted, return terminal guidance
            if (isExhausted()) {
                if (!allExhausted) {
                    guardLog.error(
                        `${agentId}: all tool budgets exhausted (${describeUsage(usage())}) — returning terminal guidance`,
                    );
                    allExhausted = true;
                }
                postExhaustionCalls++;
                if (postExhaustionCalls === maxPostExhaustionCalls) {
                    guardLog.error(
                        `${agentId}: still calling tools after ${postExhaustionCalls} exhaustion notices — `
                        + 'demanding termination (tools will be withheld from the next model call)',
                    );
                }
                return exhaustedMessage();
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
                shellReadCache.clear(); // Plan 24, C5: clear shell read cache on mutation
                // Plan 24, C6: invalidate branch-scoped read cache for this worktree
                branchReadCacheInvalidate(agentId);
                // If a specific file is being mutated, also invalidate it precisely
                const mutatedFile = (args.filePath ?? args.path ?? '') as string;
                if (mutatedFile) branchReadCacheInvalidateFile(agentId, mutatedFile);
                if (ownCount > 0) callCounts.set(key, ownCount);
                // Track progress
                recentWriteCount++;
            }

            if (SHELL_TOOL_NAMES.has(toolName) && !isShellRead) {
                resultCache.clear();
                shellReadCache.clear(); // Plan 24, C5: mutating shell clears read cache
                branchReadCacheInvalidate(agentId); // Plan 24, C6: shell mutation clears branch cache
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
                // Progress bonus: if agent has written files recently, extend read AND turn budget
                // Plan 27-C: also extend turns by half the bonus (turns are the real bottleneck)
                if (recentWriteCount > 0 && bonusGranted < progressBonus) {
                    const bonus = Math.min(progressBonus - bonusGranted, progressBonus);
                    maxReads += bonus;
                    const turnBonus = Math.ceil(bonus / 2);
                    maxTurns += turnBonus;
                    bonusGranted += bonus;
                    recentWriteCount = 0;
                    guardLog.info(
                        `${agentId}: progress detected (writes) — granting ${bonus} bonus read calls `
                        + `and ${turnBonus} bonus turns (reads: ${maxReads}, turns: ${maxTurns})`,
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
                        return exhaustedMessage();
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
                return exhaustedMessage();
            }

            // Hard ceiling
            if (totalCalls >= hardCeiling) {
                guardLog.error(`${agentId}: hit hard ceiling of ${hardCeiling} total calls`);
                allExhausted = true;
                return exhaustedMessage();
            }

            // ── Increment category counter ───────────────────────────────
            if (category === 'read') readCalls++;
            else if (category === 'write') writeCalls++;
            else shellCalls++;

            // ── Execute the tool ─────────────────────────────────────────
            const result = await originalTool.invoke(args);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

            // Cache the result for read-only tools
            if (CACHEABLE_TOOL_NAMES.has(toolName)) {
                resultCache.set(key, resultStr);
            }

            // Plan 24, C5: cache shell read results by normalised command
            if (isShellRead) {
                const normCmd = normaliseShellReadCommand(commandStr);
                shellReadCache.set(normCmd, resultStr);
            }

            // Plan 24, C6: branch-scoped read cache for read_file (full reads only)
            // When content is unchanged since the last read, replace the bulky
            // result with a compact marker.  The read still counts against the
            // budget (the tool did execute), but the much-smaller response saves
            // input tokens on subsequent turns.
            if (toolName === 'read_file' && readFilePath && !args.offset && !args.limit) {
                if (branchReadCacheHit(agentId, readFilePath, resultStr)) {
                    guardLog.debug(`${agentId}: branch read cache hit for "${readFilePath}"`);
                    return withFooter('[CACHED — file unchanged since your last read. Do not re-read.]');
                }
                // Store in cache for future comparisons
                branchReadCacheStore(agentId, readFilePath, resultStr);
            }

            // Plan 24, C4: enforce per-turn aggregate tool-result budget
            const budgeted = applyTurnResultBudget(result, currentTurnKey);
            return withFooter(budgeted);
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
        isTerminationDemanded: () => postExhaustionCalls >= maxPostExhaustionCalls,
        getUsage: () => usage(),
        assertNotExhausted: () => {
            if (isExhausted()) throw new ToolBudgetExhaustedError(agentId, usage());
        },
    };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract a per-model-turn identifier from the RunnableConfig LangGraph passes
 * to a tool. Returns `null` when no usable key is present.
 */
function turnKeyFromConfig(config: unknown): string | null {
    if (!config || typeof config !== 'object') return null;
    const meta = (config as { metadata?: Record<string, unknown> }).metadata;
    const step = meta?.langgraph_step;
    if (typeof step === 'number' || typeof step === 'string') return `step:${step}`;
    // `runId` is per model/tool run; ToolNode shares one parent run per turn.
    const parent = (config as { parentRunId?: unknown }).parentRunId;
    if (typeof parent === 'string' && parent.length > 0) return `parent:${parent}`;
    return null;
}
