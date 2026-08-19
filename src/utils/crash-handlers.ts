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
import { getRunContext } from './run-context';

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

/** Registered shutdown hooks — called on graceful shutdown (SIGINT/SIGTERM). */
const _shutdownHooks: Array<() => void> = [];

/** Register a hook to run during graceful shutdown. */
export function onGracefulShutdown(hook: () => void): void {
    _shutdownHooks.push(hook);
}

/** Flag to prevent double-shutdown. */
let _shuttingDown = false;

/**
 * Graceful shutdown handler — runs all registered hooks, writes state snapshot
 * from RunContext, flushes ledger and token report, then exits.
 */
function gracefulShutdown(signal: string, logFn: (msg: string) => void): void {
    if (_shuttingDown) return;
    _shuttingDown = true;

    logFn(`\n${signal} received — performing graceful shutdown...`);

    // 1. Run registered shutdown hooks (state snapshot, ledger flush, etc.)
    for (const hook of _shutdownHooks) {
        try { hook(); } catch { /* best-effort */ }
    }

    // 2. Best-effort: save state from RunContext if available
    try {
        const ctx = getRunContext();
        if (ctx?.lastKnownState) {
            const outputPath = ctx.lastKnownState.outputPath as string | undefined;
            if (outputPath) {
                const stateWithStop = {
                    ...ctx.lastKnownState,
                    cancelled: true,
                    _stopReason: 'manual-kill',
                };
                writeStateSnapshot(outputPath, stateWithStop);
                logFn('State snapshot saved on shutdown.');
            }
        }
    } catch { /* best-effort */ }

    // 3. Write ledger entry recording the shutdown
    try {
        appendLedger({
            kind: 'invariant',
            id: 'graceful-shutdown',
            phase: 'development' as any,
            detail: `Process terminated by ${signal}`,
        });
    } catch { /* best-effort */ }

    // 4. Flush token report
    flushTokenReportOnExit(signal, logFn);

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
        gracefulShutdown('uncaughtException', logFn);
    });
    process.on('unhandledRejection', (reason) => {
        logFn(`Unhandled rejection: ${reason}`);
        gracefulShutdown('unhandledRejection', logFn);
    });
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset shutdown state — tests only. */
export function _resetShutdown(): void {
    _shuttingDown = false;
    _shutdownHooks.length = 0;
}
