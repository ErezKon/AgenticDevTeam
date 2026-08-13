/**
 * Deterministic Merge Conflict Resolver -- handles the file classes that
 * conflict in practice (lockfiles, package.json) without LLM involvement.
 *
 * Source conflicts are NOT auto-resolved -- they are returned in the
 * `unresolved` list so the caller can hand them to a dev agent or
 * report a blocker (Sub-Plan 06 SS5c).
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger';

const log = getLogger('[MergeResolve]', 135);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MergeResolution {
    /** Files that were auto-resolved and staged. */
    resolved: string[];
    /** Files that still have conflict markers -- caller must handle. */
    unresolved: string[];
}

// ─── Lockfile patterns ──────────────────────────────────────────────────────

const LOCKFILE_NAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
]);

const PACKAGE_JSON_RE = /(?:^|\/)package\.json$/;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Attempt to auto-resolve merge conflicts for known file classes.
 *
 * Must be called when the worktree is in a conflicted state (after a
 * failed `git merge`). Returns the list of resolved and unresolved files.
 *
 * Resolution strategy per file class:
 *  - **Lockfiles** (`package-lock.json`, `yarn.lock`, ...): take the base
 *    version, then regenerate via `npm install` / `yarn install`.
 *  - **`package.json`**: three-way merge of `dependencies` and
 *    `devDependencies` (union, higher semver wins); `scripts` always
 *    comes from the base version (frozen per Sub-Plans 02/05).
 *  - **Source files**: NOT auto-resolved -- returned in `unresolved`.
 *
 * @param worktree  Absolute path to the worktree root.
 * @param conflictedPaths  Paths reported by `git diff --name-only --diff-filter=U`.
 * @param baseBranch  The branch being merged from (e.g. `origin/project/foo`).
 */
export function resolveKnownConflicts(
    worktree: string,
    conflictedPaths: string[],
    baseBranch: string,
): MergeResolution {
    const resolved: string[] = [];
    const unresolved: string[] = [];

    for (const relPath of conflictedPaths) {
        const absPath = path.join(worktree, relPath);
        const baseName = path.basename(relPath);

        if (LOCKFILE_NAMES.has(baseName)) {
            resolveLockfile(worktree, relPath, absPath, baseBranch);
            resolved.push(relPath);
        } else if (PACKAGE_JSON_RE.test(relPath)) {
            const ok = resolvePackageJson(worktree, relPath, absPath, baseBranch);
            if (ok) {
                resolved.push(relPath);
            } else {
                unresolved.push(relPath);
            }
        } else if (isIdenticalOnBothSides(worktree, relPath)) {
            // add/add conflict where contents are identical -- just accept ours
            gitExecLocal(worktree, `checkout --ours "${relPath}"`);
            gitExecLocal(worktree, `add "${relPath}"`);
            resolved.push(relPath);
        } else {
            unresolved.push(relPath);
        }
    }

    if (resolved.length > 0) {
        log.info(`Auto-resolved ${resolved.length} conflict(s): ${resolved.join(', ')}`);
    }
    if (unresolved.length > 0) {
        log.warn(`${unresolved.length} conflict(s) require manual resolution: ${unresolved.join(', ')}`);
    }

    return { resolved, unresolved };
}

/**
 * List conflicted files in a worktree after a failed merge.
 */
export function listConflictedFiles(worktree: string): string[] {
    const result = gitExecLocal(worktree, 'diff --name-only --diff-filter=U');
    if (!result || result.startsWith('Error:')) return [];
    return result.split('\n').map(s => s.trim()).filter(Boolean);
}

// ─── Resolution strategies ──────────────────────────────────────────────────

function resolveLockfile(
    worktree: string, relPath: string, absPath: string, baseBranch: string,
): void {
    // Take the base version
    gitExecLocal(worktree, `checkout "${baseBranch}" -- "${relPath}"`);
    gitExecLocal(worktree, `add "${relPath}"`);
    // Regenerate
    const dir = path.dirname(absPath);
    const baseName = path.basename(relPath);
    try {
        if (baseName === 'package-lock.json' || baseName === 'bun.lockb') {
            execSync('npm install --package-lock-only', {
                cwd: dir, encoding: 'utf-8', timeout: 60_000,
                env: { ...process.env, NODE_ENV: 'development' },
            });
        } else if (baseName === 'yarn.lock') {
            execSync('yarn install --mode update-lockfile', {
                cwd: dir, encoding: 'utf-8', timeout: 60_000,
            });
        } else if (baseName === 'pnpm-lock.yaml') {
            execSync('pnpm install --lockfile-only', {
                cwd: dir, encoding: 'utf-8', timeout: 60_000,
            });
        }
        gitExecLocal(worktree, `add "${relPath}"`);
    } catch (err: any) {
        log.warn(`Lockfile regeneration for ${relPath} failed (non-fatal): ${err.message}`);
        // The base version is still staged -- good enough.
    }
    log.info(`Resolved lockfile conflict: ${relPath}`);
}

function resolvePackageJson(
    worktree: string, relPath: string, absPath: string, baseBranch: string,
): boolean {
    try {
        // Read the two versions: base (theirs) and ours
        const baseContent = gitExecLocal(worktree, `show "${baseBranch}:${relPath}"`);
        const oursContent = gitExecLocal(worktree, `show HEAD:${relPath}`);

        if (baseContent.startsWith('Error:') || oursContent.startsWith('Error:')) {
            log.warn(`Cannot read package.json versions for ${relPath}`);
            return false;
        }

        const basePkg = JSON.parse(baseContent);
        const oursPkg = JSON.parse(oursContent);

        // Merged result: start with ours, then apply union merge rules
        const merged = { ...oursPkg };

        // scripts: always take base (frozen per Sub-Plans 02/05)
        if (basePkg.scripts) {
            merged.scripts = basePkg.scripts;
        }

        // workspaces: always take base (prevent workspace deletion)
        if (basePkg.workspaces) {
            merged.workspaces = basePkg.workspaces;
        }

        // dependencies / devDependencies: union, prefer higher semver
        merged.dependencies = mergeDeps(basePkg.dependencies, oursPkg.dependencies);
        merged.devDependencies = mergeDeps(basePkg.devDependencies, oursPkg.devDependencies);

        // Write merged result
        fs.writeFileSync(absPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
        gitExecLocal(worktree, `add "${relPath}"`);
        log.info(`Resolved package.json conflict: ${relPath} (scripts from base, deps merged)`);
        return true;
    } catch (err: any) {
        log.warn(`package.json three-way merge failed for ${relPath}: ${err.message}`);
        return false;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Union-merge two dependency objects. When both sides declare the same
 * package, the higher semver range wins (crude: lexicographic on the
 * cleaned version string -- good enough for `^1.2.3` style ranges).
 */
function mergeDeps(
    base?: Record<string, string>,
    ours?: Record<string, string>,
): Record<string, string> | undefined {
    if (!base && !ours) return undefined;
    const merged: Record<string, string> = {};
    for (const [pkg, ver] of Object.entries(base ?? {})) {
        merged[pkg] = ver;
    }
    for (const [pkg, ver] of Object.entries(ours ?? {})) {
        if (!merged[pkg] || compareSemverRange(ver, merged[pkg]) > 0) {
            merged[pkg] = ver;
        }
    }
    if (Object.keys(merged).length === 0) return undefined;
    // Sort keys for deterministic output
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(merged).sort()) {
        sorted[key] = merged[key];
    }
    return sorted;
}

/**
 * Crude semver-range comparison: strip leading `^~>=<` and compare
 * the remaining version string lexicographically. Returns > 0 if a > b.
 */
export function compareSemverRange(a: string, b: string): number {
    const cleanA = a.replace(/^[\^~>=<\s]+/, '');
    const cleanB = b.replace(/^[\^~>=<\s]+/, '');
    return cleanA.localeCompare(cleanB, undefined, { numeric: true, sensitivity: 'base' });
}

function isIdenticalOnBothSides(worktree: string, relPath: string): boolean {
    const ours = gitExecLocal(worktree, `show :2:${relPath}`);
    const theirs = gitExecLocal(worktree, `show :3:${relPath}`);
    if (ours.startsWith('Error:') || theirs.startsWith('Error:')) return false;
    return ours === theirs;
}

function gitExecLocal(cwd: string, args: string): string {
    try {
        return execSync(`git ${args}`, {
            cwd, encoding: 'utf-8',
            timeout: 30_000, maxBuffer: 1024 * 1024 * 5,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
            },
        }).trim();
    } catch (err: any) {
        return `Error: ${err.stderr?.toString() ?? err.message}`.trim();
    }
}
