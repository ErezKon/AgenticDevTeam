/**
 * Shared shell-execution helpers for gate modules.
 *
 * Consolidates the duplicated ExecFn type, safeChildEnv, defaultExec,
 * and isToolAvailable from quality-gates, security-gates, and test-runner.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Safe environment allowlist ─────────────────────────────────────────────

const SAFE_KEYS = [
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
    'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME',
    'PROGRAMFILES', 'SYSTEMROOT', 'WINDIR',
];

/**
 * Build a child-process environment from a safe allowlist.
 * Never leaks API keys, tokens, or secrets to child processes.
 */
export function safeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = {};
    for (const key of SAFE_KEYS) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return { ...env, ...extra };
}

// ─── ExecFn type and default implementation ─────────────────────────────────

/** Injectable exec seam used by quality-gates, security-gates, and test-runner. */
export type ExecFn = (cmd: string, opts: { cwd: string; timeout: number }) => string;

/**
 * Default exec via `execSync` — merges stderr into stdout.
 *
 * @param cmd       Shell command string.
 * @param opts.cwd  Working directory.
 * @param opts.timeout  Timeout in milliseconds.
 * @param maxBuffer     Max output buffer size in bytes (default 10 MB).
 * @param envExtras     Additional env vars merged into `safeChildEnv()`.
 */
export function defaultExec(
    cmd: string,
    opts: { cwd: string; timeout: number },
    maxBuffer: number = 10 * 1024 * 1024,
    envExtras: Record<string, string> = { CI: 'true' },
): string {
    return execSync(cmd + ' 2>&1', {
        cwd: opts.cwd,
        encoding: 'utf-8',
        timeout: opts.timeout,
        maxBuffer,
        env: safeChildEnv(envExtras),
    });
}

// ─── Tool availability check ────────────────────────────────────────────────

/**
 * Check whether a tool is available on PATH.
 *
 * Special-cases `./gradlew`: checks file existence instead of `which`.
 */
export function isToolAvailable(
    tool: string,
    cwd: string,
    exec: ExecFn = defaultExec,
): boolean {
    if (tool === './gradlew') {
        return fs.existsSync(path.join(cwd, 'gradlew'));
    }
    try {
        exec(`which ${tool}`, { cwd, timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}
