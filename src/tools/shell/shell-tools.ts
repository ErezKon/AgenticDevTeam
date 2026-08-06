/**
 * Host-mode command-execution tool.
 *
 * Commands run directly on the host via `child_process.exec`, scoped to
 * the generated project workspace directory.  There is NO Docker sandbox
 * — the process inherits the full host environment.
 *
 * Guards:
 *  - A denylist rejects obviously destructive or dangerous patterns before
 *    `exec` is called (see `isDeniedCommand`).
 *  - Timeout is clamped to SHELL_MAX_TIMEOUT_S (default 900 s / 15 min).
 *  - Gated on SHELL_ALLOW_HOST=true (default true).
 *
 * Future work (Option B): run commands inside a throw-away Docker container
 * with the workspace bind-mounted and no network by default.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { LogColors, color256 } from '../../utils/log-colors.util';
import { logToolAction } from '../../utils/logger';
import {
    GIT_USER_NAME, GIT_USER_EMAIL,
    SHELL_ALLOW_HOST, SHELL_DEFAULT_TIMEOUT_S, SHELL_MAX_TIMEOUT_S,
} from '../../config';

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

interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
    return new Promise((resolve) => {
        const child = exec(command, {
            cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: GIT_USER_NAME, GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
                GIT_COMMITTER_NAME: GIT_USER_NAME, GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
            },
        }, (error, stdout, stderr) => {
            resolve({
                stdout: stdout?.toString() ?? '',
                stderr: stderr?.toString() ?? '',
                exitCode: error?.code ?? (error ? 1 : 0),
            });
        });
    });
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
            const output = [
                `Exit code: ${result.exitCode}`,
                result.stdout ? `stdout:\n${result.stdout.slice(0, 5000)}` : '',
                result.stderr ? `stderr:\n${result.stderr.slice(0, 2000)}` : '',
            ].filter(Boolean).join('\n\n');
            logToolAction(`${TAG} Completed with exit code ${result.exitCode}`);
            return output;
        },
        {
            name: 'run_command',
            description: 'Execute a shell command in the project workspace. Use for running builds, tests, installs, etc. Commands are executed in the workspace root directory.',
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
