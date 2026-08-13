/**
 * Shared git execution helpers.
 *
 * Previously duplicated verbatim in nodes.ts and pr-workflow.ts.
 * Centralised here so every caller uses the same env-var isolation,
 * timeout, and error-return convention.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    GIT_USER_NAME, GIT_USER_EMAIL,
} from '../config';
import { GITHUB_MODE } from './github-local';
import type { GitContext } from '../agents/_shared/base-schemas';

// ─── Core helpers ───────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory.
 *
 * Returns the trimmed stdout on success, or a string starting with
 * `"Error: …"` on failure (never throws).
 */
export function gitExec(workspacePath: string, args: string): string {
    try {
        return execSync(`git ${args}`, {
            cwd: workspacePath, encoding: 'utf-8',
            timeout: 30_000, maxBuffer: 1024 * 1024 * 5,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: GIT_USER_NAME, GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
                GIT_COMMITTER_NAME: GIT_USER_NAME, GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
            },
        }).trim();
    } catch (err: any) {
        return `Error: ${err.stderr?.toString() ?? err.message}`.trim();
    }
}

/**
 * Run a git command and return structured output including stderr.
 *
 * Unlike `gitExec`, this variant returns an object with stdout, stderr,
 * and exit code so callers can produce diagnostic error messages instead
 * of the opaque `"Error: "` string observed in pacman8.
 */
export function gitExecVerbose(
    workspacePath: string,
    args: string,
): { ok: boolean; stdout: string; stderr: string; code: number } {
    try {
        const stdout = execSync(`git ${args}`, {
            cwd: workspacePath, encoding: 'utf-8',
            timeout: 30_000, maxBuffer: 1024 * 1024 * 5,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: GIT_USER_NAME, GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
                GIT_COMMITTER_NAME: GIT_USER_NAME, GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
            },
        }).trim();
        return { ok: true, stdout, stderr: '', code: 0 };
    } catch (err: any) {
        return {
            ok: false,
            stdout: err.stdout?.toString().trim() ?? '',
            stderr: err.stderr?.toString().trim() ?? err.message,
            code: err.status ?? 1,
        };
    }
}

/**
 * Push the current HEAD to `refs/heads/<branchName>` on the remote,
 * authenticating via the token in `gitContext` (falls back to env vars).
 *
 * In GITHUB_MODE=local, pushes to the local bare repo path (a plain path
 * is a valid git remote) instead of building an HTTPS URL.
 */
export function gitPush(workspacePath: string, branchName: string, gitContext?: GitContext | null): string {
    if (GITHUB_MODE === 'local') {
        // In local mode, push to origin (which is a local bare repo path)
        return gitExec(workspacePath, `push origin HEAD:refs/heads/${branchName}`);
    }
    const token = gitContext?.token ?? GITHUB_TOKEN;
    const owner = gitContext?.owner ?? GITHUB_OWNER;
    const repo = gitContext?.repo ?? GITHUB_REPO;
    const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    return gitExec(workspacePath, `push ${authUrl} HEAD:refs/heads/${branchName}`);
}

/**
 * Walk upward from `startPath` to find the nearest `.git` directory.
 *
 * @throws if no `.git` ancestor is found.
 */
export function findGitRoot(startPath: string): string {
    let dir = path.resolve(startPath);
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`Not inside a git repository: ${startPath}`);
        dir = parent;
    }
}
