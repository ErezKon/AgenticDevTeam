/**
 * Per-run context — makes the system safe for concurrent runs in server mode.
 *
 * Uses Node.js `AsyncLocalStorage` so deeply nested functions can access
 * per-run state without parameter drilling. Module-level singletons serve
 * as fallback defaults when no context is active (backward-compatible CLI mode).
 *
 * Each singleton module (token-tracker, event-bus, run-budget, run-ledger,
 * response-log, logger, run-snapshot) checks `getRunContext()` and uses
 * the per-run instance if found, otherwise falls back to its module-level
 * default.
 *
 * Sub-Plan 25-14
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { EVENT_BUFFER_SIZE, EVENT_PRIORITY_BUFFER_SIZE } from '../config';

// ---- State classes (defined here to avoid circular imports) ----------------
// Each class mirrors the mutable module-level state in its corresponding
// singleton module. The singleton module accesses the active instance via
// getRunContext() ?? moduleDefault.

/** Per-run event bus state — mirrors event-bus.ts module-level variables. */
export class EventBusState {
    readonly emitter = new EventEmitter();
    buffer: Array<{ type: string; ts: string; payload: Record<string, unknown> }> = [];
    priorityBuffer: Array<{ type: string; ts: string; payload: Record<string, unknown> }> = [];
    bufferSize: number;
    priorityBufferSize: number;

    constructor() {
        this.emitter.setMaxListeners(50);
        this.bufferSize = EVENT_BUFFER_SIZE;
        this.priorityBufferSize = EVENT_PRIORITY_BUFFER_SIZE;
    }
}

/** Per-run budget state — mirrors run-budget.ts module-level variables. */
export class RunBudgetState {
    runStartMs = Date.now();
    lastLoggedLevel: string = 'ok'; // BudgetLevel
    pausedMs = 0;
}

/** Per-run ledger state — mirrors run-ledger.ts module-level variable. */
export class RunLedgerState {
    outputPath: string | null = null;
}

/** Per-run response-log state — mirrors response-log.ts module-level variables. */
export class ResponseLogState {
    dir: string | null = null;
    seq = 0;
    readonly systemPromptSeen = new Map<string, string>();
}

/** Per-run logger state — mirrors logger.ts module-level variable. */
export class LoggerState {
    runLogPath: string | null = null;
}

/** Per-run snapshot debounce state — mirrors run-snapshot.ts module-level variables. */
export class RunSnapshotState {
    lastSnapshotWrittenAt = 0;
    snapshotTimer: ReturnType<typeof setTimeout> | null = null;
}

/** Cumulative compaction stats shape — mirrors history-compactor.ts accumulator. */
export interface CompactionStatsAccumulator {
    invocations: number;
    totalOriginal: number;
    totalCompacted: number;
    toolStubs: number;
    writeStubs: number;
}

// ---- RunContext ------------------------------------------------------------

/**
 * Holds all per-run mutable state that was previously stored in module-level
 * singletons. One instance per concurrent run.
 */
export class RunContext {
    readonly id: string;

    /**
     * Per-run TokenTracker instance. Typed as `any` to avoid circular import
     * with token-tracker.ts — the actual type is enforced by the proxy there.
     * Lazily created by the tokenTracker proxy on first access.
     */
    tokenTracker: any = null;

    readonly eventBus = new EventBusState();
    readonly budget = new RunBudgetState();
    readonly ledger = new RunLedgerState();
    readonly responseLog = new ResponseLogState();
    readonly logger = new LoggerState();
    readonly snapshot = new RunSnapshotState();

    /** Per-run compaction memo (fixes history-compactor single-slot global). */
    readonly compactionMemo = new Map<string, string>();

    /** Per-run compaction stats accumulator. */
    readonly compactionStats: CompactionStatsAccumulator = {
        invocations: 0, totalOriginal: 0, totalCompacted: 0, toolStubs: 0, writeStubs: 0,
    };

    /** Per-run prompt-cache breakpoint-logged set (fixes unbounded growth). */
    readonly breakpointLoggedAgents = new Set<string>();

    /** Last known project state — updated at each phase entry for graceful shutdown (Plan 27-G). */
    lastKnownState: Record<string, any> | null = null;

    constructor(id: string) {
        this.id = id;
    }
}

// ---- AsyncLocalStorage API ------------------------------------------------

const _store = new AsyncLocalStorage<RunContext>();

/**
 * Get the active RunContext for the current async execution context.
 * Returns `undefined` when running outside a `runWithContext` scope
 * (e.g. CLI mode), causing singleton modules to fall back to their
 * module-level defaults.
 */
export function getRunContext(): RunContext | undefined {
    return _store.getStore();
}

/**
 * Execute `fn` within a RunContext scope. All code within `fn` (including
 * setTimeout/setInterval/Promise callbacks) will see `ctx` via `getRunContext()`.
 */
export function runWithContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
    return _store.run(ctx, fn);
}

/**
 * Update the last known state on the active RunContext (Plan 27-G).
 * Called by phaseNode at each phase entry so graceful shutdown can save it.
 */
export function setLastKnownState(state: Record<string, any>): void {
    const ctx = getRunContext();
    if (ctx) ctx.lastKnownState = state;
}
