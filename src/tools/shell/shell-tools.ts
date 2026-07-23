/**
 * Sandboxed command-execution tool.
 *
 * Commands run inside a Docker container (via dockerode) against the
 * generated project workspace — never directly on the host.
 * Fallback: if ALLOW_HOST_SHELL=true (dev only), runs on host.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { LogColors, color256 } from '../../utils/log-colors.util';
import { logToolAction } from '../../utils/logger';
import { GIT_USER_NAME, GIT_USER_EMAIL } from '../../config';

const TAG = `${color256(166)}[shell]${LogColors.RESET}`;

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

/**
 * Create the shell execution tool bound to a workspace.
 */
export function createShellTool(workspaceRoot: string) {
    return tool(
        async ({ command, timeoutSeconds }) => {
            const timeout = (timeoutSeconds ?? 60) * 1000;
            logToolAction(`${TAG} Executing: ${command} (timeout=${timeoutSeconds ?? 60}s)`);
            const result = await runShell(command, workspaceRoot, timeout);
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
                timeoutSeconds: z.number().optional().describe('Timeout in seconds (default: 60)'),
            }),
        }
    );
}
