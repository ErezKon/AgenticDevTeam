/**
 * Product Verification — deterministic checks that the generated product
 * actually builds, resolves its imports, and renders something.
 *
 * Plan 19-01: three checks that did not exist before (D5, D6, D7):
 *   5a. verifyBuildArtifacts   — build produced real output?
 *   5b. findUnresolvedReferences — do imports/assets resolve?
 *   5c. runSmokeTest           — does the app serve and respond?
 *   5d. runProductVerification — orchestrator
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { getLogger } from '../utils/logger';
import { emitRunEvent } from '../utils/event-bus';
import {
    PRODUCT_VERIFY_ENABLED,
    PRODUCT_MIN_ARTIFACT_BYTES,
    PRODUCT_RESOLVE_MAX_FILES,
    PRODUCT_SMOKE_BASE_PORT,
    PRODUCT_SMOKE_TIMEOUT_MS,
} from '../config';
import type { StackRoot } from './quality-gates';

const log = getLogger('[ProductVerify]', 183);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ArtifactCheck {
    root: string;              // relDir
    expectedDirs: string[];    // e.g. ['dist'] or ['build', '.next']
    foundDir: string | null;
    fileCount: number;
    totalBytes: number;
    hasEntryHtml: boolean;     // for web apps
    hasEntryJs: boolean;
    passed: boolean;
    reason: string;
}

export interface ResolveIssue {
    file: string;              // relative to workspace
    line: number;
    specifier: string;         // './index.css', '/src/main.tsx', '@/lib/foo'
    kind: 'import' | 'require' | 'html-src' | 'html-href' | 'css-url';
    reason: 'missing-file' | 'missing-package';
}

export interface SmokeResult {
    ran: boolean;
    skippedReason?: string;
    url: string;
    httpStatus: number | null;
    /** Bytes of the served document. */
    bodyBytes: number;
    /** True when the served HTML/DOM contains meaningful content beyond an empty root div. */
    rendered: boolean;
    /** Console errors captured, if a browser was used. */
    consoleErrors: string[];
    passed: boolean;
    reason: string;
}

export interface ProductVerifyReport {
    artifacts: ArtifactCheck[];
    resolveIssues: ResolveIssue[];
    smoke: SmokeResult | null;
    passed: boolean;
    summary: string;
}

export type ProductVerifyMode = 'artifacts+resolve' | 'full';

// ─── Node builtins list ─────────────────────────────────────────────────────

const NODE_BUILTINS = new Set([
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
    'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
    'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
    'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
    'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers',
    'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
    'worker_threads', 'zlib',
]);

// ─── 5a. Artifact verification ──────────────────────────────────────────────

/** Standard output dirs to probe per stack. */
const ARTIFACT_DIRS = ['dist', 'build', 'out', '.next', 'public/build'];

/**
 * Check each root's build output for real artifacts.
 */
export function verifyBuildArtifacts(workspacePath: string, roots: StackRoot[]): ArtifactCheck[] {
    const results: ArtifactCheck[] = [];

    for (const root of roots) {
        if (root.stack !== 'node') continue; // only check node/web roots for artifacts

        const dir = root.dir;
        const hasIndexHtml = fs.existsSync(path.join(dir, 'index.html'));
        const hasBundlerConfig = hasBundler(dir);

        // Backend-only roots: no index.html and no bundler config
        if (!hasIndexHtml && !hasBundlerConfig) {
            results.push({
                root: root.relDir,
                expectedDirs: [],
                foundDir: null,
                fileCount: 0,
                totalBytes: 0,
                hasEntryHtml: false,
                hasEntryJs: false,
                passed: true,
                reason: 'no bundled artifacts expected',
            });
            continue;
        }

        // Determine expected dirs from config
        const expectedDirs = getExpectedArtifactDirs(dir);

        let foundDir: string | null = null;
        let fileCount = 0;
        let totalBytes = 0;
        let hasEntryHtml = false;
        let hasEntryJs = false;

        for (const candidate of expectedDirs) {
            const absCandidate = path.join(dir, candidate);
            if (fs.existsSync(absCandidate) && fs.statSync(absCandidate).isDirectory()) {
                const stats = countDirContents(absCandidate);
                if (stats.count > 0) {
                    foundDir = candidate;
                    fileCount = stats.count;
                    totalBytes = stats.bytes;
                    hasEntryHtml = stats.hasHtml;
                    hasEntryJs = stats.hasJs;
                    break;
                }
            }
        }

        if (!foundDir || fileCount === 0) {
            results.push({
                root: root.relDir,
                expectedDirs,
                foundDir: null,
                fileCount: 0,
                totalBytes: 0,
                hasEntryHtml: false,
                hasEntryJs: false,
                passed: false,
                reason: `build script exited 0 but produced no artifacts in ${expectedDirs.join(', ')}`,
            });
            continue;
        }

        if (totalBytes < PRODUCT_MIN_ARTIFACT_BYTES) {
            results.push({
                root: root.relDir,
                expectedDirs,
                foundDir,
                fileCount,
                totalBytes,
                hasEntryHtml,
                hasEntryJs,
                passed: false,
                reason: `artifacts in ${foundDir}/ total ${totalBytes} bytes (< minimum ${PRODUCT_MIN_ARTIFACT_BYTES})`,
            });
            continue;
        }

        if (hasIndexHtml && !hasEntryHtml && !hasEntryJs) {
            results.push({
                root: root.relDir,
                expectedDirs,
                foundDir,
                fileCount,
                totalBytes,
                hasEntryHtml,
                hasEntryJs,
                passed: false,
                reason: `source has index.html but build output in ${foundDir}/ has no .html and no .js file`,
            });
            continue;
        }

        results.push({
            root: root.relDir,
            expectedDirs,
            foundDir,
            fileCount,
            totalBytes,
            hasEntryHtml,
            hasEntryJs,
            passed: true,
            reason: `${fileCount} files, ${totalBytes} bytes in ${foundDir}/`,
        });
    }

    return results;
}

function hasBundler(dir: string): boolean {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return false; }
    return entries.some(f =>
        f.startsWith('vite.config') || f.startsWith('webpack.config') ||
        f.startsWith('next.config') || f === 'angular.json' ||
        f.startsWith('rollup.config')
    );
}

function getExpectedArtifactDirs(dir: string): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return ARTIFACT_DIRS; }

    // Check for next.js
    if (entries.some(f => f.startsWith('next.config'))) return ['.next', 'out', 'build'];
    // Check for vite (default output: dist)
    if (entries.some(f => f.startsWith('vite.config'))) return ['dist', 'build'];
    // Check angular (default output: dist)
    if (entries.includes('angular.json')) return ['dist', 'build'];

    return ARTIFACT_DIRS;
}

function countDirContents(dir: string): { count: number; bytes: number; hasHtml: boolean; hasJs: boolean } {
    let count = 0;
    let bytes = 0;
    let hasHtml = false;
    let hasJs = false;

    function walk(d: string): void {
        let entries: string[];
        try { entries = fs.readdirSync(d); } catch { return; }
        for (const e of entries) {
            const full = path.join(d, e);
            try {
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    walk(full);
                } else {
                    count++;
                    bytes += stat.size;
                    if (e.endsWith('.html')) hasHtml = true;
                    if (e.endsWith('.js') || e.endsWith('.mjs')) hasJs = true;
                }
            } catch {
                // skip
            }
        }
    }

    walk(dir);
    return { count, bytes, hasHtml, hasJs };
}

// ─── 5b. Unresolved reference detection ─────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.html', '.css', '.scss',
]);

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.vue', '.svelte'];

const SKIP_PREFIXES = ['http:', 'https:', '//', 'data:', 'mailto:', '#'];

// ─── Regex patterns for extracting specifiers ──────────────────────────────

const IMPORT_RE = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"])/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const HTML_SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/gi;
const HTML_HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;

/**
 * Find all unresolved import/require/src/href references in the workspace.
 * Static analysis only — no bundler needed.
 */
export function findUnresolvedReferences(workspacePath: string): ResolveIssue[] {
    const issues: ResolveIssue[] = [];
    const files = collectSourceFiles(workspacePath, PRODUCT_RESOLVE_MAX_FILES);

    // Load tsconfig paths if available
    const tsconfigPaths = loadTsconfigPaths(workspacePath);

    // Build a set of package dependencies from the nearest package.json
    const rootDeps = loadPackageDeps(workspacePath);

    for (const absFile of files) {
        const relFile = path.relative(workspacePath, absFile);
        const ext = path.extname(absFile).toLowerCase();
        let content: string;
        try {
            content = fs.readFileSync(absFile, 'utf-8');
        } catch {
            continue;
        }

        const lines = content.split('\n');

        if (ext === '.html') {
            // HTML file: check src= and href=
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                extractAndCheck(line, HTML_SRC_RE, 'html-src', relFile, i + 1, absFile, workspacePath, tsconfigPaths, rootDeps, issues);
                extractAndCheck(line, HTML_HREF_RE, 'html-href', relFile, i + 1, absFile, workspacePath, tsconfigPaths, rootDeps, issues);
            }
        } else if (ext === '.css' || ext === '.scss') {
            // CSS file: check url()
            for (let i = 0; i < lines.length; i++) {
                extractAndCheck(lines[i], CSS_URL_RE, 'css-url', relFile, i + 1, absFile, workspacePath, tsconfigPaths, rootDeps, issues);
            }
        } else {
            // JS/TS/Vue/Svelte: check imports and requires
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                extractAndCheck(line, IMPORT_RE, 'import', relFile, i + 1, absFile, workspacePath, tsconfigPaths, rootDeps, issues, true);
                extractAndCheck(line, REQUIRE_RE, 'require', relFile, i + 1, absFile, workspacePath, tsconfigPaths, rootDeps, issues);
                extractAndCheck(line, DYNAMIC_IMPORT_RE, 'import', relFile, i + 1, absFile, workspacePath, tsconfigPaths, rootDeps, issues);
            }
        }
    }

    return issues;
}

function extractAndCheck(
    line: string,
    regex: RegExp,
    kind: ResolveIssue['kind'],
    relFile: string,
    lineNum: number,
    absFile: string,
    workspacePath: string,
    tsconfigPaths: Map<string, string[]>,
    rootDeps: Set<string>,
    issues: ResolveIssue[],
    multiGroup?: boolean,
): void {
    // Reset regex state
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
        // For import regex that has two capture groups (import from / export from)
        const specifier = multiGroup ? (match[1] ?? match[2]) : match[1];
        if (!specifier) continue;

        // Skip external URLs
        if (SKIP_PREFIXES.some(p => specifier.startsWith(p))) continue;

        const issue = checkSpecifier(specifier, kind, relFile, lineNum, absFile, workspacePath, tsconfigPaths, rootDeps);
        if (issue) issues.push(issue);
    }
}

function checkSpecifier(
    specifier: string,
    kind: ResolveIssue['kind'],
    relFile: string,
    lineNum: number,
    absFile: string,
    workspacePath: string,
    tsconfigPaths: Map<string, string[]>,
    rootDeps: Set<string>,
): ResolveIssue | null {
    const fileDir = path.dirname(absFile);

    // Relative imports: ./foo or ../foo
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (!resolveRelative(fileDir, specifier)) {
            return { file: relFile, line: lineNum, specifier, kind, reason: 'missing-file' };
        }
        return null;
    }

    // Root-absolute references: /src/main.tsx (common in HTML)
    if (specifier.startsWith('/')) {
        // For HTML files, resolve against nearest dir with index.html
        const resolveBase = findHtmlRoot(absFile, workspacePath) ?? workspacePath;
        if (!resolveRelative(resolveBase, '.' + specifier)) {
            return { file: relFile, line: lineNum, specifier, kind, reason: 'missing-file' };
        }
        return null;
    }

    // Alias imports: @/..., ~/..., or tsconfig paths
    if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
        return resolveAlias(specifier, tsconfigPaths, workspacePath, relFile, lineNum, kind);
    }
    // Check tsconfig paths for other aliases
    for (const [alias] of tsconfigPaths) {
        const aliasPrefix = alias.replace('/*', '/').replace('*', '');
        if (specifier.startsWith(aliasPrefix)) {
            return resolveAlias(specifier, tsconfigPaths, workspacePath, relFile, lineNum, kind);
        }
    }

    // Bare package imports: react, express, etc.
    // Only check for JS/TS imports, not HTML src/href
    if (kind === 'import' || kind === 'require') {
        const pkgName = getPackageName(specifier);

        // Node builtins
        if (specifier.startsWith('node:') || NODE_BUILTINS.has(pkgName)) return null;

        // Check package.json dependencies
        if (!rootDeps.has(pkgName)) {
            // Also check the nearest package.json to the file
            const nearestDeps = loadPackageDeps(path.dirname(absFile));
            if (!nearestDeps.has(pkgName)) {
                return { file: relFile, line: lineNum, specifier, kind, reason: 'missing-package' };
            }
        }
    }

    return null;
}

function resolveRelative(baseDir: string, specifier: string): boolean {
    const resolved = path.resolve(baseDir, specifier);
    for (const ext of RESOLVE_EXTENSIONS) {
        if (fs.existsSync(resolved + ext)) return true;
    }
    // Try index files
    for (const ext of RESOLVE_EXTENSIONS) {
        if (ext && fs.existsSync(path.join(resolved, 'index' + ext))) return true;
    }
    return false;
}

function resolveAlias(
    specifier: string,
    tsconfigPaths: Map<string, string[]>,
    workspacePath: string,
    relFile: string,
    lineNum: number,
    kind: ResolveIssue['kind'],
): ResolveIssue | null {
    if (tsconfigPaths.size === 0) return null; // No paths config — skip, don't report

    for (const [alias, targets] of tsconfigPaths) {
        const aliasPrefix = alias.replace('/*', '/').replace('*', '');
        if (!specifier.startsWith(aliasPrefix)) continue;

        const rest = specifier.slice(aliasPrefix.length);
        for (const target of targets) {
            const targetBase = target.replace('/*', '/').replace('*', '');
            const fullTarget = path.resolve(workspacePath, targetBase + rest);
            if (resolveRelative(path.dirname(fullTarget), './' + path.basename(fullTarget))) return null;
            // Also try the fullTarget directly
            for (const ext of RESOLVE_EXTENSIONS) {
                if (fs.existsSync(fullTarget + ext)) return null;
            }
            for (const ext of RESOLVE_EXTENSIONS) {
                if (ext && fs.existsSync(path.join(fullTarget, 'index' + ext))) return null;
            }
        }
        // Alias matched but didn't resolve
        return { file: relFile, line: lineNum, specifier, kind, reason: 'missing-file' };
    }

    return null;
}

function findHtmlRoot(absFile: string, workspacePath: string): string | null {
    let dir = path.dirname(absFile);
    while (dir.startsWith(workspacePath)) {
        if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function getPackageName(specifier: string): string {
    if (specifier.startsWith('@')) {
        // Scoped package: @scope/name or @scope/name/path
        const parts = specifier.split('/');
        return parts.slice(0, 2).join('/');
    }
    return specifier.split('/')[0];
}

function loadTsconfigPaths(dir: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    try {
        const tsconfig = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf-8'));
        const paths = tsconfig?.compilerOptions?.paths;
        if (paths && typeof paths === 'object') {
            for (const [alias, targets] of Object.entries(paths)) {
                if (Array.isArray(targets)) {
                    map.set(alias, targets as string[]);
                }
            }
        }
    } catch {
        // no tsconfig or parse error
    }
    return map;
}

function loadPackageDeps(dir: string): Set<string> {
    const deps = new Set<string>();
    // Walk up to find the nearest package.json
    let currentDir = dir;
    for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(currentDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
                    if (pkg[key] && typeof pkg[key] === 'object') {
                        for (const name of Object.keys(pkg[key])) {
                            deps.add(name);
                        }
                    }
                }
            } catch {
                // parse error
            }
            break;
        }
        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }
    return deps;
}

function collectSourceFiles(workspacePath: string, maxFiles: number): string[] {
    const files: string[] = [];
    const PRUNE_DIRS = new Set([
        'node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'out',
        'coverage', '.venv', 'venv', 'vendor', 'target', '.conventions',
    ]);

    function walk(dir: string): void {
        if (files.length >= maxFiles) return;
        let entries: string[];
        try { entries = fs.readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            if (files.length >= maxFiles) return;
            if (PRUNE_DIRS.has(entry)) continue;
            const absPath = path.join(dir, entry);
            try {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    walk(absPath);
                } else if (SOURCE_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
                    files.push(absPath);
                }
            } catch {
                // skip
            }
        }
    }

    walk(workspacePath);
    return files;
}

// ─── 5c. Smoke test ─────────────────────────────────────────────────────────

/**
 * Serve the built artifacts statically and verify the app responds.
 * Uses an inline static file server (no external deps).
 */
export async function runSmokeTest(
    workspacePath: string,
    roots: StackRoot[],
    artifactChecks: ArtifactCheck[],
): Promise<SmokeResult> {
    // Find the web root: a root with an index.html and a bundler config,
    // preferring one whose build produced artifacts
    const webRoot = findWebRoot(workspacePath, roots, artifactChecks);
    if (!webRoot) {
        return {
            ran: false,
            skippedReason: 'no web root detected',
            url: '',
            httpStatus: null,
            bodyBytes: 0,
            rendered: false,
            consoleErrors: [],
            passed: true,
            reason: 'no web root detected — smoke test skipped',
        };
    }

    const serveDir = webRoot.serveDir;
    if (!fs.existsSync(serveDir)) {
        return {
            ran: false,
            skippedReason: 'serve directory does not exist',
            url: '',
            httpStatus: null,
            bodyBytes: 0,
            rendered: false,
            consoleErrors: [],
            passed: false,
            reason: `serve directory ${path.relative(workspacePath, serveDir)} does not exist`,
        };
    }

    // Find a free port
    const port = await findFreePort(PRODUCT_SMOKE_BASE_PORT);

    // Start inline static file server
    const server = createStaticServer(serveDir);
    let serverError: Error | null = null;

    return new Promise<SmokeResult>((resolve) => {
        server.on('error', (err: Error) => { serverError = err; });
        server.listen(port, '127.0.0.1', async () => {
            const url = `http://127.0.0.1:${port}`;
            try {
                // Wait for readiness
                const ready = await pollForReady(url, PRODUCT_SMOKE_TIMEOUT_MS);
                if (!ready) {
                    resolve({
                        ran: true,
                        url,
                        httpStatus: null,
                        bodyBytes: 0,
                        rendered: false,
                        consoleErrors: [],
                        passed: false,
                        reason: `server did not become ready within ${PRODUCT_SMOKE_TIMEOUT_MS}ms`,
                    });
                    return;
                }

                // Fetch the root page
                const rootFetch = await fetchUrl(url + '/');
                if (!rootFetch.ok) {
                    resolve({
                        ran: true,
                        url,
                        httpStatus: rootFetch.status,
                        bodyBytes: 0,
                        rendered: false,
                        consoleErrors: [],
                        passed: false,
                        reason: `GET / returned ${rootFetch.status}`,
                    });
                    return;
                }

                // Check sub-resources referenced in the HTML
                const subResources = extractSameOriginRefs(rootFetch.body);
                const failedResources: string[] = [];
                let totalAssetBytes = rootFetch.body.length;

                for (const ref of subResources.slice(0, 20)) {
                    const refUrl = new URL(ref, url).href;
                    try {
                        const refFetch = await fetchUrl(refUrl);
                        if (!refFetch.ok) {
                            failedResources.push(`${ref} → ${refFetch.status}`);
                        } else {
                            totalAssetBytes += refFetch.body.length;
                        }
                    } catch {
                        failedResources.push(`${ref} → network error`);
                    }
                }

                if (failedResources.length > 0) {
                    resolve({
                        ran: true,
                        url,
                        httpStatus: rootFetch.status,
                        bodyBytes: rootFetch.body.length,
                        rendered: false,
                        consoleErrors: [],
                        passed: false,
                        reason: `${failedResources.length} sub-resource(s) failed: ${failedResources.join(', ')}`,
                    });
                    return;
                }

                // Rendered heuristic: HTML must reference at least one script that returns 2xx,
                // and total bytes must exceed PRODUCT_MIN_ARTIFACT_BYTES
                const hasScriptRef = subResources.some(r => r.endsWith('.js') || r.endsWith('.mjs'));
                const rendered = (hasScriptRef || rootFetch.body.length > 500) &&
                    totalAssetBytes >= PRODUCT_MIN_ARTIFACT_BYTES;

                resolve({
                    ran: true,
                    url,
                    httpStatus: rootFetch.status,
                    bodyBytes: rootFetch.body.length,
                    rendered,
                    consoleErrors: [],
                    passed: true,
                    reason: `served OK: ${rootFetch.body.length} bytes HTML, ${subResources.length} sub-resources, ${totalAssetBytes} total bytes`,
                });
            } catch (err: any) {
                resolve({
                    ran: true,
                    url,
                    httpStatus: null,
                    bodyBytes: 0,
                    rendered: false,
                    consoleErrors: [],
                    passed: false,
                    reason: `smoke test error: ${err.message}`,
                });
            } finally {
                server.close();
            }
        });

        // Safety timeout
        setTimeout(() => {
            server.close();
            if (serverError) {
                resolve({
                    ran: false,
                    skippedReason: `server error: ${serverError.message}`,
                    url: '',
                    httpStatus: null,
                    bodyBytes: 0,
                    rendered: false,
                    consoleErrors: [],
                    passed: false,
                    reason: `server failed to start: ${serverError.message}`,
                });
            }
        }, PRODUCT_SMOKE_TIMEOUT_MS + 5000);
    });
}

function findWebRoot(
    workspacePath: string,
    roots: StackRoot[],
    artifactChecks: ArtifactCheck[],
): { root: StackRoot; serveDir: string } | null {
    // Prefer roots with artifacts and an index.html
    for (const root of roots) {
        if (root.stack !== 'node') continue;
        const ac = artifactChecks.find(a => a.root === root.relDir && a.passed && a.foundDir);
        if (ac && ac.foundDir) {
            return { root, serveDir: path.join(root.dir, ac.foundDir) };
        }
    }
    // Fallback: any root with an index.html
    for (const root of roots) {
        if (root.stack !== 'node') continue;
        if (fs.existsSync(path.join(root.dir, 'index.html'))) {
            // Check for built artifacts
            for (const candidate of ARTIFACT_DIRS) {
                const absCandidate = path.join(root.dir, candidate);
                if (fs.existsSync(absCandidate) && fs.statSync(absCandidate).isDirectory()) {
                    return { root, serveDir: absCandidate };
                }
            }
        }
    }
    return null;
}

async function findFreePort(startPort: number): Promise<number> {
    for (let port = startPort; port < startPort + 100; port++) {
        const free = await isPortFree(port);
        if (free) return port;
    }
    return startPort + 100;
}

function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

/**
 * Inline static file server — no external dependencies.
 */
function createStaticServer(serveDir: string): http.Server {
    const MIME_TYPES: Record<string, string> = {
        '.html': 'text/html',
        '.js':   'application/javascript',
        '.mjs':  'application/javascript',
        '.css':  'text/css',
        '.json': 'application/json',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif':  'image/gif',
        '.svg':  'image/svg+xml',
        '.ico':  'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf':  'font/ttf',
        '.map':  'application/json',
    };

    return http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        let filePath = path.join(serveDir, url.pathname);

        // Default to index.html for directories
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        }

        // SPA fallback: if file doesn't exist and has no extension, serve index.html
        if (!fs.existsSync(filePath) && !path.extname(filePath)) {
            filePath = path.join(serveDir, 'index.html');
        }

        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': content.length });
        res.end(content);
    });
}

async function pollForReady(url: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const result = await fetchUrl(url + '/');
            if (result.ok) return true;
        } catch {
            // not ready yet
        }
        await sleep(500);
    }
    return false;
}

function fetchUrl(url: string): Promise<{ ok: boolean; status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 10000 }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => {
                resolve({
                    ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
                    status: res.statusCode ?? 500,
                    body,
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function extractSameOriginRefs(html: string): string[] {
    const refs: string[] = [];
    const patterns = [HTML_SRC_RE, HTML_HREF_RE];
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(html)) !== null) {
            const ref = m[1];
            if (!ref) continue;
            if (SKIP_PREFIXES.some(p => ref.startsWith(p))) continue;
            // Only same-origin relative refs
            if (ref.startsWith('/') || ref.startsWith('./') || ref.startsWith('../') || !ref.includes('://')) {
                refs.push(ref);
            }
        }
    }
    return [...new Set(refs)];
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ─── 5d. Orchestrator ───────────────────────────────────────────────────────

/**
 * Run product verification: artifacts → resolve → smoke.
 */
export async function runProductVerification(
    workspacePath: string,
    roots: StackRoot[],
    mode: ProductVerifyMode = 'full',
): Promise<ProductVerifyReport> {
    if (!PRODUCT_VERIFY_ENABLED) {
        return {
            artifacts: [],
            resolveIssues: [],
            smoke: null,
            passed: true,
            summary: 'Product verification disabled (PRODUCT_VERIFY_ENABLED=false)',
        };
    }

    log.info(`Product verification: mode=${mode} roots=${roots.length}`);

    // 5a. Artifact checks
    const artifacts = verifyBuildArtifacts(workspacePath, roots);

    // 5b. Unresolved references
    const resolveIssues = findUnresolvedReferences(workspacePath);

    // 5c. Smoke test (only in 'full' mode)
    let smoke: SmokeResult | null = null;
    if (mode === 'full') {
        try {
            smoke = await runSmokeTest(workspacePath, roots, artifacts);
        } catch (err: any) {
            log.warn(`Smoke test error: ${err.message}`);
            smoke = {
                ran: false,
                skippedReason: `error: ${err.message}`,
                url: '',
                httpStatus: null,
                bodyBytes: 0,
                rendered: false,
                consoleErrors: [],
                passed: false,
                reason: `smoke test error: ${err.message}`,
            };
        }
    }

    // Compose result
    const artifactsPassed = artifacts.every(a => a.passed);
    const resolvePassed = resolveIssues.length === 0;
    const smokePassed = smoke ? smoke.passed : true;
    const passed = artifactsPassed && resolvePassed && smokePassed;

    const summaryParts: string[] = [];
    const artOk = artifacts.filter(a => a.passed).length;
    summaryParts.push(`artifacts=${artOk}/${artifacts.length}`);
    summaryParts.push(`unresolved refs=${resolveIssues.length}`);
    if (smoke) {
        summaryParts.push(`smoke=${smoke.passed ? 'pass' : smoke.ran ? 'fail' : 'skipped'}`);
    }

    const summary = `Product verification: ${passed ? 'PASSED' : 'FAILED'} — ${summaryParts.join(', ')}`;
    log.info(summary);

    emitRunEvent('gate:result', { kind: 'product-verify', passed, artifacts: artifacts.length, resolveIssues: resolveIssues.length, smoke: smoke?.passed ?? null });

    return { artifacts, resolveIssues, smoke, passed, summary };
}
