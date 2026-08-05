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
 * Push the current HEAD to `refs/heads/<branchName>` on the remote,
 * authenticating via the token in `gitContext` (falls back to env vars).
 */
export function gitPush(workspacePath: string, branchName: string, gitContext?: GitContext | null): string {
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
