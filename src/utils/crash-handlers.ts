/**
 * Shared crash/exit handlers — used by both cli.ts and index.ts to flush
 * token reports on unexpected exits (SIGINT, SIGTERM, uncaught exceptions,
 * unhandled rejections).
 *
 * Extracted in Sub-Plan 26-09 to eliminate duplication between entry points.
 */
import { tokenTracker } from './token-tracker';
import { refreshTokenReport } from './token-report';

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

/**
 * Install the four standard process-exit handlers (SIGINT, SIGTERM,
 * uncaughtException, unhandledRejection) that flush the token report
 * before the process terminates.
 *
 * @param logFn  Logger for error messages (default: console.error)
 */
export function installProcessHandlers(
    logFn: (msg: string) => void = console.error,
): void {
    process.on('SIGINT', () => {
        flushTokenReportOnExit('SIGINT', logFn);
        process.exit(130);
    });
    process.on('SIGTERM', () => {
        flushTokenReportOnExit('SIGTERM', logFn);
        process.exit(143);
    });
    process.on('uncaughtException', (err) => {
        logFn(`Uncaught exception: ${err.message}`);
        flushTokenReportOnExit('uncaughtException', logFn);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        logFn(`Unhandled rejection: ${reason}`);
        flushTokenReportOnExit('unhandledRejection', logFn);
        process.exit(1);
    });
}
