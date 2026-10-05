/**
 * Which directory the smoke test serves (Plan 30-03).
 *
 * The claudeopus5 smoke test served `dist/`, but an Angular 17 build writes
 * `dist/claudeopus5/browser/`: `GET /` was a 404 and, because readiness
 * required a 2xx, the run reported "server did not become ready within
 * 60000ms". For a web root whose build output is in `<artifactDir>`, the
 * served directory is now:
 *   1. Angular — `architect.build.options.outputPath` from angular.json: a
 *      string (`<path>/browser` for the application builder, `<path>` for the
 *      browser builder) or `{ base, browser }`, when it holds an index.html;
 *   2. else the shallowest directory at or below `<artifactDir>` that holds an
 *      index.html;
 *   3. else `<artifactDir>` itself — `GET /` then explains what is missing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readAngularTarget } from '../utils/angular-workspace';
import type { StackRoot } from './quality-gates';

/** Standard build output directories, probed in order. */
export const ARTIFACT_DIRS = ['dist', 'build', 'out', '.next', 'public/build'];

/** How deep below an artifact directory to look for index.html (`dist/<project>/browser` is depth 2). */
const INDEX_SEARCH_DEPTH = 4;

/** The artifact-check fields this module reads (an `ArtifactCheck` fits). */
export interface BuiltRoot {
    root: string;
    passed: boolean;
    foundDir: string | null;
}

export interface WebRoot {
    root: StackRoot;
    /** The build output directory (`<root>/dist`). */
    artifactDir: string;
    /** The directory the smoke server serves. */
    serveDir: string;
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false; // missing or unreadable: not a directory to serve
    }
}

/**
 * Candidate output directories from angular.json's build target, most specific first:
 * `"outputPath": "dist/app"` → `dist/app/browser`, `dist/app`;
 * `"outputPath": { "base": "dist/app", "browser": "web" }` → `dist/app/web` (`"browser": ""` → `dist/app`).
 */
export function angularOutputDirs(rootDir: string): string[] {
    const outputPath = readAngularTarget(rootDir, 'build')?.options?.outputPath;
    if (typeof outputPath === 'string' && outputPath) return [path.join(outputPath, 'browser'), outputPath];
    if (outputPath && typeof outputPath === 'object') {
        const { base, browser } = outputPath as { base?: unknown; browser?: unknown };
        if (typeof base === 'string' && base) return [path.join(base, typeof browser === 'string' ? browser : 'browser')];
    }
    return [];
}

/** The shallowest directory at or below `dir` that contains index.html (breadth-first, sorted, no node_modules or dot dirs). */
export function findIndexDir(dir: string, maxDepth = INDEX_SEARCH_DEPTH): string | null {
    let level = [dir];
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
        const found = level.find(d => fs.existsSync(path.join(d, 'index.html')));
        if (found) return found;
        level = level.flatMap(d => {
            try {
                return fs.readdirSync(d, { withFileTypes: true })
                    .filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
                    .map(e => path.join(d, e.name))
                    .sort();
            } catch {
                return []; // unreadable directory: nothing to search below it
            }
        });
    }
    return null;
}

/** The directory to serve for a root whose build output is in `artifactDir`. */
export function resolveServeDir(rootDir: string, artifactDir: string): string {
    const angular = angularOutputDirs(rootDir)
        .map(rel => path.resolve(rootDir, rel))
        .find(dir => fs.existsSync(path.join(dir, 'index.html')));
    return angular ?? findIndexDir(artifactDir) ?? artifactDir;
}

/**
 * The web root to smoke-test: a node root whose build produced artifacts, else any node
 * root with an index.html and an existing artifact directory.
 */
export function findWebRoot(roots: StackRoot[], artifactChecks: BuiltRoot[]): WebRoot | null {
    const nodeRoots = roots.filter(r => r.stack === 'node');
    const webRoot = (root: StackRoot, artifactDir: string): WebRoot =>
        ({ root, artifactDir, serveDir: resolveServeDir(root.dir, artifactDir) });
    for (const root of nodeRoots) {
        const built = artifactChecks.find(a => a.root === root.relDir && a.passed && a.foundDir);
        if (built?.foundDir) return webRoot(root, path.join(root.dir, built.foundDir));
    }
    for (const root of nodeRoots) {
        if (!fs.existsSync(path.join(root.dir, 'index.html'))) continue;
        const artifactDir = ARTIFACT_DIRS.map(d => path.join(root.dir, d)).find(isDirectory);
        if (artifactDir) return webRoot(root, artifactDir);
    }
    return null;
}

/** Why `GET /` found nothing: where an index.html actually is, or that the build output has none. */
export function explainMissingIndex(workspacePath: string, web: WebRoot): string {
    const rel = (p: string): string => path.relative(workspacePath, p) || '.';
    const found = findIndexDir(web.artifactDir);
    return found && found !== web.serveDir
        ? `index.html found at ${rel(found)}, served ${rel(web.serveDir)}`
        : `no index.html under ${rel(web.artifactDir)}`;
}
