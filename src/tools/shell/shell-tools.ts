/**
 * Host-mode command-execution tool.
 *
 * Commands run directly on the host — `bash -o pipefail -c <command>`, or
 * `child_process.exec` where there is no bash — scoped to the generated project
 * workspace directory.  There is NO Docker sandbox; the environment is the safe
 * allowlist plus non-interactive settings, never API keys.
 *
 * Guards:
 *  - A denylist rejects obviously destructive or dangerous patterns before
 *    anything runs (see `isDeniedCommand`).
 *  - Timeout is clamped to SHELL_MAX_TIMEOUT_S (default 900 s / 15 min).
 *  - Gated on SHELL_ALLOW_HOST=true (default true).
 *
 * Plan 30-07: output is rendered the way a terminal shows it, long test/build
 * output is cut to its failures and summary lines, and pipelines keep the exit
 * code of the command that failed.
 *
 * Future work (Option B): run commands inside a throw-away Docker container
 * with the workspace bind-mounted and no network by default.
 */
import * as fs from 'fs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LogColors, color256 } from '../../utils/log-colors.util';
import { logToolAction } from '../../utils/logger';
import { execCapture, execFileCapture, safeChildEnv, NON_INTERACTIVE_ENV, type CaptureResult } from '../../utils/shell-exec';
import { renderTerminalOutput, summariseTestOutput } from '../../utils/terminal-output';
import {
    GIT_USER_NAME, GIT_USER_EMAIL,
    SHELL_ALLOW_HOST, SHELL_DEFAULT_TIMEOUT_S, SHELL_MAX_TIMEOUT_S,
    MAX_TOOL_RESULT_CHARS,
} from '../../config';
import { truncateToolResult } from '../_shared/truncate';

const TAG = `${color256(166)}[shell]${LogColors.RESET}`;

// ─── Denylist ────────────────────────────────────────────────────────────────

interface DenyResult {
    denied: boolean;
    reason?: string;
}

/** Patterns that should never be executed on the host. */
const DENY_PATTERNS: { pattern: RegExp; reason: string }[] = [
    { pattern: /\brm\s+(-\w*r\w*\s+)?(-\w*f\w*\s+)?\/(\s|$)/,          reason: 'rm targeting root filesystem' },
    { pattern: /\brm\s+(-\w*r\w*\s+)?(-\w*f\w*\s+)?~(\/|\s|$)/,        reason: 'rm targeting home directory' },
    { pattern: /:\(\)\s*\{/,                                              reason: 'fork bomb' },
    { pattern: /\bmkfs\b/,                                                reason: 'mkfs — filesystem formatting' },
    { pattern: /\bshutdown\b/,                                            reason: 'system shutdown' },
    { pattern: /\breboot\b/,                                              reason: 'system reboot' },
    { pattern: /\bsudo\b/,                                                reason: 'privilege escalation via sudo' },
    { pattern: /\bcurl\b.*\|\s*(ba)?sh/,                                  reason: 'piping remote script to shell' },
    { pattern: /\bwget\b.*\|\s*(ba)?sh/,                                  reason: 'piping remote script to shell' },
    { pattern: /\bgit\s+push\s+(-\w*f\w*|--force)\b/,                    reason: 'force-push' },
    { pattern: /\bchmod\s+(-\w*R\w*\s+)?777\s+\//,                       reason: 'chmod 777 on root paths' },
    { pattern: />\s*\/dev\/sd/,                                            reason: 'writing to block device' },
    // ── Gate Integrity (Sub-Plan 02): prevent config tampering via shell ──
    { pattern: /\bnpm\s+pkg\s+set\s+scripts\./,                           reason: 'modifying package.json scripts via npm pkg set' },
    { pattern: /\bnpm\s+pkg\s+delete\s+scripts\./,                        reason: 'deleting package.json scripts via npm pkg delete' },
    { pattern: /\bgit\s+checkout\s+--\s+.*package\.json/,                  reason: 'reverting package.json via git checkout' },
    { pattern: /\bgit\s+restore\s+.*package\.json/,                        reason: 'reverting package.json via git restore' },
    { pattern: /\bsed\s+-i\b.*package\.json/,                              reason: 'modifying package.json via sed -i' },
    { pattern: /\bperl\s+-pi\b.*package\.json/,                            reason: 'modifying package.json via perl -pi' },
    { pattern: />\s*package\.json/,                                         reason: 'overwriting package.json via shell redirect' },
    { pattern: /\btruncate\b.*package\.json/,                               reason: 'truncating package.json' },
    { pattern: /\brm\b.*\.(?:test|spec)\.[jt]sx?/,                         reason: 'deleting a test file' },
];

/**
 * Check whether a command matches the denylist.
 *
 * @returns `{ denied: false }` when the command is allowed, or
 *          `{ denied: true, reason }` with a human-readable explanation.
 */
export function isDeniedCommand(cmd: string): DenyResult {
    const trimmed = cmd.trim();
    for (const { pattern, reason } of DENY_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { denied: true, reason: `Blocked: ${reason}` };
        }
    }
    return { denied: false };
}

// ─── Shell execution ─────────────────────────────────────────────────────────

/**
 * Environment of an agent command: the safe allowlist (never API keys — the scripts
 * are LLM-authored), CI / no-colour / no-prompt settings (Plan 30-07; the host's
 * NODE_ENV is no longer passed through, so a production host cannot make
 * `npm install` skip devDependencies), and the commit identity.
 */
function shellEnv(): NodeJS.ProcessEnv {
    return safeChildEnv({
        ...NON_INTERACTIVE_ENV,
        GIT_AUTHOR_NAME: GIT_USER_NAME, GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
        GIT_COMMITTER_NAME: GIT_USER_NAME, GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
    });
}

const BASH_PATHS = ['/bin/bash', '/usr/bin/bash'];
let resolvedBash: string | null | undefined;

/** The host's bash (commands run with pipefail), or null on Windows / a bash-less image (then `/bin/sh`). */
function bashPath(): string | null {
    if (resolvedBash === undefined) {
        resolvedBash = process.platform === 'win32' ? null : (BASH_PATHS.find(p => fs.existsSync(p)) ?? null);
    }
    return resolvedBash;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<CaptureResult> {
    const options = { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5, env: shellEnv() };
    // Plan 30-07: with pipefail `npm test | tail -20` reports the tests' exit code, not tail's 0
    const bash = bashPath();
    return bash ? execFileCapture(bash, ['-o', 'pipefail', '-c', command], options) : execCapture(command, options);
}

/** Test, build and lint runs: long output is cut to failures and summary lines (Plan 30-07). */
const TEST_RUN_RE = /\b(?:test|tests|jest|vitest|mocha|karma|pytest|playwright|e2e|tsc|build|lint)\b/;
/** …unless the command only reads files (`cat src/app.test.ts` is a file, not a test run). */
const READ_COMMAND_RE = /^\s*(?:cat|head|tail|sed|less|more|grep|rg|find|ls|tree|wc|git)\b/;

/**
 * What the model sees of a finished command (Plan 30-07): the exit code, then each
 * stream rendered as a terminal shows it — the 16 kB of Karma progress redraws of the
 * claudeopus5 run render to ~1.3 kB. A long test/build stream is cut to its failure
 * blocks and summary lines; anything still too long keeps its head and (mostly) tail.
 */
function formatShellResult(command: string, result: CaptureResult): string {
    const header = `Exit code: ${result.exitCode}`;
    const streams = ([['stdout', result.stdout], ['stderr', result.stderr]] as const)
        .map(([label, text]) => ({ label, text: renderTerminalOutput(text) }))
        .filter(s => s.text.length > 0);
    const summarise = TEST_RUN_RE.test(command) && !READ_COMMAND_RE.test(command);
    const budget = Math.floor((MAX_TOOL_RESULT_CHARS - header.length) / Math.max(1, streams.length)) - 20;
    const body = streams.map(s => `${s.label}:\n${summarise ? summariseTestOutput(s.text, budget) : s.text}`);
    // Tail-weighted split (headRatio=0.2): build/test failures print at the end
    return truncateToolResult([header, ...body].join('\n\n'), 'run_command', MAX_TOOL_RESULT_CHARS, 0.2);
}

// One-time startup warning so the risk is visible in logs
let hostWarningLogged = false;

/**
 * Create the shell execution tool bound to a workspace.
 */
export function createShellTool(workspaceRoot: string) {
    // Log a one-time warning naming the workspace root
    if (!hostWarningLogged) {
        logToolAction(`${TAG} WARN: Shell commands run directly on the host in: ${workspaceRoot}`);
        hostWarningLogged = true;
    }

    return tool(
        async ({ command, timeoutSeconds }) => {
            // Gate: SHELL_ALLOW_HOST must be true
            if (!SHELL_ALLOW_HOST) {
                return 'Error: Host shell execution is disabled (SHELL_ALLOW_HOST=false). Set SHELL_ALLOW_HOST=true to enable.';
            }

            // Denylist check
            const denyCheck = isDeniedCommand(command);
            if (denyCheck.denied) {
                logToolAction(`${TAG} DENIED: ${command} — ${denyCheck.reason}`);
                return `Error: Command denied — ${denyCheck.reason}. This command is blocked for safety.`;
            }

            // Clamp timeout to [1, SHELL_MAX_TIMEOUT_S]
            const effectiveTimeout = Math.min(
                Math.max(timeoutSeconds ?? SHELL_DEFAULT_TIMEOUT_S, 1),
                SHELL_MAX_TIMEOUT_S,
            );
            const timeoutMs = effectiveTimeout * 1000;

            logToolAction(`${TAG} Executing: ${command} (timeout=${effectiveTimeout}s)`);
            const result = await runShell(command, workspaceRoot, timeoutMs);
            logToolAction(`${TAG} Completed with exit code ${result.exitCode}`);
            return formatShellResult(command, result);
        },
        {
            name: 'run_command',
            description: 'Execute a shell command in the project workspace root (builds, tests, installs). '
                + (bashPath()
                    ? 'Commands run in bash with pipefail: a pipeline fails when any command in it fails, so `npm test | tail -20` reports the tests\' exit code. '
                    : 'Commands run in /bin/sh: a pipeline reports the exit code of its last command. ')
                + 'Output is shown as a terminal would show it; long test or build output is cut to its failures and summary lines.',
            schema: z.object({
                command: z.string().describe('Shell command to execute'),
                timeoutSeconds: z.number().optional().describe('Timeout in seconds (default: 60, max: 900)'),
            }),
        }
    );
}

/** Reset the one-time host warning flag (for testing). */
export function _resetHostWarning(): void {
    hostWarningLogged = false;
}
