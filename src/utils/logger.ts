import * as fs from 'fs';
import * as path from 'path';
import { color256, LogColors } from './log-colors.util';

/**
 * Per-agent tagged, colored logger.
 * Logs to console (with ANSI colors) and appends to a run log file (plain text).
 */
export interface AgentLogger {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug: (message: string) => void;
}

/** Strip ANSI escape codes for plain-text log files. */
function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Active run log path — set once per run via `setRunLogPath`. */
let runLogPath: string | null = null;

/** Set the log file path for the current run. */
export function setRunLogPath(logPath: string): void {
    runLogPath = logPath;
    // Ensure the directory exists
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });
}

/** Append a line to the run log file (plain text, no ANSI). */
function appendToRunLog(line: string): void {
    if (!runLogPath) return;
    try {
        fs.appendFileSync(runLogPath, stripAnsi(line) + '\n', 'utf-8');
    } catch {
        // Best-effort — don't crash on log write failure.
    }
}

/**
 * Create a logger for a specific agent.
 *
 * @param tag   Display tag, e.g. "[Architect]"
 * @param colorCode  256-color code for the tag
 */
export function getLogger(tag: string, colorCode: number): AgentLogger {
    const coloredTag = `${color256(colorCode)}${tag}${LogColors.RESET}`;

    const log = (level: string, message: string) => {
        const timestamp = new Date().toISOString();
        const line = `${timestamp} ${coloredTag} ${level} ${message}`;
        console.log(line);
        appendToRunLog(`${timestamp} ${tag} ${level} ${message}`);
    };

    return {
        info: (msg) => log('INFO', msg),
        warn: (msg) => log('WARN', msg),
        error: (msg) => log('ERROR', msg),
        debug: (msg) => log('DEBUG', msg),
    };
}
