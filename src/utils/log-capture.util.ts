import * as fs from 'fs';
import * as path from 'path';

/**
 * Captures all stdout/stderr output during an agent run so it can be
 * saved to a log file in the output directory.
 *
 * Usage:
 *   const capture = startLogCapture();
 *   // ... agent work ...
 *   saveLogCapture(capture, outputDir);
 */
export interface LogCapture {
    /** Collected log lines. */
    lines: string[];
    /** Stop capturing and restore original streams. */
    stop: () => void;
}

export function startLogCapture(): LogCapture {
    const lines: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk: any, ...args: any[]): boolean => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        lines.push(text);
        return (origStdoutWrite as any)(chunk, ...args);
    };

    process.stderr.write = (chunk: any, ...args: any[]): boolean => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        lines.push(text);
        return (origStderrWrite as any)(chunk, ...args);
    };

    return {
        lines,
        stop() {
            process.stdout.write = origStdoutWrite;
            process.stderr.write = origStderrWrite;
        },
    };
}

/**
 * Strip ANSI escape codes so the saved log is readable in plain text.
 */
function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Write captured logs to `agent.log` inside the given output directory.
 * Safely stops the capture if it hasn't been stopped yet.
 */
export function saveLogCapture(capture: LogCapture, outputDir: string | null): void {
    capture.stop();
    if (!outputDir) return;
    try {
        const logPath = path.join(outputDir, 'agent.log');
        const content = stripAnsi(capture.lines.join(''));
        fs.writeFileSync(logPath, content, 'utf-8');
    } catch {
        // Best-effort — don't crash the request if log saving fails.
    }
}
