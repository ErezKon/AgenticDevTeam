/**
 * Shared import-extraction and import-graph utilities.
 *
 * Consolidates the duplicated IMPORT_RE/REQUIRE_RE patterns, extractImports,
 * resolveImportPath, buildImportGraph, and transitive-reachability helpers
 * that existed across gate-integrity, layout-lint, and product-verify.
 */
import * as fs from 'fs';
import * as path from 'path';

// ─── Regex patterns ─────────────────────────────────────────────────────────

/** Matches ES import/export from 'specifier' and re-export from 'specifier'. */
export const IMPORT_RE = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"])/g;

/** Matches require('specifier'). */
export const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extensions to try when resolving relative imports. */
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.vue', '.svelte'];

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract all import/require specifiers from source content.
 * Returns raw specifier strings (e.g. './foo', 'react', '../utils/bar').
 */
export function extractImportSpecifiers(content: string): string[] {
    const specs: string[] = [];
    let match: RegExpExecArray | null;

    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content)) !== null) {
        const spec = match[1] ?? match[2];
        if (spec) specs.push(spec);
    }

    REQUIRE_RE.lastIndex = 0;
    while ((match = REQUIRE_RE.exec(content)) !== null) {
        if (match[1]) specs.push(match[1]);
    }

    return specs;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve a relative import specifier to an absolute file path.
 * Tries bare path, then with each extension, then index files.
 * Returns null if the file cannot be found.
 */
export function resolveImportPath(
    fromAbsFile: string,
    specifier: string,
    _workspacePath: string,
): string | null {
    const dir = path.dirname(fromAbsFile);
    const resolved = path.resolve(dir, specifier);
    for (const ext of RESOLVE_EXTENSIONS) {
        if (fs.existsSync(resolved + ext)) return resolved + ext;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
        if (ext && fs.existsSync(path.join(resolved, 'index' + ext))) return path.join(resolved, 'index' + ext);
    }
    return null;
}

// ─── Graph building ─────────────────────────────────────────────────────────

/**
 * Build a directed import graph: abs file path → Set of abs file paths it imports.
 * Only resolves relative imports (./foo, ../bar) — bare specifiers are skipped.
 *
 * @param workspacePath  Absolute path to the workspace root.
 * @param sourceFiles    Relative file paths (from workspacePath).
 */
export function buildImportGraph(
    workspacePath: string,
    sourceFiles: string[],
): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();

    for (const relFile of sourceFiles) {
        const absFile = path.join(workspacePath, relFile);
        let content: string;
        try { content = fs.readFileSync(absFile, 'utf-8'); } catch { continue; }

        const edges = new Set<string>();
        const specs = extractImportSpecifiers(content);
        for (const spec of specs) {
            if (spec.startsWith('./') || spec.startsWith('../')) {
                const resolved = resolveImportPath(absFile, spec, workspacePath);
                if (resolved) edges.add(resolved);
            }
        }
        graph.set(absFile, edges);
    }

    return graph;
}

// ─── Reachability ───────────────────────────────────────────────────────────

/**
 * BFS/DFS from `startFiles` through the import graph.
 * Returns the set of all files transitively reachable (including start files).
 */
export function transitiveReachable(
    graph: Map<string, Set<string>>,
    startFiles: string[],
): Set<string> {
    const visited = new Set<string>();
    const queue = [...startFiles];
    while (queue.length > 0) {
        const file = queue.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        for (const dep of graph.get(file) ?? []) {
            if (!visited.has(dep)) queue.push(dep);
        }
    }
    return visited;
}
