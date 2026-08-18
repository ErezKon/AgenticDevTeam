/**
 * Git helpers used by pipeline nodes — branch detection, commit+push,
 * lockfile sync, and Dockerfile SSL patching.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec, gitPush, findGitRoot } from '../../utils/git-exec';
import { syncWorkspaceToBranch } from '../workspace-sync';
import { GIT_DEFAULT_BRANCH } from '../../config';
import type { GitContext } from '../../agents/_shared/base-schemas';

// ─── Default branch detection ───────────────────────────────────────────────

/**
 * Detect the default branch name for a git repo.
 * Tries symbolic-ref, then checks for common branch names, then falls back to config.
 */
export function detectDefaultBranch(workspacePath: string): string {
    try {
        const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
            cwd: workspacePath, encoding: 'utf-8', timeout: 5000,
        }).trim();
        // refs/remotes/origin/main → main
        return ref.replace('refs/remotes/origin/', '');
    } catch {
        // Fallback: check if main or master branch exists
        try {
            const branches = execSync('git branch --list', {
                cwd: workspacePath, encoding: 'utf-8', timeout: 5000,
            }).trim();
            if (branches.includes('main')) return 'main';
            if (branches.includes('master')) return 'master';
        } catch { /* ignore */ }
    }
    return GIT_DEFAULT_BRANCH;
}

// ─── Commit & push artifacts ────────────────────────────────────────────────

/**
 * Stage, commit, and push any new/modified files in the workspace.
 * Used by planning agents (architect, PM) that produce doc artifacts
 * but don't go through the PR workflow.
 *
 * Syncs with origin before committing, and retries the push once after
 * a sync if the first push fails (non-fast-forward after squash merges).
 */
export function commitAndPushArtifacts(
    workspacePath: string,
    commitMessage: string,
    gitContext?: GitContext | null,
    logger?: ReturnType<typeof getLogger>,
): void {
    // Resolve git root for sync operations
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(workspacePath);
    } catch {
        gitRoot = workspacePath;
    }

    // Sync before committing to avoid non-fast-forward pushes
    const currentBranch = gitExec(gitRoot, 'rev-parse --abbrev-ref HEAD');
    if (currentBranch && !currentBranch.startsWith('Error:')) {
        syncWorkspaceToBranch(gitRoot, currentBranch, gitContext);
    }

    gitExec(workspacePath, 'add .');
    const status = gitExec(workspacePath, 'status --short');
    if (!status || status.includes('nothing to commit')) {
        // No new changes to commit, but check if we need to push existing commits
        if (currentBranch && !currentBranch.startsWith('Error:')) {
            const ahead = gitExec(workspacePath, `rev-list origin/${currentBranch}..HEAD --count`);
            if (ahead && !ahead.startsWith('Error:') && parseInt(ahead.trim(), 10) > 0) {
                const pushResult = gitPush(workspacePath, currentBranch, gitContext);
                if (pushResult.startsWith('Error:')) {
                    logger?.warn?.(`Push of existing commits failed: ${pushResult}`);
                } else {
                    logger?.info?.(`Pushed ${ahead.trim()} existing commit(s) on ${currentBranch}`);
                }
            }
        }
        return;
    }

    gitExec(workspacePath, `commit -m "${commitMessage}"`);
    if (currentBranch && !currentBranch.startsWith('Error:')) {
        const pushResult = gitPush(workspacePath, currentBranch, gitContext);
        if (pushResult.startsWith('Error:')) {
            // Retry once: sync again then push
            logger?.warn?.(`Push failed, retrying after sync: ${pushResult}`);
            syncWorkspaceToBranch(gitRoot, currentBranch, gitContext);
            const retryResult = gitPush(workspacePath, currentBranch, gitContext);
            if (retryResult.startsWith('Error:')) {
                logger?.error?.(`Failed to push artifacts after retry: ${retryResult}`);
            } else {
                logger?.info?.(`Committed and pushed artifacts on ${currentBranch} (after retry)`);
            }
        } else {
            logger?.info?.(`Committed and pushed artifacts on ${currentBranch}`);
        }
    }
}

// ─── Node.js lockfile sync ──────────────────────────────────────────────────

/**
 * Ensure package-lock.json is in sync with package.json.
 * If package.json exists but the lockfile is missing or stale, run `npm install`
 * to regenerate it, then commit + push the result.
 */
export function ensureNodeLockfileSync(
    workspacePath: string,
    _systemBranch: string,
    gitContext?: GitContext | null,
    logger?: ReturnType<typeof getLogger>,
): void {
    const pkgPath = path.join(workspacePath, 'package.json');
    if (!fs.existsSync(pkgPath)) return; // Not a Node.js project

    logger?.info?.('Ensuring package-lock.json is in sync with package.json...');

    try {
        // Run npm install to regenerate lockfile
        // Use --no-audit --no-fund to reduce noise
        execSync('npm install --no-audit --no-fund', {
            cwd: workspacePath,
            timeout: 300_000, // 5 min
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 5,
            env: { ...process.env, CI: 'true' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Check if lockfile was created/updated
        const lockPath = path.join(workspacePath, 'package-lock.json');
        if (fs.existsSync(lockPath)) {
            // Stage and check for changes
            gitExec(workspacePath, 'add package-lock.json');
            const status = gitExec(workspacePath, 'status --short -- package-lock.json');
            if (status && status.trim() && !status.includes('nothing to commit')) {
                const slug = path.basename(workspacePath);
                gitExec(workspacePath, `commit -m "[${slug}]-chore: sync package-lock.json"`);
                const branch = gitExec(workspacePath, 'rev-parse --abbrev-ref HEAD');
                if (branch && !branch.startsWith('Error:')) {
                    gitPush(workspacePath, branch, gitContext);
                }
                logger?.info?.('package-lock.json synced and pushed');
            } else {
                logger?.info?.('package-lock.json already in sync');
            }
        }
    } catch (err: any) {
        logger?.warn?.(`Lockfile sync failed (non-fatal): ${err.message}`);
    }
}

// ─── Dockerfile SSL patching ────────────────────────────────────────────────

/**
 * Ensure all Dockerfiles in the workspace have `npm config set strict-ssl false`
 * before any `npm ci` or `npm install` RUN commands.
 *
 * Gated behind DOCKER_ALLOW_INSECURE_NPM=true (default false). Only enable in
 * environments with self-signed corporate SSL proxy certificates.
 */
export function patchDockerfilesSsl(workspacePath: string, logger?: ReturnType<typeof getLogger>): void {
    // Plan 26-02, D3: guard behind explicit opt-in
    const { DOCKER_ALLOW_INSECURE_NPM } = require('../../config');
    if (!DOCKER_ALLOW_INSECURE_NPM) return;

    const dockerfiles = ['Dockerfile'];
    // Also look for Dockerfile.* variants
    try {
        const entries = fs.readdirSync(workspacePath);
        for (const e of entries) {
            if (e.startsWith('Dockerfile') && !dockerfiles.includes(e)) {
                dockerfiles.push(e);
            }
        }
    } catch { /* ignore */ }

    for (const df of dockerfiles) {
        const dfPath = path.join(workspacePath, df);
        if (!fs.existsSync(dfPath)) continue;

        let content = fs.readFileSync(dfPath, 'utf-8');
        // Check if any RUN line has npm ci or npm install WITHOUT strict-ssl already set
        const npmRunPattern = /^(RUN\s+(?:.*&&\s*)?)npm\s+(ci|install)\b/gm;
        const sslAlready = /npm config set strict-ssl false/;

        if (npmRunPattern.test(content) && !sslAlready.test(content)) {
            // Inject `npm config set strict-ssl false && ` before `npm ci`/`npm install`
            content = content.replace(
                /npm\s+(ci|install)\b/g,
                'npm config set strict-ssl false && npm $1',
            );
            fs.writeFileSync(dfPath, content, 'utf-8');
            logger?.info?.(`Patched ${df}: added npm strict-ssl=false workaround`);
        }
    }
}
