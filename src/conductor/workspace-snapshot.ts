/**
 * Workspace snapshot — pre-computed answers to questions agents waste their
 * tool budget on ("what files exist", "what's in package.json", "where are
 * the tests").  Injected into the prompt so `list_dir`/`read_file`
 * reconnaissance is unnecessary.
 *
 * Sub-Plan 08 §2: agents burned 30–40 % of their budget discovering the
 * workspace.  This gives it to them for free.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getLogger } from '../utils/logger';

const log = getLogger('[workspace-snapshot]', 178);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SnapshotOptions {
    maxFiles: number;
    maxChars: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Directories excluded from the file tree to save tokens. */
const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.agent', 'docs', '.conventions',
    'dist', 'build', '.next', 'coverage', '.nyc_output',
    '__pycache__', '.mypy_cache', '.pytest_cache',
]);

/** File patterns excluded from the file tree. */
const EXCLUDED_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db',
]);

/**
 * Get the file tree via `git ls-files` (only tracked + untracked-but-not-ignored).
 * Falls back to a recursive readdir if git is unavailable.
 */
function getFileTree(worktree: string, maxFiles: number): string[] {
    try {
        const raw = execSync(
            'git ls-files --cached --others --exclude-standard',
            { cwd: worktree, encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 },
        );
        return raw.split('\n')
            .filter(Boolean)
            .filter(f => {
                const parts = f.split('/');
                return !parts.some(p => EXCLUDED_DIRS.has(p))
                    && !EXCLUDED_FILES.has(path.basename(f));
            })
            .slice(0, maxFiles);
    } catch {
        log.warn('git ls-files failed, falling back to readdir');
        return walkDir(worktree, maxFiles);
    }
}

/** Simple recursive readdir fallback. */
function walkDir(dir: string, maxFiles: number, prefix = ''): string[] {
    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= maxFiles) break;
            if (EXCLUDED_DIRS.has(entry.name)) continue;
            if (EXCLUDED_FILES.has(entry.name)) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                results.push(...walkDir(path.join(dir, entry.name), maxFiles - results.length, rel));
            } else {
                results.push(rel);
            }
        }
    } catch { /* skip unreadable dirs */ }
    return results;
}

/**
 * Group files by directory for a compact tree display.
 */
function groupByDirectory(files: string[]): string {
    const groups = new Map<string, string[]>();
    for (const f of files) {
        const dir = path.dirname(f);
        const name = path.basename(f);
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir)!.push(name);
    }
    const lines: string[] = [];
    for (const [dir, names] of groups) {
        lines.push(`${dir}/: ${names.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * Read the `scripts` block from a package.json, verbatim.
 */
function readPackageScripts(pkgPath: string): Record<string, string> | null {
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.scripts ?? null;
    } catch {
        return null;
    }
}

/**
 * Detect test framework and test directories.
 */
function detectTestInfo(worktree: string): string {
    const lines: string[] = [];
    const pkgPath = path.join(worktree, 'package.json');

    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.devDependencies, ...pkg.dependencies };

        if (deps.jest || deps['@jest/core']) lines.push('Test runner: jest');
        else if (deps.vitest) lines.push('Test runner: vitest');
        else if (deps.mocha) lines.push('Test runner: mocha');

        // Test directories
        const testDirs = ['tests', '__tests__', 'test', 'spec']
            .filter(d => fs.existsSync(path.join(worktree, d)));
        if (testDirs.length) lines.push(`Test directories: ${testDirs.join(', ')}`);

        // Test command
        if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
            lines.push(`Test command: npm test → ${pkg.scripts.test}`);
        }
    } catch { /* no package.json */ }

    return lines.join('\n');
}

/**
 * Read dependency names (no versions) from package.json.
 */
function readDependencyNames(worktree: string): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf-8'));
        const deps = Object.keys(pkg.dependencies ?? {});
        const devDeps = Object.keys(pkg.devDependencies ?? {});
        const lines: string[] = [];
        if (deps.length) lines.push(`Dependencies: ${deps.join(', ')}`);
        if (devDeps.length) lines.push(`DevDependencies: ${devDeps.join(', ')}`);
        return lines.join('\n');
    } catch {
        return '';
    }
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Pre-computed answers to the questions agents waste their tool budget on.
 * Injected into the prompt so `list_dir`/`read_file` reconnaissance is unnecessary.
 */
export function buildWorkspaceSnapshot(
    worktree: string,
    opts: SnapshotOptions,
): string {
    const sections: string[] = [];

    // 1. File tree
    const files = getFileTree(worktree, opts.maxFiles);
    const tree = groupByDirectory(files);
    sections.push(`### File Tree (${files.length} files)\n${tree}`);

    // 2. Package scripts
    const rootPkg = path.join(worktree, 'package.json');
    if (fs.existsSync(rootPkg)) {
        const scripts = readPackageScripts(rootPkg);
        if (scripts && Object.keys(scripts).length > 0) {
            const scriptLines = Object.entries(scripts)
                .map(([k, v]) => `  "${k}": "${v}"`)
                .join('\n');
            sections.push(`### package.json scripts\n${scriptLines}`);
        }
    }

    // Check for workspace packages
    try {
        const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf-8'));
        const workspaces: string[] = pkg.workspaces ?? [];
        for (const ws of workspaces.slice(0, 6)) {
            // Resolve glob to actual dirs
            const wsDir = ws.replace('/*', '').replace('*', '');
            const wsBase = path.join(worktree, wsDir);
            if (fs.existsSync(wsBase) && fs.statSync(wsBase).isDirectory()) {
                for (const entry of fs.readdirSync(wsBase, { withFileTypes: true }).slice(0, 8)) {
                    if (!entry.isDirectory()) continue;
                    const wsPkgPath = path.join(wsBase, entry.name, 'package.json');
                    const wsScripts = readPackageScripts(wsPkgPath);
                    if (wsScripts && Object.keys(wsScripts).length > 0) {
                        const sl = Object.entries(wsScripts)
                            .map(([k, v]) => `  "${k}": "${v}"`)
                            .join('\n');
                        sections.push(`### ${wsDir}/${entry.name}/package.json scripts\n${sl}`);
                    }
                }
            }
        }
    } catch { /* no workspaces */ }

    // 3. Test info
    const testInfo = detectTestInfo(worktree);
    if (testInfo) sections.push(`### Test Framework\n${testInfo}`);

    // 4. Dependencies
    const deps = readDependencyNames(worktree);
    if (deps) sections.push(`### Dependencies\n${deps}`);

    // Assemble and truncate to budget
    let snapshot = `## Workspace Snapshot\n\n${sections.join('\n\n')}`;
    if (snapshot.length > opts.maxChars) {
        snapshot = snapshot.slice(0, opts.maxChars - 30) + '\n\n... (truncated)';
    }

    return snapshot;
}
