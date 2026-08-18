/**
 * Shared git execution helpers.
 *
 * Previously duplicated verbatim in nodes.ts and pr-workflow.ts.
 * Centralised here so every caller uses the same env-var isolation,
 * timeout, and error-return convention.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    GIT_USER_NAME, GIT_USER_EMAIL,
    GIT_NETWORK_TIMEOUT_MS,
} from '../config';
import { GITHUB_MODE } from './github-local';
import type { GitContext } from '../agents/_shared/base-schemas';

// ─── Core helpers ───────────────────────────────────────────────────────────

/** Default timeout for a local git subcommand. */
const GIT_LOCAL_TIMEOUT_MS = 30_000;

/** git subcommands that talk to a remote and therefore need the network timeout. */
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);

/** The subcommand of an argument string, e.g. `"fetch origin main"` -> `"fetch"`. */
function subcommandOf(args: string): string {
    return args.trim().split(/\s+/)[0] ?? '';
}

/** Timeout to apply when the caller did not specify one. */
function defaultTimeoutFor(args: string): number {
    return NETWORK_SUBCOMMANDS.has(subcommandOf(args)) ? GIT_NETWORK_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS;
}

function gitEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: GIT_USER_NAME, GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
        GIT_COMMITTER_NAME: GIT_USER_NAME, GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
    };
}

// ─── Shell-safe argument splitting ──────────────────────────────────────────

/**
 * Parse a shell-style argument string into an array of tokens.
 *
 * Handles double-quoted and single-quoted strings and backslash escapes so
 * that existing callers (`gitExec(dir, 'commit -m "msg"')`) keep working
 * after the switch from `execSync` to `execFileSync`.
 */
export function shellSplit(s: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;

    for (const ch of s) {
        if (escape) { current += ch; escape = false; continue; }
        if (ch === '\\' && !inSingle) { escape = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (/\s/.test(ch) && !inSingle && !inDouble) {
            if (current.length > 0) { tokens.push(current); current = ''; }
            continue;
        }
        current += ch;
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

// ─── Ref validation ─────────────────────────────────────────────────────────

/** Characters that must never appear in a git ref used in shell commands. */
const INVALID_REF_RE = /[\x00-\x1f\x7f ~^:?*\[\\]|[;$`|&<>(){}!#]/;

/**
 * Validate that a git ref (branch name, tag, commit-ish) does not contain
 * shell metacharacters or git-forbidden characters.
 *
 * Call this at trust boundaries where the ref originates from LLM output or
 * external input (e.g. `canonicalBranchName`, `executePRWorkflow` entry).
 */
export function assertValidRef(ref: string): void {
    if (!ref || ref.length === 0) throw new Error('Git ref must not be empty');
    if (ref.length > 255) throw new Error(`Git ref too long (${ref.length} chars, max 255)`);
    if (INVALID_REF_RE.test(ref)) {
        throw new Error(`Invalid git ref "${ref.slice(0, 60)}": contains shell or git metacharacters`);
    }
    if (ref.startsWith('-')) throw new Error(`Invalid git ref "${ref}": must not start with '-'`);
    if (ref.includes('..')) throw new Error(`Invalid git ref "${ref}": must not contain '..'`);
    if (ref.endsWith('.lock')) throw new Error(`Invalid git ref "${ref}": must not end with '.lock'`);
    if (ref.endsWith('.')) throw new Error(`Invalid git ref "${ref}": must not end with '.'`);
    if (ref.startsWith('.')) throw new Error(`Invalid git ref "${ref}": must not start with '.'`);
}

// ─── Secret redaction ───────────────────────────────────────────────────────

/** Patterns that match tokens / PATs / secrets in git output. */
const SECRET_PATTERNS: RegExp[] = [
    /x-access-token:[^@]*@/g,
    /ghp_\w+/g,
    /github_pat_\w+/g,
    /gho_\w+/g,
    /Authorization:\s*(?:Basic|Bearer)\s+\S+/gi,
];

/**
 * Replace known secret patterns in text with a redacted placeholder.
 * Safe to call on any string — returns input unchanged if no secrets found.
 */
export function redactSecrets(text: string): string {
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, '***REDACTED***');
    }
    return result;
}

/**
 * Build a diagnostic message for a failed `execSync`.
 *
 * On a timeout the child is SIGTERM'd, which leaves BOTH `stderr` and
 * `err.message` empty — the literal `"Error:"` seen in the pacmanclaude log.
 * Synthesise something actionable from `signal` / `status` / `code` instead
 * (Plan 21, E6), and always name the failing subcommand.
 */
export function describeGitFailure(err: any, args: string, timeoutMs: number): string {
    const stderr = err?.stderr?.toString().trim() ?? '';
    const message = typeof err?.message === 'string' ? err.message.trim() : '';
    const detail = stderr || message || (
        err?.signal
            ? `git exited via ${err.signal}${err.signal === 'SIGTERM' ? ` (timeout after ${timeoutMs}ms)` : ''}`
            : err?.status != null
                ? `git exited with status ${err.status}`
                : err?.code
                    ? `git failed with ${err.code}`
                    : 'git failed with no diagnostic output'
    );
    return `Error: [git ${subcommandOf(args)}] ${detail}`;
}

/**
 * Run a git command in the given directory.
 *
 * Returns the trimmed stdout on success, or a string starting with
 * `"Error: …"` on failure (never throws).
 *
 * @param timeoutMs Overrides the default (30 s locally, `GIT_NETWORK_TIMEOUT_MS`
 *                  for `fetch`/`push`/`pull`/`clone`/`ls-remote`).
 */
export function gitExec(workspacePath: string, args: string, timeoutMs?: number): string {
    const timeout = timeoutMs ?? defaultTimeoutFor(args);
    try {
        return execFileSync('git', shellSplit(args), {
            cwd: workspacePath, encoding: 'utf-8',
            timeout, maxBuffer: 1024 * 1024 * 5,
            env: gitEnv(),
        }).trim();
    } catch (err: any) {
        return describeGitFailure(err, args, timeout);
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
    timeoutMs?: number,
): { ok: boolean; stdout: string; stderr: string; code: number } {
    const timeout = timeoutMs ?? defaultTimeoutFor(args);
    try {
        const stdout = execFileSync('git', shellSplit(args), {
            cwd: workspacePath, encoding: 'utf-8',
            timeout, maxBuffer: 1024 * 1024 * 5,
            env: gitEnv(),
        }).trim();
        return { ok: true, stdout, stderr: '', code: 0 };
    } catch (err: any) {
        const stderr = err.stderr?.toString().trim();
        return {
            ok: false,
            stdout: err.stdout?.toString().trim() ?? '',
            // Never return an empty stderr — that is how the failure became
            // undiagnosable in the first place.
            stderr: stderr || describeGitFailure(err, args, timeout).replace(/^Error: /, ''),
            code: err.status ?? (err.signal ? -1 : 1),
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
    const remoteUrl = `https://github.com/${owner}/${repo}.git`;
    // Use http.extraHeader instead of embedding the token in the URL to avoid
    // leaking it into .git/config, process listings, and log output.
    const encodedToken = Buffer.from(`x-access-token:${token}`).toString('base64');
    const timeout = GIT_NETWORK_TIMEOUT_MS;
    try {
        return execFileSync('git', [
            '-c', `http.extraHeader=Authorization: Basic ${encodedToken}`,
            'push', remoteUrl, `HEAD:refs/heads/${branchName}`,
        ], {
            cwd: workspacePath, encoding: 'utf-8',
            timeout, maxBuffer: 1024 * 1024 * 5,
            env: gitEnv(),
        }).trim();
    } catch (err: any) {
        return redactSecrets(describeGitFailure(err, `push ${remoteUrl} HEAD:refs/heads/${branchName}`, timeout));
    }
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
