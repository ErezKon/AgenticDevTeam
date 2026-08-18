/**
 * Gate Integrity & Anti-Gaming — Sub-Plan 02.
 *
 * Makes quality gates un-gameable by:
 *   1. Capturing a config baseline (package.json scripts, deps, test files)
 *   2. Detecting tampering (script-neutered, deps-removed, test-deleted, etc.)
 *   3. Detecting trivial/non-product tests (tautological assertions, orphan subjects)
 *
 * The baseline is captured twice per PR: once globally after the first scaffold
 * merge (persisted to <outputPath>/config-baseline.json), and once per-branch
 * in the PR worktree before the dev agent runs. Tamper detection compares
 * the two baselines and flags any critical findings for revert-and-block.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getLogger } from '../utils/logger';
import { REJECT_TRIVIAL_TESTS, GATE_REACHABILITY_MIN_CLOSURE } from '../config';
import type { StackRoot } from './quality-gates';

const log = getLogger('[GateIntegrity]', 214);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConfigBaseline {
    /** ISO timestamp of capture. */
    capturedAt: string;
    /** Map of workspace-relative path → sha256 of the file contents. */
    fileHashes: Record<string, string>;
    /** Map of workspace-relative package.json path → its `scripts` object. */
    scripts: Record<string, Record<string, string>>;
    /** Map of workspace-relative package.json path → dependency name → range. */
    deps: Record<string, Record<string, string>>;
    /** Workspace-relative paths of every test file found. */
    testFiles: string[];
    /** Per test file: count of top-level test/it blocks and count of skipped ones. */
    testCounts: Record<string, { tests: number; skipped: number }>;
    /** Map of workspace-relative path → file body (for protected config files only). */
    protectedBodies: Record<string, string>;
}

export type TamperKind =
    | 'script-neutered'
    | 'script-removed'
    | 'script-weakened'
    | 'deps-removed'
    | 'workspaces-removed'
    | 'test-file-deleted'
    | 'test-count-reduced'
    | 'test-skipped'
    | 'trivial-test-added'
    | 'typecheck-weakened'
    | 'lint-weakened'
    | 'gitignore-widened'
    | 'config-change-by-feature-branch';

export interface TamperFinding {
    kind: TamperKind;
    severity: 'critical' | 'major';
    file: string;
    detail: string;
}

export type TrivialTestReason =
    | 'tautological-assertion'
    | 'no-product-import'
    | 'subject-not-in-product'
    | 'single-arithmetic-test'
    | 'no-assertions';

export interface TrivialTestFinding {
    file: string;
    reason: TrivialTestReason;
    detail: string;
}

/**
 * Reasons that unambiguously indicate the agent gamed the test gate. These stay
 * `critical` and remain eligible for deletion.
 */
const UNAMBIGUOUS_TRIVIAL_REASONS: ReadonlySet<TrivialTestReason> = new Set([
    'tautological-assertion', 'single-arithmetic-test', 'no-assertions',
]);

/**
 * Severity for a trivial-test finding (Plan 22, F3).
 *
 * `no-product-import` and `subject-not-in-product` are *heuristic* import-graph
 * results: a resolver miss on an extensionless TypeScript import, a path alias, or
 * a browser-driven spec all trigger them. Deleting source code on a heuristic is
 * not proportionate, so those are downgraded to `major` and reported rather than
 * enforced. The pacmanclaude run produced five such findings and zero true
 * positives, and the resulting deletion caused the review failure that followed.
 */
export function trivialTestSeverity(reason: TrivialTestReason): 'critical' | 'major' {
    return UNAMBIGUOUS_TRIVIAL_REASONS.has(reason) ? 'critical' : 'major';
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Globs for configuration files protected by baseline diffing. */
export const PROTECTED_CONFIG_GLOBS: string[] = [
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
    'tsconfig*.json', 'jsconfig.json',
    'jest.config.*', 'vitest.config.*', 'karma.conf.*', 'playwright.config.*',
    '.eslintrc*', 'eslint.config.*', '.prettierrc*',
    'vite.config.*', 'webpack.config.*', 'next.config.*', 'angular.json', 'rollup.config.*',
    'pom.xml', 'build.gradle*', 'go.mod', 'go.sum', 'Cargo.toml', 'pyproject.toml', 'setup.py',
    'requirements.txt', '*.csproj', '*.sln', '.gitignore', '.npmrc', 'Makefile',
];

/** Subset of protected globs that guard script mutations — used for the stricter deny mode. */
export const PROTECTED_SCRIPT_GLOBS: string[] = [
    'package.json',
    'jest.config.*', 'vitest.config.*', 'karma.conf.*', 'playwright.config.*',
    'tsconfig*.json', 'jsconfig.json',
    '.eslintrc*', 'eslint.config.*',
    'vite.config.*', 'webpack.config.*', 'next.config.*', 'angular.json', 'rollup.config.*',
    'Makefile',
];

/** Test file glob patterns. */
const TEST_FILE_PATTERNS = [
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs)$/,
    /__tests__\//,
    /test_.*\.py$/,
    /.*_test\.go$/,
    /.*Test\.java$/,
    /.*Tests\.cs$/,
];

/** Regex matching no-op build/test/lint scripts. */
export const NO_OP_SCRIPT_RE = /^\s*(echo\b.*|true|:|exit\s+0|node\s+-e\s+["']?["']?|cd\s+\.)\s*(&&\s*(echo\b.*|true|exit\s+0))*\s*$/i;

/** Known real build tools. */
const KNOWN_BUILDERS_RE = /\b(tsc|vite|webpack|ng |next|rollup|esbuild|parcel|mvn|gradle|go build|cargo|dotnet)\b/;

/** Regex matching script-weakening flags. */
const WEAKENING_FLAGS_RE = /--passWithNoTests|--max-warnings|--no-verify|\|\|\s*true|;\s*true|--testPathIgnorePatterns|--bail=0|--force|--if-present/;

/** Gate-critical script keys. */
const GATE_SCRIPT_KEYS = ['build', 'test', 'lint', 'typecheck'];

/** Regex for counting test blocks. */
const TEST_BLOCK_RE = /\b(?:it|test)\s*\(/g;
const SKIPPED_BLOCK_RE = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/g;
const SKIPPED_ALT_RE = /\bx(?:it|describe)\s*\(/g;

/** Source/entry file patterns for product entry points. */
const ENTRY_PATTERNS = [
    /^index\.html$/,
    /^(?:main|index|server|app|App)\.[a-zA-Z]+$/,
];

// ─── Glob matching helper ───────────────────────────────────────────────────

/** Match a filename against a simple glob pattern (*, not **). */
export function matchesProtectedGlob(filename: string, globs: string[]): boolean {
    const base = path.basename(filename);
    for (const glob of globs) {
        if (glob.includes('*')) {
            const re = new RegExp('^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
            if (re.test(base)) return true;
        } else {
            if (base === glob) return true;
        }
    }
    return false;
}

// ─── 1. Baseline capture ────────────────────────────────────────────────────

/**
 * Capture a configuration baseline for tamper detection.
 */
export function captureConfigBaseline(workspacePath: string, roots: StackRoot[]): ConfigBaseline {
    const baseline: ConfigBaseline = {
        capturedAt: new Date().toISOString(),
        fileHashes: {},
        scripts: {},
        deps: {},
        testFiles: [],
        testCounts: {},
        protectedBodies: {},
    };

    // Collect all directories to scan (root + each StackRoot's dir)
    const dirsToScan = new Set<string>();
    dirsToScan.add(workspacePath);
    for (const root of roots) {
        dirsToScan.add(root.dir);
    }

    for (const dir of dirsToScan) {

        // Hash and store protected config files
        for (const glob of PROTECTED_CONFIG_GLOBS) {
            const files = findFilesMatchingGlob(dir, glob);
            for (const absFile of files) {
                const relFile = path.relative(workspacePath, absFile);
                try {
                    const body = fs.readFileSync(absFile, 'utf-8');
                    baseline.fileHashes[relFile] = sha256(body);
                    // Store bodies for protected files (they are small)
                    if (matchesProtectedGlob(relFile, PROTECTED_CONFIG_GLOBS)) {
                        baseline.protectedBodies[relFile] = body;
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        }

        // Parse package.json files for scripts and deps
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const relPkg = path.relative(workspacePath, pkgPath);
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.scripts && typeof pkg.scripts === 'object') {
                    baseline.scripts[relPkg] = { ...pkg.scripts };
                }
                const allDeps: Record<string, string> = {};
                for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
                    if (pkg[key] && typeof pkg[key] === 'object') {
                        Object.assign(allDeps, pkg[key]);
                    }
                }
                if (Object.keys(allDeps).length > 0) {
                    baseline.deps[relPkg] = allDeps;
                }
            } catch {
                // parse error
            }
        }
    }

    // Collect test files
    baseline.testFiles = findTestFiles(workspacePath);

    // Count test blocks per file
    for (const relTestFile of baseline.testFiles) {
        const absFile = path.join(workspacePath, relTestFile);
        try {
            const content = fs.readFileSync(absFile, 'utf-8');
            baseline.testCounts[relTestFile] = countTestBlocks(content);
        } catch {
            baseline.testCounts[relTestFile] = { tests: 0, skipped: 0 };
        }
    }

    return baseline;
}

// ─── 2. Tamper detection ────────────────────────────────────────────────────

/**
 * Compare two baselines and detect tampering attempts.
 */
export function detectTampering(
    baseline: ConfigBaseline,
    current: ConfigBaseline,
    workspacePath: string,
): TamperFinding[] {
    const findings: TamperFinding[] = [];

    // ── Script tampering ────────────────────────────────────────────────
    for (const [pkgFile, baseScripts] of Object.entries(baseline.scripts)) {
        const curScripts = current.scripts[pkgFile];

        for (const key of GATE_SCRIPT_KEYS) {
            const oldVal = baseScripts[key];
            const newVal = curScripts?.[key];

            if (oldVal === undefined) continue;

            // script-removed
            if (newVal === undefined) {
                findings.push({
                    kind: 'script-removed',
                    severity: 'critical',
                    file: pkgFile,
                    detail: `${key}: "${oldVal}" → (removed)`,
                });
                continue;
            }

            if (oldVal === newVal) continue;

            // script-neutered: replaced with a no-op
            if (NO_OP_SCRIPT_RE.test(newVal)) {
                findings.push({
                    kind: 'script-neutered',
                    severity: 'critical',
                    file: pkgFile,
                    detail: `${key}: "${oldVal}" → "${newVal}"`,
                });
                continue;
            }

            // script-neutered: length dropped >60% and old invoked a known builder
            if (KNOWN_BUILDERS_RE.test(oldVal) && newVal.length < oldVal.length * 0.4) {
                findings.push({
                    kind: 'script-neutered',
                    severity: 'critical',
                    file: pkgFile,
                    detail: `${key}: "${oldVal}" → "${newVal}" (${Math.round((1 - newVal.length / oldVal.length) * 100)}% shorter, old used a known builder)`,
                });
                continue;
            }

            // script-weakened: new value adds weakening flags
            if (WEAKENING_FLAGS_RE.test(newVal) && !WEAKENING_FLAGS_RE.test(oldVal)) {
                findings.push({
                    kind: 'script-weakened',
                    severity: 'major',
                    file: pkgFile,
                    detail: `${key}: "${oldVal}" → "${newVal}"`,
                });
            }
        }
    }

    // ── workspaces-removed ───────────────────────────────────────────────
    for (const pkgFile of Object.keys(baseline.scripts)) {
        const absFile = path.join(workspacePath, pkgFile);
        try {
            const oldPkg = JSON.parse(baseline.protectedBodies[pkgFile] ?? '{}');
            const newPkg = JSON.parse(fs.readFileSync(absFile, 'utf-8'));
            if (oldPkg.workspaces && !newPkg.workspaces) {
                findings.push({
                    kind: 'workspaces-removed',
                    severity: 'critical',
                    file: pkgFile,
                    detail: `workspaces array deleted (was ${JSON.stringify(oldPkg.workspaces)})`,
                });
            }
        } catch {
            // parse error — skip
        }
    }

    // ── deps-removed ────────────────────────────────────────────────────
    const allCurrentDeps = new Set<string>();
    for (const d of Object.values(current.deps)) {
        for (const name of Object.keys(d)) allCurrentDeps.add(name);
    }
    for (const [pkgFile, baseDeps] of Object.entries(baseline.deps)) {
        const curDeps = current.deps[pkgFile] ?? {};
        for (const depName of Object.keys(baseDeps)) {
            if (!(depName in curDeps) && !allCurrentDeps.has(depName)) {
                findings.push({
                    kind: 'deps-removed',
                    severity: 'major',
                    file: pkgFile,
                    detail: `dependency "${depName}" removed`,
                });
            }
        }
    }

    // ── test-file-deleted ───────────────────────────────────────────────
    const currentTestSet = new Set(current.testFiles);
    const currentBasenames = new Set(current.testFiles.map(f => path.basename(f)));
    for (const oldTest of baseline.testFiles) {
        if (!currentTestSet.has(oldTest)) {
            // Allow moves: check if same basename exists elsewhere
            if (!currentBasenames.has(path.basename(oldTest))) {
                findings.push({
                    kind: 'test-file-deleted',
                    severity: 'critical',
                    file: oldTest,
                    detail: `test file deleted and no file with the same basename exists elsewhere`,
                });
            }
        }
    }

    // ── test-count-reduced ──────────────────────────────────────────────
    let baseTotal = 0;
    let curTotal = 0;
    for (const counts of Object.values(baseline.testCounts)) baseTotal += counts.tests;
    for (const counts of Object.values(current.testCounts)) curTotal += counts.tests;
    if (curTotal < baseTotal) {
        findings.push({
            kind: 'test-count-reduced',
            severity: 'major',
            file: '(aggregate)',
            detail: `total test count decreased from ${baseTotal} to ${curTotal}`,
        });
    }

    // ── test-skipped ────────────────────────────────────────────────────
    let baseSkipped = 0;
    let curSkipped = 0;
    for (const counts of Object.values(baseline.testCounts)) baseSkipped += counts.skipped;
    for (const counts of Object.values(current.testCounts)) curSkipped += counts.skipped;
    if (curSkipped > baseSkipped) {
        findings.push({
            kind: 'test-skipped',
            severity: 'major',
            file: '(aggregate)',
            detail: `skipped test count increased from ${baseSkipped} to ${curSkipped}`,
        });
    }

    // ── typecheck-weakened ───────────────────────────────────────────────
    findings.push(...detectTypecheckWeakening(baseline, current, workspacePath));

    // ── lint-weakened ────────────────────────────────────────────────────
    findings.push(...detectLintWeakening(baseline, current, workspacePath));

    // ── gitignore-widened ────────────────────────────────────────────────
    findings.push(...detectGitignoreWidening(baseline, current, workspacePath));

    return findings;
}

// ─── Typecheck weakening detection ──────────────────────────────────────────

function detectTypecheckWeakening(
    baseline: ConfigBaseline,
    current: ConfigBaseline,
    workspacePath: string,
): TamperFinding[] {
    const findings: TamperFinding[] = [];

    for (const relFile of Object.keys(current.fileHashes)) {
        if (!/tsconfig.*\.json$/i.test(relFile)) continue;
        const oldBody = baseline.protectedBodies[relFile];
        if (!oldBody) continue;

        const absFile = path.join(workspacePath, relFile);
        let newBody: string;
        try { newBody = fs.readFileSync(absFile, 'utf-8'); } catch { continue; }

        try {
            const oldCfg = JSON.parse(oldBody);
            const newCfg = JSON.parse(newBody);
            const oldOpts = oldCfg?.compilerOptions ?? {};
            const newOpts = newCfg?.compilerOptions ?? {};

            if (oldOpts.strict === true && newOpts.strict === false) {
                findings.push({
                    kind: 'typecheck-weakened',
                    severity: 'major',
                    file: relFile,
                    detail: 'strict: true → false',
                });
            }
            if (oldOpts.skipLibCheck === false && newOpts.skipLibCheck === true) {
                findings.push({
                    kind: 'typecheck-weakened',
                    severity: 'major',
                    file: relFile,
                    detail: 'skipLibCheck: false → true',
                });
            }
            // Check if exclude array grew to cover source dirs
            const oldExclude = new Set(oldCfg?.exclude ?? []);
            const newExclude = newCfg?.exclude ?? [];
            for (const ex of newExclude) {
                if (!oldExclude.has(ex) && /\bsrc\b/i.test(ex)) {
                    findings.push({
                        kind: 'typecheck-weakened',
                        severity: 'major',
                        file: relFile,
                        detail: `new exclude entry covering source: "${ex}"`,
                    });
                }
            }
        } catch {
            // parse error — skip
        }
    }

    // Check for new @ts-nocheck in source files
    const sourceFiles = findSourceFiles(workspacePath);
    for (const relFile of sourceFiles) {
        const absFile = path.join(workspacePath, relFile);
        try {
            const content = fs.readFileSync(absFile, 'utf-8');
            if (/\/\/\s*@ts-nocheck/i.test(content)) {
                // Check if it was there before
                const oldBody = baseline.protectedBodies[relFile];
                if (!oldBody || !/\/\/\s*@ts-nocheck/i.test(oldBody)) {
                    findings.push({
                        kind: 'typecheck-weakened',
                        severity: 'major',
                        file: relFile,
                        detail: '@ts-nocheck added to source file',
                    });
                }
            }
        } catch {
            // skip
        }
    }

    return findings;
}

// ─── Lint weakening detection ───────────────────────────────────────────────

function detectLintWeakening(
    baseline: ConfigBaseline,
    current: ConfigBaseline,
    workspacePath: string,
): TamperFinding[] {
    const findings: TamperFinding[] = [];

    for (const relFile of Object.keys(current.fileHashes)) {
        if (!/\.eslintrc|eslint\.config/i.test(relFile)) continue;
        const oldBody = baseline.protectedBodies[relFile];
        if (!oldBody) continue;

        const absFile = path.join(workspacePath, relFile);
        let newBody: string;
        try { newBody = fs.readFileSync(absFile, 'utf-8'); } catch { continue; }

        // Check for rules moved to "off" or 0
        const oldRules = extractEslintRules(oldBody);
        const newRules = extractEslintRules(newBody);
        for (const [rule, oldLevel] of oldRules) {
            const newLevel = newRules.get(rule);
            if (newLevel !== undefined && isRuleOff(newLevel) && !isRuleOff(oldLevel)) {
                findings.push({
                    kind: 'lint-weakened',
                    severity: 'major',
                    file: relFile,
                    detail: `rule "${rule}" moved to "off"`,
                });
            }
        }
    }

    // Check for new eslintignore entries covering source
    const eslintignorePath = path.join(workspacePath, '.eslintignore');
    if (fs.existsSync(eslintignorePath)) {
        const oldBody = baseline.protectedBodies['.eslintignore'] ?? '';
        try {
            const newBody = fs.readFileSync(eslintignorePath, 'utf-8');
            const oldEntries = new Set(oldBody.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
            const newEntries = newBody.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            for (const entry of newEntries) {
                if (!oldEntries.has(entry) && /\bsrc\b/i.test(entry)) {
                    findings.push({
                        kind: 'lint-weakened',
                        severity: 'major',
                        file: '.eslintignore',
                        detail: `new ignore pattern covering source: "${entry}"`,
                    });
                }
            }
        } catch {
            // skip
        }
    }

    return findings;
}

function extractEslintRules(body: string): Map<string, string | number> {
    const rules = new Map<string, string | number>();
    try {
        // Try JSON parse first
        const parsed = JSON.parse(body);
        if (parsed.rules) {
            for (const [rule, value] of Object.entries(parsed.rules)) {
                const level = Array.isArray(value) ? (value as any[])[0] : value;
                rules.set(rule, level as string | number);
            }
        }
    } catch {
        // Try regex extraction for JS configs
        const ruleRe = /["']([a-zA-Z/@-]+)["']\s*:\s*["']?(off|warn|error|\d)["']?/g;
        let match: RegExpExecArray | null;
        while ((match = ruleRe.exec(body)) !== null) {
            rules.set(match[1], match[2]);
        }
    }
    return rules;
}

function isRuleOff(level: string | number): boolean {
    return level === 'off' || level === 0 || level === '0';
}

// ─── Gitignore widening detection ───────────────────────────────────────────

function detectGitignoreWidening(
    baseline: ConfigBaseline,
    _current: ConfigBaseline,
    workspacePath: string,
): TamperFinding[] {
    const findings: TamperFinding[] = [];
    const gitignorePath = path.join(workspacePath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return findings;

    const oldBody = baseline.protectedBodies['.gitignore'] ?? '';
    let newBody: string;
    try { newBody = fs.readFileSync(gitignorePath, 'utf-8'); } catch { return findings; }

    const oldEntries = new Set(oldBody.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
    const newEntries = newBody.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // Get list of existing source files
    const sourceFiles = findSourceFiles(workspacePath);

    for (const entry of newEntries) {
        if (oldEntries.has(entry)) continue;
        // Check if any source file matches this gitignore entry
        for (const srcFile of sourceFiles) {
            if (gitignoreMatches(entry, srcFile)) {
                findings.push({
                    kind: 'gitignore-widened',
                    severity: 'major',
                    file: '.gitignore',
                    detail: `new entry "${entry}" matches existing source file "${srcFile}"`,
                });
                break; // One finding per entry is enough
            }
        }
    }

    return findings;
}

function gitignoreMatches(pattern: string, filePath: string): boolean {
    // Simple gitignore matching: handle leading /, trailing /, basic globs
    let p = pattern;
    if (p.endsWith('/')) p = p.slice(0, -1); // directory pattern
    if (p.startsWith('/')) p = p.slice(1);    // anchored to root

    // Convert to regex
    const reStr = p
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*');

    try {
        return new RegExp(`(^|/)${reStr}($|/)`).test(filePath);
    } catch {
        return false;
    }
}

// ─── 3. Trivial test detection ──────────────────────────────────────────────

/** Path patterns that identify a browser-driven end-to-end spec. */
const BROWSER_TEST_PATH_RE =
    /(^|\/)(e2e|cypress|playwright)(\/|$)|\.(e2e|pw|cy)\.(spec|test)\.[tj]sx?$/i;

/** Imports that identify a browser-driven end-to-end spec. */
const BROWSER_TEST_IMPORT_RE =
    /['"](@playwright\/test|playwright|playwright-core|cypress|@cucumber\/[^'"]+|selenium-webdriver|puppeteer|webdriverio|@wdio\/[^'"]+)['"]/;

/** Browser-driver API surface that identifies a browser-driven spec. */
const BROWSER_TEST_API_RE = /\b(page\.goto\(|page\.locator\(|browser\.|cy\.visit\(|cy\.get\()/;

/**
 * True when a test file drives the product through a browser rather than by
 * importing it (Plan 22, F2).
 *
 * A Playwright/Cypress spec imports nothing from the product source tree **by
 * construction** — it navigates to a URL and asserts on the rendered DOM. The
 * `no-product-import` and `subject-not-in-product` rules are therefore
 * meaningless for these files. In the pacmanclaude run they produced four
 * CRITICAL findings, the gate deleted `tests/e2e/{accessibility,gameplay,offline,
 * responsive}.spec.ts`, pushed the deletion, and the reviewer then filed
 * `[MAJOR] No test files exist` — a failure the gate manufactured itself.
 */
export function isBrowserDrivenTest(relPath: string, content: string): boolean {
    if (BROWSER_TEST_PATH_RE.test(relPath)) return true;
    if (BROWSER_TEST_IMPORT_RE.test(content)) return true;
    return BROWSER_TEST_API_RE.test(content);
}

/** Any assertion at all — used as the triviality rule for browser tests. */
const ASSERTION_RE = /\b(expect|assert|should)\s*[.(]/;

/**
 * Detect trivial / non-product tests that don't exercise real product code.
 *
 * Rules:
 *   1. no-product-import: test file imports nothing from the product source tree
 *      — SKIPPED for browser-driven e2e specs (Plan 22, F2)
 *   2. tautological-assertion: every assertion is over literals only
 *   3. subject-not-in-product: the module under test is not reachable from any entry point
 *      — SKIPPED for browser-driven e2e specs (Plan 22, F2)
 *   4. single-arithmetic-test: one test with a single numeric/string literal assertion
 *   5. no-assertions: a browser-driven spec that asserts nothing (Plan 22, F2)
 */
export function detectTrivialTests(
    workspacePath: string,
    testFiles: string[],
    productSourceFiles: string[],
): TrivialTestFinding[] {
    if (!REJECT_TRIVIAL_TESTS) return [];

    const findings: TrivialTestFinding[] = [];

    // Build the product import graph: file → set of files it imports
    const importGraph = buildImportGraph(workspacePath, productSourceFiles);

    // Find entry points (index.html, main.*, App.*, server.*, index.*)
    const entryPoints = findEntryPoints(workspacePath, productSourceFiles);

    // Compute reachable set from all entry points
    const reachable = computeReachable(importGraph, entryPoints, workspacePath);

    // Plan 24 B4: skip import-graph checks when the reachable set is degenerate
    // (covers fewer than GATE_REACHABILITY_MIN_CLOSURE product modules).
    // A tiny closure means the resolver missed path aliases, barrel re-exports,
    // or the project uses a framework that doesn't follow import conventions.
    const skipReachabilityChecks = reachable.size < GATE_REACHABILITY_MIN_CLOSURE;
    if (skipReachabilityChecks) {
        log.info(`Reachability check skipped: entry closure is degenerate (${reachable.size} modules)`);
    }

    for (const relTestFile of testFiles) {
        const absFile = path.join(workspacePath, relTestFile);
        let content: string;
        try { content = fs.readFileSync(absFile, 'utf-8'); } catch { continue; }

        // Rule 4: single-arithmetic-test
        if (isSingleArithmeticTest(content)) {
            findings.push({
                file: relTestFile,
                reason: 'single-arithmetic-test',
                detail: 'file contains exactly one test with a single numeric/string literal assertion',
            });
            continue; // No need to check other rules
        }

        // Plan 22 F2: browser-driven specs exercise the product through a browser,
        // so the import-graph rules do not apply. Only assert that they assert.
        if (isBrowserDrivenTest(relTestFile, content)) {
            if (!ASSERTION_RE.test(content)) {
                findings.push({
                    file: relTestFile,
                    reason: 'no-assertions',
                    detail: 'browser-driven spec contains no expect/assert call',
                });
            }
            continue;
        }

        // Plan 24 B4: skip import-graph checks when entry closure is degenerate
        if (skipReachabilityChecks) continue;

        // Rule 1: no-product-import
        const imports = extractImports(content);
        const productImports = imports.filter(spec =>
            (spec.startsWith('./') || spec.startsWith('../')) &&
            isProductFile(resolveImportPath(absFile, spec, workspacePath), workspacePath, productSourceFiles)
        );

        if (productImports.length === 0) {
            findings.push({
                file: relTestFile,
                reason: 'no-product-import',
                detail: 'test file imports nothing from the product source tree',
            });
            continue;
        }

        // Rule 3: subject-not-in-product
        const subjectFiles = productImports
            .map(spec => resolveImportPath(absFile, spec, workspacePath))
            .filter((f): f is string => f !== null);

        const allUnreachable = subjectFiles.length > 0 && subjectFiles.every(f => !reachable.has(f));
        if (allUnreachable) {
            findings.push({
                file: relTestFile,
                reason: 'subject-not-in-product',
                detail: `test subject(s) [${subjectFiles.map(f => path.relative(workspacePath, f)).join(', ')}] not reachable from any application entry point`,
            });
        }
    }

    return findings;
}

// ─── Import graph helpers ───────────────────────────────────────────────────

const IMPORT_RE = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"])/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Build a directed import graph: abs file path → Set of abs file paths it imports.
 * Exported so product-verify can reuse it.
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
        const specs = extractImports(content);
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

/** Extract import/require specifiers from source content. */
function extractImports(content: string): string[] {
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

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.vue', '.svelte'];

/** Resolve a relative import specifier to an absolute path. */
function resolveImportPath(
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

/** Check if a resolved path is a product source file (not a test file). */
function isProductFile(absPath: string | null, workspacePath: string, productSourceFiles: string[]): boolean {
    if (!absPath) return false;
    const rel = path.relative(workspacePath, absPath);
    return productSourceFiles.includes(rel);
}

/** Find application entry points in the workspace. */
function findEntryPoints(workspacePath: string, sourceFiles: string[]): string[] {
    const entries: string[] = [];
    for (const relFile of sourceFiles) {
        const base = path.basename(relFile);
        if (ENTRY_PATTERNS.some(re => re.test(base))) {
            entries.push(path.join(workspacePath, relFile));
        }
    }
    // Also check for index.html at workspace root and subdirs
    const indexHtml = path.join(workspacePath, 'index.html');
    if (fs.existsSync(indexHtml) && !entries.includes(indexHtml)) {
        entries.push(indexHtml);
    }
    return entries;
}

/** BFS from entry points through the import graph to compute reachable set. */
function computeReachable(
    graph: Map<string, Set<string>>,
    entryPoints: string[],
    workspacePath: string,
): Set<string> {
    const reachable = new Set<string>();
    const queue = [...entryPoints];

    // Also handle index.html → script src extraction
    for (const entry of entryPoints) {
        if (entry.endsWith('.html')) {
            try {
                const content = fs.readFileSync(entry, 'utf-8');
                const srcRe = /\bsrc\s*=\s*["']([^"']+)["']/gi;
                let match: RegExpExecArray | null;
                while ((match = srcRe.exec(content)) !== null) {
                    const spec = match[1];
                    if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) {
                        const resolved = resolveImportPath(entry, spec.startsWith('/') ? '.' + spec : spec, workspacePath);
                        if (resolved) queue.push(resolved);
                    }
                }
            } catch {
                // skip
            }
        }
    }

    while (queue.length > 0) {
        const current = queue.pop()!;
        if (reachable.has(current)) continue;
        reachable.add(current);
        const edges = graph.get(current);
        if (edges) {
            for (const dep of edges) {
                if (!reachable.has(dep)) queue.push(dep);
            }
        }
    }

    return reachable;
}

/** Check if a test file contains exactly one test with a single arithmetic/literal assertion. */
function isSingleArithmeticTest(content: string): boolean {
    const testBlocks = content.match(TEST_BLOCK_RE);
    if (!testBlocks || testBlocks.length !== 1) return false;

    // Check if there's exactly one expect call with literal arguments
    const expectCalls = content.match(/expect\s*\([^)]+\)/g);
    if (!expectCalls || expectCalls.length !== 1) return false;

    // Check if the expect argument is arithmetic over literals
    const arg = expectCalls[0].replace(/^expect\s*\(/, '').replace(/\)$/, '').trim();
    return /^[\d\s+\-*/().'"]+$/.test(arg) || /^\w+\s*\([\d\s,'"]+\)$/.test(arg);
}

// ─── File collection helpers ────────────────────────────────────────────────

const PRUNE_DIRS = new Set([
    'node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'out',
    'coverage', '.venv', 'venv', 'vendor', 'target', '.conventions',
]);

/** Find all test files in the workspace (relative paths). */
export function findTestFiles(workspacePath: string): string[] {
    const files: string[] = [];
    walkDir(workspacePath, workspacePath, (relPath) => {
        if (TEST_FILE_PATTERNS.some(re => re.test(relPath))) {
            files.push(relPath);
        }
    });
    return files;
}

/** Find all non-test source files (relative paths). */
function findSourceFiles(workspacePath: string): string[] {
    const SOURCE_EXTENSIONS = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    ]);
    const files: string[] = [];
    walkDir(workspacePath, workspacePath, (relPath) => {
        if (SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) {
            if (!TEST_FILE_PATTERNS.some(re => re.test(relPath))) {
                files.push(relPath);
            }
        }
    });
    return files;
}

/** Find all non-test source files for product entry graph (relative paths). */
export function findProductSourceFiles(workspacePath: string): string[] {
    const SOURCE_EXTENSIONS = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
        '.html', '.css', '.scss',
    ]);
    const files: string[] = [];
    walkDir(workspacePath, workspacePath, (relPath) => {
        if (SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase())) {
            if (!TEST_FILE_PATTERNS.some(re => re.test(relPath))) {
                files.push(relPath);
            }
        }
    });
    return files;
}

function walkDir(dir: string, root: string, callback: (relPath: string) => void): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
        if (PRUNE_DIRS.has(entry)) continue;
        const absPath = path.join(dir, entry);
        try {
            const stat = fs.statSync(absPath);
            if (stat.isDirectory()) {
                walkDir(absPath, root, callback);
            } else {
                callback(path.relative(root, absPath));
            }
        } catch {
            // skip
        }
    }
}

function findFilesMatchingGlob(dir: string, glob: string): string[] {
    const results: string[] = [];
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return results; }

    for (const entry of entries) {
        if (matchesProtectedGlob(entry, [glob])) {
            results.push(path.join(dir, entry));
        }
    }
    return results;
}

/** Count test/it blocks and skipped blocks in source content. */
export function countTestBlocks(content: string): { tests: number; skipped: number } {
    let tests = 0;
    let skipped = 0;

    TEST_BLOCK_RE.lastIndex = 0;
    while (TEST_BLOCK_RE.exec(content) !== null) tests++;

    SKIPPED_BLOCK_RE.lastIndex = 0;
    while (SKIPPED_BLOCK_RE.exec(content) !== null) skipped++;

    SKIPPED_ALT_RE.lastIndex = 0;
    while (SKIPPED_ALT_RE.exec(content) !== null) skipped++;

    return { tests, skipped };
}

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

// ─── Baseline persistence ───────────────────────────────────────────────────

/** Load a persisted config baseline from disk, or null if not found. */
export function loadBaseline(outputPath: string): ConfigBaseline | null {
    const filePath = path.join(outputPath, 'config-baseline.json');
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

/** Persist a config baseline to disk. */
export function saveBaseline(outputPath: string, baseline: ConfigBaseline): void {
    const filePath = path.join(outputPath, 'config-baseline.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2), 'utf-8');
    log.info(`Config baseline saved to ${filePath}`);
}

// ─── Tamper findings formatting ─────────────────────────────────────────────

/** Format tamper findings as a Markdown section for PR descriptions. */
export function tamperFindingsToMarkdown(findings: TamperFinding[]): string {
    if (findings.length === 0) return '';
    const lines = [
        '## Gate Integrity',
        '',
        '| Severity | Kind | File | Detail |',
        '|----------|------|------|--------|',
    ];
    for (const f of findings) {
        lines.push(`| ${f.severity.toUpperCase()} | ${f.kind} | \`${f.file}\` | ${f.detail} |`);
    }
    return lines.join('\n');
}
