/**
 * Shared filesystem walking utilities.
 *
 * Consolidates the 5+ near-identical directory walkers that existed across
 * gate-integrity, quality-gates, product-verify, layout-lint, and assembly-gate.
 */
import * as fs from 'fs';
import * as path from 'path';

// ─── Canonical prune / filter constants ──────────────────────────────────────

/** Directories to skip when walking project source trees. */
export const PRUNE_DIRS = new Set([
    'node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'out',
    'coverage', '.venv', 'venv', 'vendor', 'target', '.conventions',
]);

/** Narrow source extensions (code files only). */
export const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
]);

/** Wide source extensions (code + markup/style files). */
export const SOURCE_EXTENSIONS_WIDE = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.html', '.css', '.scss',
]);

/** Comprehensive test file detection patterns. */
export const TEST_FILE_PATTERNS = [
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs)$/,
    /__tests__\//,
    /test_.*\.py$/,
    /.*_test\.go$/,
    /.*Test\.java$/,
    /.*Tests\.cs$/,
];

// ─── Walk options ────────────────────────────────────────────────────────────

export interface WalkOptions {
    /** Directories to prune (defaults to PRUNE_DIRS). */
    pruneDirs?: Set<string>;
    /** Maximum recursion depth (undefined = unlimited). */
    maxDepth?: number;
    /** Maximum number of files to collect (undefined = unlimited). */
    maxFiles?: number;
}

// ─── Core walk function ──────────────────────────────────────────────────────

/**
 * Recursively walk a directory tree, calling `callback` for each file.
 * The callback receives the **relative** path from `root`.
 */
export function walkDir(
    dir: string,
    root: string,
    callback: (relPath: string) => void,
    opts?: WalkOptions,
): void {
    const pruneDirs = opts?.pruneDirs ?? PRUNE_DIRS;
    const maxDepth = opts?.maxDepth;

    let fileCount = 0;
    const maxFiles = opts?.maxFiles;

    function walk(d: string, depth: number): void {
        if (maxFiles !== undefined && fileCount >= maxFiles) return;
        if (maxDepth !== undefined && depth > maxDepth) return;

        let entries: string[];
        try { entries = fs.readdirSync(d); } catch { return; }

        for (const entry of entries) {
            if (maxFiles !== undefined && fileCount >= maxFiles) return;
            if (pruneDirs.has(entry)) continue;
            const absPath = path.join(d, entry);
            try {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    walk(absPath, depth + 1);
                } else {
                    callback(path.relative(root, absPath));
                    fileCount++;
                }
            } catch {
                // skip unreadable entries
            }
        }
    }

    walk(dir, 0);
}

// ─── Convenience collectors ──────────────────────────────────────────────────

/**
 * Collect all files matching a filter predicate (relative paths).
 */
export function collectFiles(
    root: string,
    filter: (relPath: string) => boolean,
    opts?: WalkOptions,
): string[] {
    const files: string[] = [];
    walkDir(root, root, (relPath) => {
        if (filter(relPath)) files.push(relPath);
    }, opts);
    return files;
}

/** Returns true if `relPath` matches any test-file pattern. */
export function isTestFile(relPath: string): boolean {
    return TEST_FILE_PATTERNS.some(re => re.test(relPath));
}

/** Returns true if `relPath` has a source-code extension (narrow set). */
export function isSourceFile(relPath: string): boolean {
    return SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/** Returns true if `relPath` has a source extension (wide: code + markup). */
export function isProductSourceFile(relPath: string): boolean {
    return SOURCE_EXTENSIONS_WIDE.has(path.extname(relPath).toLowerCase());
}
