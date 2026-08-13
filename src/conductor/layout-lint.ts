/**
 * Layout Lint — Mechanical layout enforcement.
 *
 * Validates a workspace against a RepoContract, ensuring:
 *   - Files live in declared source/test directories
 *   - Modules exist at their declared paths with correct exports
 *   - Entry points exist and compose all declared components
 *   - No cross-root relative imports
 *   - File naming conventions are respected
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger';
import type { RepoContract, ModuleContract, StackRootContract } from '../agents/_shared/schemas/repo-contract.schema';
import { buildImportGraph, findProductSourceFiles } from './gate-integrity';

const log = getLogger('[LayoutLint]', 208);

// ─── Types ──────────────────────────────────────────────────────────────────

export type LayoutViolationKind =
    | 'file-outside-source-dirs'
    | 'unknown-root'
    | 'duplicate-module'
    | 'module-path-mismatch'
    | 'missing-declared-export'
    | 'entrypoint-missing'
    | 'entrypoint-does-not-compose'
    | 'test-outside-test-dirs'
    | 'cross-root-relative-import'
    | 'naming-violation';

export interface LayoutViolation {
    kind: LayoutViolationKind;
    severity: 'critical' | 'major' | 'minor';
    path: string;
    detail: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
]);

const TEST_FILE_RE = /\.(?:test|spec)\./;

const PRUNE_DIRS = new Set([
    'node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'out',
    'coverage', '.venv', 'venv', 'vendor', 'target', '.conventions',
]);

const IMPORT_RE = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"])/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// ─── Naming convention patterns ─────────────────────────────────────────────

const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// ─── Transitive reachability helper ─────────────────────────────────────────

/**
 * Walk the import graph from `startFile` and return every file transitively
 * reachable (including the start file itself).
 */
function transitiveImports(
    graph: Map<string, Set<string>>,
    startFile: string,
): Set<string> {
    const visited = new Set<string>();
    const queue = [startFile];
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

// ─── File-walking helper ────────────────────────────────────────────────────

function collectSourceFiles(workspacePath: string): string[] {
    const files: string[] = [];
    walkDir(workspacePath, workspacePath, (relPath) => {
        if (SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) {
            files.push(relPath);
        }
    });
    return files;
}

function walkDir(dir: string, root: string, cb: (relPath: string) => void): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
        if (PRUNE_DIRS.has(entry)) continue;
        const abs = path.join(dir, entry);
        try {
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) {
                walkDir(abs, root, cb);
            } else {
                cb(path.relative(root, abs));
            }
        } catch {
            // skip
        }
    }
}

// ─── Import extraction helper ───────────────────────────────────────────────

function extractImportSpecifiers(content: string): string[] {
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

// ─── Normalise module basename ──────────────────────────────────────────────

/**
 * Derive a canonical module key from a filename for duplicate detection.
 * Strips the extension and a leading "use" prefix (hooks), then lowercases.
 *
 * Examples:
 *   InputHandler.ts       -> "inputhandler"
 *   useInputHandler.ts    -> "inputhandler"
 *   input-handler.test.ts -> (test file, skipped)
 */
function canonicalModuleName(filename: string): string {
    let name = filename.replace(/\.[^.]+$/, ''); // strip extension
    name = name.replace(/^use/i, '');             // strip hook prefix
    return name.toLowerCase();
}

// ─── Root lookup helper ─────────────────────────────────────────────────────

/**
 * Return the StackRootContract a relative file path belongs to, or `null` if
 * it falls outside every declared root.
 */
function findRootForFile(
    relPath: string,
    roots: StackRootContract[],
): StackRootContract | null {
    for (const root of roots) {
        const rootDir = root.dir === '.' ? '' : root.dir;
        if (rootDir === '' || relPath.startsWith(rootDir + '/') || relPath === rootDir) {
            return root;
        }
    }
    return null;
}

/**
 * Check whether a relative path falls within one of the given directories
 * (each relative to `rootDir`).
 */
function isInsideDirs(relPath: string, rootDir: string, dirs: string[]): boolean {
    for (const d of dirs) {
        const prefix = rootDir === '.' ? d : path.join(rootDir, d);
        if (relPath.startsWith(prefix + '/') || relPath === prefix) {
            return true;
        }
    }
    return false;
}

// ─── Export detection helper ────────────────────────────────────────────────

/**
 * Detect export names present in a source file by regex.
 *
 * Handles:
 *   export function foo(...)
 *   export class Foo { ... }
 *   export const foo = ...
 *   export interface Foo { ... }
 *   export type Foo = ...
 *   export default ...
 *   export { foo, bar as baz }
 */
function extractExportedNames(content: string): Set<string> {
    const names = new Set<string>();

    // Named exports: export (function|class|const|let|var|interface|type|enum) <name>
    const namedRe = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = namedRe.exec(content)) !== null) {
        names.add(m[1]);
    }

    // Default export
    if (/\bexport\s+default\b/.test(content)) {
        names.add('default');
    }

    // Re-exports / barrel exports: export { foo, bar as baz, ... }
    const braceRe = /\bexport\s*\{([^}]+)\}/g;
    while ((m = braceRe.exec(content)) !== null) {
        const inner = m[1];
        for (const part of inner.split(',')) {
            const token = part.trim();
            if (!token) continue;
            // "Foo as Bar" → exported name is "Bar"
            const asMatch = token.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
            if (asMatch) {
                names.add(asMatch[1]);
            } else {
                const plain = token.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
                if (plain) names.add(plain[1]);
            }
        }
    }

    return names;
}

// ─── Naming convention checker ──────────────────────────────────────────────

/**
 * Apply basic naming convention checks to a module file name.
 * Returns a detail string if the name violates the convention, else null.
 */
function checkNamingConvention(
    modulePath: string,
    componentName: string,
    convention: string,
): string | null {
    const basename = path.basename(modulePath).replace(/\.[^.]+$/, '');
    const lowerConv = convention.toLowerCase();

    // Component / hook files → PascalCase
    const isComponent = /component/i.test(componentName) ||
        /\bpascalcase\b/i.test(lowerConv) && /component/i.test(componentName);
    if (isComponent) {
        if (!PASCAL_CASE_RE.test(basename) && !basename.startsWith('use')) {
            return `Expected PascalCase for component file "${basename}" (component: ${componentName})`;
        }
    }

    // Utility / helper files → camelCase (if convention mentions it)
    const isUtil = /util|helper|service/i.test(componentName);
    if (isUtil && /camelcase/i.test(lowerConv)) {
        if (!CAMEL_CASE_RE.test(basename) && !PASCAL_CASE_RE.test(basename) && !KEBAB_CASE_RE.test(basename)) {
            return `Expected camelCase for utility file "${basename}" (component: ${componentName})`;
        }
    }

    // kebab-case routes (if convention mentions it)
    if (/route/i.test(componentName) && /kebab/i.test(lowerConv)) {
        if (!KEBAB_CASE_RE.test(basename)) {
            return `Expected kebab-case for route file "${basename}" (component: ${componentName})`;
        }
    }

    return null;
}

// ─── Main exported function ─────────────────────────────────────────────────

/**
 * Validate a workspace against a RepoContract and return all layout violations.
 *
 * When `opts.changedPaths` is provided, only those paths are checked for the
 * per-file rules (file-outside-source-dirs, unknown-root, test-outside-test-dirs).
 * Structural checks (entrypoints, module paths, cross-root imports) always run
 * against the full workspace.
 *
 * @param workspacePath  Absolute path to the workspace root
 * @param contract       The RepoContract to validate against
 * @param opts           Optional: restrict per-file checks to changed paths
 * @returns              Array of LayoutViolation sorted by severity
 */
export function lintLayout(
    workspacePath: string,
    contract: RepoContract,
    opts?: { changedPaths?: string[] },
): LayoutViolation[] {
    const violations: LayoutViolation[] = [];
    const { roots, modules, namingConvention } = contract;

    // ── Collect source files ────────────────────────────────────────────
    const allSourceFiles = collectSourceFiles(workspacePath);
    const filesToCheck = opts?.changedPaths
        ? opts.changedPaths.filter(p => SOURCE_EXTENSIONS.has(path.extname(p).toLowerCase()))
        : allSourceFiles;

    log.info(`Linting layout: ${filesToCheck.length} files to check, ${roots.length} root(s), ${modules.length} module(s)`);

    // ── 1. unknown-root (critical) ──────────────────────────────────────
    for (const relFile of filesToCheck) {
        if (TEST_FILE_RE.test(relFile)) continue; // handled by test-outside-test-dirs
        const root = findRootForFile(relFile, roots);
        if (!root) {
            violations.push({
                kind: 'unknown-root',
                severity: 'critical',
                path: relFile,
                detail: `Source file is not under any declared root (roots: ${roots.map(r => r.dir).join(', ')})`,
            });
        }
    }

    // ── 2. file-outside-source-dirs (major) ─────────────────────────────
    for (const relFile of filesToCheck) {
        if (TEST_FILE_RE.test(relFile)) continue;
        const root = findRootForFile(relFile, roots);
        if (!root) continue; // already flagged as unknown-root

        const rootDir = root.dir;
        if (!isInsideDirs(relFile, rootDir, root.sourceDirs)) {
            // Allow files at the root level (config, entry points, etc.)
            const relToRoot = rootDir === '.' ? relFile : path.relative(rootDir, relFile);
            if (relToRoot.includes('/')) {
                violations.push({
                    kind: 'file-outside-source-dirs',
                    severity: 'major',
                    path: relFile,
                    detail: `File is not inside any declared source directory (sourceDirs: ${root.sourceDirs.join(', ')})`,
                });
            }
        }
    }

    // ── 3. test-outside-test-dirs (major) ───────────────────────────────
    for (const relFile of filesToCheck) {
        if (!TEST_FILE_RE.test(relFile)) continue;
        const root = findRootForFile(relFile, roots);
        if (!root) continue; // already flagged by unknown-root

        if (!isInsideDirs(relFile, root.dir, root.testDirs) &&
            !isInsideDirs(relFile, root.dir, root.sourceDirs)) {
            violations.push({
                kind: 'test-outside-test-dirs',
                severity: 'major',
                path: relFile,
                detail: `Test file is not inside any declared test directory (testDirs: ${root.testDirs.join(', ')})`,
            });
        }
    }

    // ── 4. duplicate-module (critical) ──────────────────────────────────
    //    Two files whose canonical basename collide and both exist.
    const modulesByCanonical = new Map<string, ModuleContract[]>();
    for (const mod of modules) {
        const key = canonicalModuleName(path.basename(mod.path));
        if (!modulesByCanonical.has(key)) modulesByCanonical.set(key, []);
        modulesByCanonical.get(key)!.push(mod);
    }
    for (const [canonical, mods] of modulesByCanonical) {
        if (mods.length < 2) continue;
        // Verify both actually exist on disk
        const existing = mods.filter(m => fs.existsSync(path.join(workspacePath, m.path)));
        if (existing.length >= 2) {
            for (const mod of existing) {
                violations.push({
                    kind: 'duplicate-module',
                    severity: 'critical',
                    path: mod.path,
                    detail: `Duplicate module key "${canonical}": collides with ${existing.filter(m => m !== mod).map(m => m.path).join(', ')}`,
                });
            }
        }
    }

    // Also check non-declared source files for basename collisions
    const filesByCanonical = new Map<string, string[]>();
    for (const relFile of allSourceFiles) {
        if (TEST_FILE_RE.test(relFile)) continue;
        const key = canonicalModuleName(path.basename(relFile));
        if (!filesByCanonical.has(key)) filesByCanonical.set(key, []);
        filesByCanonical.get(key)!.push(relFile);
    }
    for (const [canonical, files] of filesByCanonical) {
        if (files.length < 2) continue;
        // Only flag if they are in different directories
        const dirs = new Set(files.map(f => path.dirname(f)));
        if (dirs.size >= 2) {
            // Skip if already reported via declared modules
            const declaredKeys = new Set(
                modules.map(m => canonicalModuleName(path.basename(m.path)))
            );
            if (declaredKeys.has(canonical)) continue;

            for (const file of files) {
                violations.push({
                    kind: 'duplicate-module',
                    severity: 'critical',
                    path: file,
                    detail: `Duplicate module key "${canonical}": collides with ${files.filter(f => f !== file).join(', ')}`,
                });
            }
        }
    }

    // ── 5. module-path-mismatch (major) ─────────────────────────────────
    for (const mod of modules) {
        const expectedAbs = path.join(workspacePath, mod.path);
        if (!fs.existsSync(expectedAbs)) {
            // Search for the file elsewhere
            const basename = path.basename(mod.path);
            const candidates = allSourceFiles.filter(f => path.basename(f) === basename);
            if (candidates.length > 0) {
                violations.push({
                    kind: 'module-path-mismatch',
                    severity: 'major',
                    path: mod.path,
                    detail: `Module "${mod.id}" declared at "${mod.path}" but found at: ${candidates.join(', ')}`,
                });
            }
        }
    }

    // ── 6. missing-declared-export (major) ──────────────────────────────
    for (const mod of modules) {
        const absPath = path.join(workspacePath, mod.path);
        if (!fs.existsSync(absPath)) continue; // module-path-mismatch already flagged

        let content: string;
        try { content = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }

        const actualExports = extractExportedNames(content);

        for (const declared of mod.exports) {
            if (!actualExports.has(declared.name)) {
                violations.push({
                    kind: 'missing-declared-export',
                    severity: 'major',
                    path: mod.path,
                    detail: `Module "${mod.id}" is missing declared export "${declared.name}" (${declared.kind})`,
                });
            }
        }
    }

    // ── 7. entrypoint-missing (critical) ────────────────────────────────
    for (const root of roots) {
        for (const ep of root.entryPoints) {
            const absEp = path.join(workspacePath, root.dir === '.' ? ep : path.join(root.dir, ep));
            if (!fs.existsSync(absEp)) {
                violations.push({
                    kind: 'entrypoint-missing',
                    severity: 'critical',
                    path: root.dir === '.' ? ep : path.join(root.dir, ep),
                    detail: `Entry point "${ep}" declared for root "${root.dir}" does not exist on disk`,
                });
            }
        }
    }

    // ── 8. entrypoint-does-not-compose (critical) ───────────────────────
    //    The entry point's transitive import set must include at least one
    //    module from every declared component in that root.
    const productFiles = findProductSourceFiles(workspacePath);
    const importGraph = buildImportGraph(workspacePath, productFiles);

    for (const root of roots) {
        // Collect component names declared for modules in this root
        const rootDir = root.dir === '.' ? '' : root.dir;
        const rootModules = modules.filter(m => {
            if (rootDir === '') return true;
            return m.path.startsWith(rootDir + '/');
        });

        if (rootModules.length === 0) continue;

        const componentNames = new Set(rootModules.map(m => m.componentName));

        for (const ep of root.entryPoints) {
            const absEp = path.join(workspacePath, rootDir === '' ? ep : path.join(rootDir, ep));
            if (!fs.existsSync(absEp)) continue; // already flagged

            const reachable = transitiveImports(importGraph, absEp);

            // For each component, check if at least one of its modules is reachable
            for (const compName of componentNames) {
                const compModules = rootModules.filter(m => m.componentName === compName);
                const anyReachable = compModules.some(m => {
                    const absModPath = path.join(workspacePath, m.path);
                    return reachable.has(absModPath);
                });

                if (!anyReachable) {
                    violations.push({
                        kind: 'entrypoint-does-not-compose',
                        severity: 'critical',
                        path: rootDir === '' ? ep : path.join(rootDir, ep),
                        detail: `Entry point "${ep}" does not transitively import any module from component "${compName}" (modules: ${compModules.map(m => m.id).join(', ')})`,
                    });
                }
            }
        }
    }

    // ── 9. cross-root-relative-import (critical) ────────────────────────
    //    Relative imports that escape one root and land in another.
    if (roots.length > 1) {
        for (const relFile of allSourceFiles) {
            const root = findRootForFile(relFile, roots);
            if (!root) continue;

            const absFile = path.join(workspacePath, relFile);
            let content: string;
            try { content = fs.readFileSync(absFile, 'utf-8'); } catch { continue; }

            const specs = extractImportSpecifiers(content);
            for (const spec of specs) {
                if (!spec.startsWith('./') && !spec.startsWith('../')) continue;

                const resolvedAbs = path.resolve(path.dirname(absFile), spec);
                const resolvedRel = path.relative(workspacePath, resolvedAbs);

                // Find which root the resolved import lands in
                const targetRoot = findRootForFile(resolvedRel, roots);
                if (targetRoot && targetRoot.dir !== root.dir) {
                    violations.push({
                        kind: 'cross-root-relative-import',
                        severity: 'critical',
                        path: relFile,
                        detail: `Relative import "${spec}" crosses from root "${root.dir}" into root "${targetRoot.dir}"`,
                    });
                }
            }
        }
    }

    // ── 10. naming-violation (minor) ────────────────────────────────────
    if (namingConvention) {
        for (const mod of modules) {
            const absPath = path.join(workspacePath, mod.path);
            if (!fs.existsSync(absPath)) continue;

            const detail = checkNamingConvention(mod.path, mod.componentName, namingConvention);
            if (detail) {
                violations.push({
                    kind: 'naming-violation',
                    severity: 'minor',
                    path: mod.path,
                    detail,
                });
            }
        }
    }

    // ── Sort by severity ────────────────────────────────────────────────
    const severityOrder: Record<string, number> = { critical: 0, major: 1, minor: 2 };
    violations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    log.info(`Layout lint complete: ${violations.length} violation(s) found`);
    if (violations.length > 0) {
        const criticalCount = violations.filter(v => v.severity === 'critical').length;
        const majorCount = violations.filter(v => v.severity === 'major').length;
        const minorCount = violations.filter(v => v.severity === 'minor').length;
        log.warn(`  critical: ${criticalCount}, major: ${majorCount}, minor: ${minorCount}`);
    }

    return violations;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

/**
 * Format layout violations as a Markdown table for PR descriptions or reports.
 */
export function layoutViolationsToMarkdown(violations: LayoutViolation[]): string {
    if (violations.length === 0) return '';
    const lines = [
        '## Layout Lint',
        '',
        '| Severity | Kind | Path | Detail |',
        '|----------|------|------|--------|',
    ];
    for (const v of violations) {
        const escapedDetail = v.detail.replace(/\|/g, '\\|');
        lines.push(`| ${v.severity.toUpperCase()} | ${v.kind} | \`${v.path}\` | ${escapedDetail} |`);
    }
    return lines.join('\n');
}

/**
 * Return `true` when any violation has severity `critical`.
 * Useful for gate decisions (block merge when this returns true).
 */
export function hasCriticalViolations(violations: LayoutViolation[]): boolean {
    return violations.some(v => v.severity === 'critical');
}
