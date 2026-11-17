/**
 * Shared crash/exit handlers — used by both cli.ts and index.ts to flush
 * token reports on unexpected exits (SIGINT, SIGTERM, uncaught exceptions,
 * unhandled rejections).
 *
 * Extracted in Sub-Plan 25-09 to eliminate duplication between entry points.
 *
 * Plan 27-G: Enhanced with graceful shutdown support — SIGINT/SIGTERM now
 * run registered shutdown hooks (state snapshot, ledger flush) before exit,
 * enabling continue-run recovery after manual kill.
 */
import { tokenTracker } from './token-tracker';
import { refreshTokenReport } from './token-report';
import { writeStateSnapshot } from './run-snapshot';
import { appendLedger } from './run-ledger';
import { getRunContext, runWithContextSync, type RunContext } from './run-context';
import { trace, serializeError, writeDebugSummary } from './debug-trace';

/**
 * Best-effort flush of the token report.
 *
 * @param reason Human-readable label for why we're flushing (e.g. 'SIGINT')
 * @param logFn  Where to write the "saved" confirmation — defaults to console.error
 */
export function flushTokenReportOnExit(
    reason: string,
    logFn: (msg: string) => void = console.error,
): void {
    try {
        if (tokenTracker.getOutputPath()) {
            tokenTracker.setRunStatus('failed');
            refreshTokenReport();
            logFn(`Token report saved (${reason}).`);
        }
    } catch { /* best-effort */ }
}

// ─── Graceful shutdown hooks (Plan 27-G) ────────────────────────────────────

/**
 * Runs registered for graceful shutdown, each with the RunContext it was
 * registered from. Plan 30-F: signal handlers execute outside every
 * AsyncLocalStorage scope, so `getRunContext()` is always `undefined` there —
 * the context must be captured at registration and re-entered at shutdown.
 * Before this, SIGINT saved no state, no ledger entry and no token report.
 */
const _shutdownHooks: Array<{ hook?: () => void; ctx: RunContext | undefined }> = [];

/** Register a hook to run (inside the caller's RunContext) during graceful shutdown. */
export function onGracefulShutdown(hook: () => void): void {
    _shutdownHooks.push({ hook, ctx: getRunContext() });
}

/**
 * Register the active run so a graceful shutdown saves its last known state
 * (`cancelled` + `_stopReason`), a ledger entry and its token report.
 *
 * Returns a disposer — call it when the run ends. Plan 30-F left registrations in
 * place, so a Ctrl+C at the CLI menu AFTER a run finished overwrote that run's final
 * state with `manual-kill` (pacman-live-analysis-10, F27).
 */
export function registerRunShutdown(): () => void {
    const entry = { ctx: getRunContext() };
    _shutdownHooks.push(entry);
    return () => {
        const i = _shutdownHooks.indexOf(entry);
        if (i >= 0) _shutdownHooks.splice(i, 1);
    };
}

/** Flag to prevent double-shutdown. */
let _shuttingDown = false;

/** Persist one run's stop evidence. Must execute inside that run's context. */
function saveStoppedRun(signal: string, logFn: (msg: string) => void): void {
    const state = getRunContext()?.lastKnownState;
    const outputPath = state?.outputPath as string | undefined;
    if (state && outputPath) {
        const stopReason = signal === 'SIGINT' || signal === 'SIGTERM' ? 'manual-kill' : 'crashed';
        writeStateSnapshot(outputPath, { ...state, cancelled: true, _stopReason: stopReason });
        logFn(`State snapshot saved on shutdown (${outputPath}).`);
    }
    appendLedger({
        kind: 'invariant',
        id: 'graceful-shutdown',
        phase: (state?.phase ?? 'intake') as any,
        detail: `Process terminated by ${signal}`,
    });
    flushTokenReportOnExit(signal, logFn);
}

/**
 * Graceful shutdown handler — for every registered run (inside its own
 * RunContext) runs its hook, saves its state snapshot, ledger entry and token
 * report; then writes the debug summary and exits.
 */
export function gracefulShutdown(signal: string, logFn: (msg: string) => void): void {
    if (_shuttingDown) return;
    _shuttingDown = true;

    logFn(`\n${signal} received — performing graceful shutdown...`);
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
        trace({ kind: 'crash', event: 'signal', signal }, { processLevel: true });
    }

    for (const { hook, ctx } of _shutdownHooks) {
        const shutdownRun = () => {
            try { hook?.(); } catch { /* best-effort */ }
            try { saveStoppedRun(signal, logFn); } catch { /* best-effort */ }
        };
        if (ctx) runWithContextSync(ctx, shutdownRun);
        else shutdownRun();
    }
    if (_shutdownHooks.length === 0) flushTokenReportOnExit(signal, logFn);
    writeDebugSummary({ processLevel: true });

    logFn(`Graceful shutdown complete. Use 'continue-run' to resume.`);
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
}

/**
 * Install the four standard process-exit handlers (SIGINT, SIGTERM,
 * uncaughtException, unhandledRejection) that flush the token report
 * and run graceful shutdown hooks before the process terminates.
 *
 * @param logFn  Logger for error messages (default: console.error)
 */
export function installProcessHandlers(
    logFn: (msg: string) => void = console.error,
): void {
    process.on('SIGINT', () => gracefulShutdown('SIGINT', logFn));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', logFn));
    process.on('uncaughtException', (err) => {
        logFn(`Uncaught exception: ${err.message}`);
        trace({ kind: 'crash', event: 'uncaughtException', error: serializeError(err) }, { processLevel: true });
        gracefulShutdown('uncaughtException', logFn);
    });
    process.on('unhandledRejection', (reason) => {
        logFn(`Unhandled rejection: ${reason}`);
        trace({ kind: 'crash', event: 'unhandledRejection', error: serializeError(reason) }, { processLevel: true });
        gracefulShutdown('unhandledRejection', logFn);
    });
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset shutdown state — tests only. */
export function _resetShutdown(): void {
    _shuttingDown = false;
    _shutdownHooks.length = 0;
}
