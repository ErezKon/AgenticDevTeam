/**
 * Multi-language quality gates — deterministic build/lint/test verification.
 *
 * Replaces the npm-only `ensureDepsAndRunTests`: Java, Go, Python, C#/.NET,
 * Rust and Gradle projects previously received NO build, lint or test gate
 * at all (PART A6), leaving reviewers — who Plan 14 taught not to block on
 * anything below 'major' — as the only quality signal.
 *
 * Plan 19-01 additions: multi-root stack detection, script resolver (no more
 * --if-present), typecheck step, honest aggregation with inconclusive state,
 * and ProductVerifyReport integration.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getLogger } from '../utils/logger';
import { emitRunEvent } from '../utils/event-bus';
import {
    QUALITY_GATES_ENABLED,
    QUALITY_GATE_STEPS,
    QUALITY_GATE_TIMEOUT_MS,
    QUALITY_GATE_STRICT_TOOLCHAIN,
    QUALITY_GATE_SCAN_DEPTH,
    QUALITY_GATE_MAX_ROOTS,
} from '../config';
import type { TestReport } from '../agents/_shared/schemas/testing.schema';
import type { Bug } from '../agents/_shared/schemas/bug.schema';
import type { ProductVerifyReport } from './product-verify';

const log = getLogger('[QualityGates]', 220);

// ─── Types ──────────────────────────────────────────────────────────────────

export type StackKind = 'node' | 'maven' | 'gradle' | 'go' | 'python' | 'dotnet' | 'rust';
export type GateStep = 'install' | 'typecheck' | 'build' | 'lint' | 'test';

export interface StackRoot {
    /** Absolute path of the directory containing the marker file. */
    dir: string;
    /** Path relative to the workspace root ('' for the root itself). */
    relDir: string;
    stack: StackKind;
    /** True when this root is a member of a detected workspace/monorepo (npm workspaces, pnpm, go work, maven modules). */
    isWorkspaceMember: boolean;
}

export type StepMode = 'real' | 'fallback' | 'absent';

export interface GateResult {
    step: GateStep;
    command: string;
    passed: boolean;
    skipped: boolean;
    output: string;
    durationMs: number;
    /** Relative directory this result pertains to ('' = workspace root). */
    relDir: string;
    /** How the command was resolved. */
    mode: StepMode;
    /** True when this step could not be meaningfully evaluated. */
    inconclusive: boolean;
}

export interface GateReport {
    stacks: StackKind[];
    roots: StackRoot[];
    results: GateResult[];
    passed: boolean;
    /** True when no step could be meaningfully evaluated (e.g. all absent/skipped). */
    inconclusive: boolean;
    productVerify?: ProductVerifyReport;
}

// ─── Stack detection ────────────────────────────────────────────────────────

/** Marker files that identify a stack. */
const STACK_MARKERS: [StackKind, string[]][] = [
    ['node',    ['package.json']],
    ['maven',   ['pom.xml']],
    ['gradle',  ['build.gradle', 'build.gradle.kts']],
    ['go',      ['go.mod']],
    ['python',  ['requirements.txt', 'pyproject.toml', 'setup.py']],
    ['dotnet',  ['*.csproj', '*.sln']],
    ['rust',    ['Cargo.toml']],
];

/** Directories to prune when scanning for stack roots. */
const PRUNE_DIRS = new Set([
    'node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'out',
    'coverage', '.venv', 'venv', 'vendor', 'target', '.conventions',
]);

/**
 * Check whether a directory contains markers for a given stack.
 */
function dirHasStack(dir: string, entries: string[], stack: StackKind, markers: string[]): boolean {
    return markers.some(marker => {
        if (marker.startsWith('*')) {
            const ext = marker.slice(1);
            return entries.some(e => e.endsWith(ext));
        }
        return entries.includes(marker);
    });
}

/**
 * Detect every stack root under `workspacePath`, walking up to
 * `QUALITY_GATE_SCAN_DEPTH` levels deep. Returns a `StackRoot` per
 * (directory, stack) pair — a polyglot monorepo produces several.
 */
export function detectStackRoots(workspacePath: string): StackRoot[] {
    const roots: StackRoot[] = [];
    const maxDepth = QUALITY_GATE_SCAN_DEPTH;
    const maxRoots = QUALITY_GATE_MAX_ROOTS;

    // Detect npm workspaces at root for tagging isWorkspaceMember
    const workspaceGlobs = detectNpmWorkspaceGlobs(workspacePath);

    function walk(dir: string, depth: number): void {
        if (roots.length >= maxRoots) return;
        if (depth > maxDepth) return;

        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            return;
        }

        const relDir = path.relative(workspacePath, dir) || '';

        for (const [stack, markers] of STACK_MARKERS) {
            if (dirHasStack(dir, entries, stack, markers)) {
                const isWorkspaceMember = relDir !== '' && isNpmWorkspaceMember(relDir, workspaceGlobs);
                roots.push({ dir, relDir, stack, isWorkspaceMember });
                if (roots.length >= maxRoots) {
                    log.warn(`Stack root scan capped at ${maxRoots} roots`);
                    return;
                }
            }
        }

        // Recurse into subdirectories
        for (const entry of entries) {
            if (PRUNE_DIRS.has(entry)) continue;
            const childPath = path.join(dir, entry);
            try {
                if (fs.statSync(childPath).isDirectory()) {
                    walk(childPath, depth + 1);
                }
            } catch {
                // stat failure — skip
            }
        }
    }

    walk(workspacePath, 0);
    return roots;
}

/**
 * Detect every stack present in `workspacePath`, by marker file.
 * A polyglot repo returns several.
 *
 * @deprecated Use `detectStackRoots` for multi-root detection. This wrapper
 * is kept for backward compatibility with `security-gates.ts` and tests.
 */
export function detectStacks(workspacePath: string): StackKind[] {
    const roots = detectStackRoots(workspacePath);
    const seen = new Set<StackKind>();
    const stacks: StackKind[] = [];
    for (const r of roots) {
        if (!seen.has(r.stack)) {
            seen.add(r.stack);
            stacks.push(r.stack);
        }
    }
    return stacks;
}

/**
 * Read npm workspace globs from a root package.json, if present.
 */
function detectNpmWorkspaceGlobs(workspacePath: string): string[] {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'));
        if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
        if (pkg.workspaces?.packages && Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
    } catch {
        // no package.json or parse error
    }
    return [];
}

/**
 * Check whether a relative directory matches one of the npm workspace globs.
 */
function isNpmWorkspaceMember(relDir: string, globs: string[]): boolean {
    for (const glob of globs) {
        // Handle "packages/*" style globs
        if (glob.endsWith('/*')) {
            const prefix = glob.slice(0, -2);
            const parts = relDir.split(path.sep);
            if (parts.length === 2 && parts[0] === prefix) return true;
        } else if (glob.endsWith('/**')) {
            const prefix = glob.slice(0, -3);
            if (relDir.startsWith(prefix + path.sep) || relDir === prefix) return true;
        } else if (relDir === glob) {
            return true;
        }
    }
    return false;
}

// ─── Command table ──────────────────────────────────────────────────────────

/** The command table. Exported so tests can assert it without shelling out. */
export const GATE_COMMANDS: Record<StackKind, Partial<Record<GateStep, string>>> = {
    node: {
        install:   'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
        typecheck: '<resolved at runtime>',
        build:     '<resolved at runtime>',
        lint:      '<resolved at runtime>',
        test:      '<resolved at runtime>',
    },
    maven: {
        build: 'mvn -B -q -DskipTests package',
        test:  'mvn -B test',
    },
    gradle: {
        build: './gradlew build -x test --no-daemon',
        test:  './gradlew test --no-daemon',
    },
    go: {
        install:   'go mod download',
        typecheck: 'go build ./...',
        build:     'go build ./...',
        lint:      'go vet ./...',
        test:      'go test ./...',
    },
    python: {
        install: 'pip install -r requirements.txt',
        test:    'python -m pytest -q',
    },
    dotnet: {
        install: 'dotnet restore',
        build:   'dotnet build --no-restore',
        test:    'dotnet test --no-build',
    },
    rust: {
        build: 'cargo build',
        lint:  'cargo clippy -- -D warnings',
        test:  'cargo test',
    },
};

// ─── Node script resolver ───────────────────────────────────────────────────

/**
 * Resolve the concrete command for a gate step from the target package.json.
 * Returns `{ command, mode }` where mode is:
 *   'real'    — a project script exists and will be executed
 *   'fallback'— no script; run a stack-default tool directly (still a real check)
 *   'absent'  — the step cannot be performed for this root
 */
export function resolveNodeStep(dir: string, step: GateStep): { command: string; mode: StepMode } {
    let pkg: any = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    } catch {
        // no package.json
    }
    const scripts = pkg.scripts ?? {};

    switch (step) {
        case 'install':
            return { command: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund', mode: 'real' };

        case 'typecheck': {
            if (scripts.typecheck) return { command: 'npm run typecheck', mode: 'real' };
            if (scripts['type-check']) return { command: 'npm run type-check', mode: 'real' };
            // Fallback: use tsc if tsconfig exists
            if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
                return { command: 'npx --no-install tsc --noEmit', mode: 'fallback' };
            }
            return { command: '', mode: 'absent' };
        }

        case 'build': {
            if (scripts.build) return { command: 'npm run build', mode: 'real' };
            // Fallback: check for bundler configs
            const bundlerConfigs = [
                { glob: 'vite.config', cmd: 'npx --no-install vite build' },
                { glob: 'webpack.config', cmd: 'npx --no-install webpack --mode production' },
                { glob: 'next.config', cmd: 'npx --no-install next build' },
                { glob: 'angular.json', cmd: 'npx --no-install ng build' },
                { glob: 'rollup.config', cmd: 'npx --no-install rollup -c' },
            ];
            for (const { glob, cmd } of bundlerConfigs) {
                const hasConfig = fs.readdirSync(dir).some(f => f.startsWith(glob));
                if (hasConfig) return { command: cmd, mode: 'fallback' };
            }
            // If there's a tsconfig but no bundler, typecheck is the build
            if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
                return { command: '', mode: 'absent' };
            }
            return { command: '', mode: 'absent' };
        }

        case 'lint': {
            if (scripts.lint) return { command: 'npm run lint', mode: 'real' };
            // Fallback: check for eslint config
            const eslintConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
            const hasEslint = eslintConfigs.some(f => fs.existsSync(path.join(dir, f)));
            if (hasEslint) return { command: 'npx --no-install eslint . --max-warnings=0', mode: 'fallback' };
            return { command: '', mode: 'absent' };
        }

        case 'test': {
            if (scripts.test) return { command: 'npm test', mode: 'real' };
            return { command: '', mode: 'absent' };
        }

        default:
            return { command: '', mode: 'absent' };
    }
}

// ─── Dependency-dir markers (skip install when already present) ─────────────

const INSTALL_SKIP_MARKERS: Partial<Record<StackKind, string>> = {
    node: 'node_modules',
    python: '.venv',
    go: 'vendor',
};

// ─── Tool executables per stack ─────────────────────────────────────────────

const TOOL_EXECUTABLES: Record<StackKind, string> = {
    node: 'npm',
    maven: 'mvn',
    gradle: './gradlew',
    go: 'go',
    python: 'python',
    dotnet: 'dotnet',
    rust: 'cargo',
};

// ─── Required steps for inconclusive detection ─────────────────────────────

const REQUIRED_STEPS = new Set<GateStep>(['build', 'test']);

// ─── Internal exec seam ────────────────────────────────────────────────────

type ExecFn = (cmd: string, opts: { cwd: string; timeout: number }) => string;

function defaultExec(cmd: string, opts: { cwd: string; timeout: number }): string {
    return execSync(cmd + ' 2>&1', {
        cwd: opts.cwd,
        encoding: 'utf-8',
        timeout: opts.timeout,
        maxBuffer: 1024 * 1024 * 5,
        env: { ...process.env, CI: 'true', NODE_ENV: 'test' },
    });
}

// ─── Tool availability check ────────────────────────────────────────────────

function isToolAvailable(tool: string, workspacePath: string, exec: ExecFn): boolean {
    // For ./gradlew, check file existence instead of which
    if (tool === './gradlew') {
        return fs.existsSync(path.join(workspacePath, 'gradlew'));
    }
    try {
        exec(`which ${tool}`, { cwd: workspacePath, timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}

// ─── Python install command adjustment ──────────────────────────────────────

function getPythonInstallCommand(workspacePath: string): string {
    if (fs.existsSync(path.join(workspacePath, 'requirements.txt'))) {
        return 'pip install -r requirements.txt';
    }
    return 'pip install -e .';
}

// ─── Install freshness check (D12 fix) ─────────────────────────────────────

/**
 * Check whether the installed dependency directory is fresh enough to skip
 * install. For node: skip only when node_modules/.package-lock.json exists
 * AND its mtime is newer than both package-lock.json and package.json.
 */
function shouldSkipInstall(stack: StackKind, dir: string): boolean {
    const marker = INSTALL_SKIP_MARKERS[stack];
    if (!marker) return false;
    const markerPath = path.join(dir, marker);
    if (!fs.existsSync(markerPath)) return false;

    if (stack === 'node') {
        const lockMarker = path.join(dir, 'node_modules', '.package-lock.json');
        if (!fs.existsSync(lockMarker)) return false;
        try {
            const lockMarkerMtime = fs.statSync(lockMarker).mtimeMs;
            const pkgJsonMtime = fs.existsSync(path.join(dir, 'package.json'))
                ? fs.statSync(path.join(dir, 'package.json')).mtimeMs : 0;
            const pkgLockMtime = fs.existsSync(path.join(dir, 'package-lock.json'))
                ? fs.statSync(path.join(dir, 'package-lock.json')).mtimeMs : 0;
            return lockMarkerMtime > pkgJsonMtime && lockMarkerMtime > pkgLockMtime;
        } catch {
            return false;
        }
    }

    // For python/go, keep old behaviour: just check directory exists
    return true;
}

// ─── Main runner ────────────────────────────────────────────────────────────

/**
 * Run install/typecheck/build/lint/test for every detected stack root.
 *
 * Plan 19-01: multi-root detection, script resolver for node (no --if-present),
 * typecheck step, honest aggregation with inconclusive state.
 */
export function runQualityGates(
    workspacePath: string,
    opts?: {
        steps?: GateStep[];
        timeoutMs?: number;
        installTimeoutMs?: number;
        exec?: ExecFn;
        productVerify?: ProductVerifyReport;
    },
): GateReport {
    if (!QUALITY_GATES_ENABLED) {
        log.info('Quality gates disabled (QUALITY_GATES_ENABLED=false)');
        return { stacks: [], roots: [], results: [], passed: true, inconclusive: false };
    }

    const roots = detectStackRoots(workspacePath);
    if (roots.length === 0) {
        log.info('No recognized stacks detected — skipping quality gates');
        return { stacks: [], roots: [], results: [], passed: true, inconclusive: true };
    }

    const stacks = [...new Set(roots.map(r => r.stack))];
    const steps = opts?.steps ?? QUALITY_GATE_STEPS;
    const timeoutMs = opts?.timeoutMs ?? QUALITY_GATE_TIMEOUT_MS;
    const installTimeoutMs = opts?.installTimeoutMs ?? timeoutMs;
    const exec = opts?.exec ?? defaultExec;
    const results: GateResult[] = [];

    log.info(`Quality gates: roots=${roots.length} stacks=${stacks.join(',')} steps=${steps.join(',')}`);

    // Determine if root has npm workspaces (for running workspace-aware builds)
    const rootWorkspaceGlobs = detectNpmWorkspaceGlobs(workspacePath);
    const hasNpmWorkspaces = rootWorkspaceGlobs.length > 0;

    // Track which workspace member roots to skip individual gating for
    const workspaceMemberDirs = new Set<string>();

    for (const root of roots) {
        const { dir, relDir, stack } = root;
        const commands = GATE_COMMANDS[stack];
        const tool = TOOL_EXECUTABLES[stack];

        // Check if the tool is available
        const toolAvailable = isToolAvailable(tool, dir, exec);
        if (!toolAvailable) {
            log.warn(`Toolchain for '${stack}' not found (${tool} not on PATH)`);
            for (const step of steps) {
                if (commands[step] || (stack === 'node' && step !== 'install')) {
                    results.push({
                        step,
                        command: commands[step] ?? `${tool} (unavailable)`,
                        passed: !QUALITY_GATE_STRICT_TOOLCHAIN,
                        skipped: true,
                        output: `Toolchain '${tool}' not available — cannot verify this stack`,
                        durationMs: 0,
                        relDir,
                        mode: 'absent',
                        inconclusive: true,
                    });
                }
            }
            continue;
        }

        // For npm workspace root that has workspaces: run workspace-aware commands
        // and skip individual member gating
        if (stack === 'node' && relDir === '' && hasNpmWorkspaces) {
            for (const memberRoot of roots) {
                if (memberRoot.isWorkspaceMember && memberRoot.stack === 'node') {
                    workspaceMemberDirs.add(memberRoot.dir);
                }
            }
        }

        // Skip workspace members if the root workspace handles them
        if (workspaceMemberDirs.has(dir)) continue;

        for (const step of steps) {
            let command: string;
            let mode: StepMode;

            if (stack === 'node') {
                const resolved = resolveNodeStep(dir, step);
                command = resolved.command;
                mode = resolved.mode;
            } else {
                const rawCmd = commands[step];
                if (!rawCmd) {
                    // Step not defined for this stack
                    if (REQUIRED_STEPS.has(step)) {
                        results.push({
                            step,
                            command: '',
                            passed: false,
                            skipped: false,
                            output: `Step '${step}' has no command for stack '${stack}'`,
                            durationMs: 0,
                            relDir,
                            mode: 'absent',
                            inconclusive: true,
                        });
                    }
                    continue;
                }
                command = rawCmd;
                mode = 'real';
            }

            // Handle absent steps
            if (mode === 'absent') {
                if (REQUIRED_STEPS.has(step)) {
                    results.push({
                        step,
                        command: '',
                        passed: false,
                        skipped: false,
                        output: `No '${step}' script/config found in ${relDir || '.'}`,
                        durationMs: 0,
                        relDir,
                        mode: 'absent',
                        inconclusive: true,
                    });
                }
                continue;
            }

            // Python: adjust install command based on which marker file exists
            if (stack === 'python' && step === 'install') {
                command = getPythonInstallCommand(dir);
            }

            // D12 fix: smarter install skip check
            if (step === 'install') {
                if (shouldSkipInstall(stack, dir)) {
                    results.push({
                        step,
                        command,
                        passed: true,
                        skipped: true,
                        output: 'Skipped: deps up to date',
                        durationMs: 0,
                        relDir,
                        mode: 'real',
                        inconclusive: false,
                    });
                    continue;
                }
            }

            const stepTimeout = step === 'install' ? installTimeoutMs : timeoutMs;
            const start = Date.now();
            try {
                const output = exec(command, { cwd: dir, timeout: stepTimeout });
                results.push({
                    step,
                    command,
                    passed: true,
                    skipped: false,
                    output: (output ?? '').slice(-2000),
                    durationMs: Date.now() - start,
                    relDir,
                    mode,
                    inconclusive: false,
                });
            } catch (err: any) {
                const output = (
                    err.stdout ?? err.stderr ?? err.message ?? ''
                ).toString().trim();
                results.push({
                    step,
                    command,
                    passed: false,
                    skipped: false,
                    output: output.slice(-2000),
                    durationMs: Date.now() - start,
                    relDir,
                    mode,
                    inconclusive: false,
                });
            }
        }
    }

    // ─── Aggregation ────────────────────────────────────────────────────
    // A gate report only "passes" when at least one step was really executed and
    // nothing that could be executed failed. Skipped/absent steps are NOT passes:
    // they are recorded as `inconclusive`, which callers must treat as not-green.
    const executed = results.filter(r => !r.skipped && r.mode !== 'absent');
    const passed = executed.length > 0 && executed.every(r => r.passed);
    const inconclusive = executed.length === 0 ||
        results.some(r => r.mode === 'absent' && REQUIRED_STEPS.has(r.step));

    const report: GateReport = {
        stacks, roots, results, passed, inconclusive,
        productVerify: opts?.productVerify,
    };
    log.info(`Quality gates ${passed ? 'PASSED' : 'FAILED'}: ${executed.length} executed, ${results.filter(r => !r.passed && !r.skipped).length} failed, inconclusive=${inconclusive}`);
    emitRunEvent('gate:result', { passed, inconclusive, stacks, roots: roots.length, executed: executed.length, failed: results.filter(r => !r.passed && !r.skipped).length });
    return report;
}

// ─── GateReport → TestReport conversion ─────────────────────────────────────

/**
 * Convert a GateReport into a deterministic TestReport for ProjectState.
 *
 * Never returns `null` — for an all-skipped/inconclusive report, returns a
 * report with `status: 'inconclusive'` so downstream routers can see it.
 */
export function gateReportToTestReport(report: GateReport, agentId: string): TestReport {
    const executed = report.results.filter(r => !r.skipped && r.mode !== 'absent');
    const failed = executed.filter(r => !r.passed);

    // Determine status
    let status: 'pass' | 'fail' | 'inconclusive';
    if (executed.length === 0) {
        status = 'inconclusive';
    } else if (failed.length > 0) {
        status = 'fail';
    } else if (report.inconclusive) {
        status = 'inconclusive';
    } else {
        status = 'pass';
    }

    // Only claim type='unit' and framework='quality-gates' when the test step
    // actually ran with a real runner
    const testStepRan = executed.some(r => r.step === 'test' && r.mode === 'real');

    return {
        type: 'unit' as const,
        framework: testStepRan ? 'quality-gates' : 'quality-gates-build-only',
        total: executed.length,
        passed: executed.length - failed.length,
        failed: failed.length,
        skipped: report.results.filter(r => r.skipped).length,
        status,
        source: 'quality-gates' as const,
        iterationIndex: 0,
        runnerError: false,
        failures: failed.map(r => ({
            testName: `${r.step} (${r.command})${r.relDir ? ` [${r.relDir}]` : ''}`,
            error: r.output.slice(0, 500),
        })),
        agentId,
        cases: [],
    };
}

// ─── GateReport → Bug synthesis ─────────────────────────────────────────────

/**
 * Synthesise a Bug per failing gate step so the Team Leader gets something
 * concrete to triage. Uses stable ids (`GATE-<stack>-<step>`) so
 * `dedupeBugs` (Sub-Plan 2) suppresses duplicates across iterations.
 *
 * Also synthesises bugs from ProductVerifyReport when present.
 */
export function synthesiseGateBugs(report: GateReport): Bug[] {
    const bugs: Bug[] = [];

    // Gate step failures
    for (const r of report.results) {
        if (r.passed || r.skipped) continue;
        if (r.mode === 'absent') continue; // absent steps are inconclusive, not bugs

        // Determine which stack this result belongs to
        let stackLabel = 'unknown';
        for (const root of report.roots) {
            if (root.relDir === r.relDir) {
                stackLabel = root.stack;
                break;
            }
        }
        // Fallback: try old command-matching approach
        if (stackLabel === 'unknown') {
            for (const stack of report.stacks) {
                const commands = GATE_COMMANDS[stack];
                if (commands[r.step] === r.command) {
                    stackLabel = stack;
                    break;
                }
            }
        }

        const dirSuffix = r.relDir ? ` [${r.relDir}]` : '';
        const severity = (r.step === 'build' || r.step === 'test' || r.step === 'typecheck') ? 'critical' : 'major';
        bugs.push({
            id: `GATE-${stackLabel}-${r.step}${r.relDir ? `-${r.relDir.replace(/\//g, '-')}` : ''}`,
            title: `Quality gate failed: ${r.step} (${stackLabel})${dirSuffix}`,
            severity: severity as 'critical' | 'major',
            stepsToReproduce: `Run: ${r.command} in ${r.relDir || '.'}`,
            expectedBehavior: `The ${r.step} step should pass`,
            actualBehavior: r.output.slice(0, 500),
            suspectedArea: `${stackLabel} ${r.step} configuration or source code`,
            reportedBy: 'quality-gates',
        });
    }

    // Product verification failures
    if (report.productVerify) {
        const pv = report.productVerify;

        // Artifact check failures
        for (const ac of pv.artifacts) {
            if (!ac.passed) {
                bugs.push({
                    id: `PRODUCT-ARTIFACTS-${ac.root || 'root'}`,
                    title: `Build produced no artifacts: ${ac.root || '.'}`,
                    severity: 'critical',
                    stepsToReproduce: `Run build in ${ac.root || '.'} and check for output in ${ac.expectedDirs.join(', ')}`,
                    expectedBehavior: `Build should produce artifacts in ${ac.expectedDirs.join(' or ')}`,
                    actualBehavior: ac.reason,
                    suspectedArea: `build configuration in ${ac.root || '.'}`,
                    reportedBy: 'product-verify',
                });
            }
        }

        // Unresolved references
        if (pv.resolveIssues.length > 0) {
            const issueList = pv.resolveIssues.slice(0, 10)
                .map(i => `${i.file}:${i.line} → '${i.specifier}' (${i.reason})`)
                .join('\n');
            bugs.push({
                id: 'PRODUCT-RESOLVE',
                title: `${pv.resolveIssues.length} unresolved import(s)/reference(s)`,
                severity: 'critical',
                stepsToReproduce: 'Check import/require/src/href paths in source files',
                expectedBehavior: 'All imports and references should resolve to existing files or packages',
                actualBehavior: issueList,
                suspectedArea: 'source file imports and asset references',
                reportedBy: 'product-verify',
            });
        }

        // Smoke test failure
        if (pv.smoke && !pv.smoke.passed) {
            bugs.push({
                id: 'PRODUCT-SMOKE',
                title: 'Smoke test failed: app does not serve or render',
                severity: 'critical',
                stepsToReproduce: 'Build the app and serve it, then access the root URL',
                expectedBehavior: 'App should serve and return meaningful content',
                actualBehavior: pv.smoke.reason,
                suspectedArea: 'build output, entry HTML, or referenced assets',
                reportedBy: 'product-verify',
            });
        }
    }

    return bugs;
}

// ─── GateReport → PR description summary ────────────────────────────────────

/**
 * Format a GateReport as a markdown table suitable for a PR description.
 */
export function gateReportToMarkdown(report: GateReport): string {
    if (report.results.length === 0) {
        return ':grey_question: No quality gates executed.';
    }

    const lines: string[] = [];
    if (report.passed && !report.inconclusive) {
        lines.push(':white_check_mark: **All quality gates passed.**\n');
    } else if (report.inconclusive) {
        lines.push(':grey_question: **Quality gates inconclusive** — some steps could not be evaluated.\n');
    } else {
        lines.push(':warning: **Some quality gates failed.**\n');
    }
    lines.push('| Dir | Stack | Step | Mode | Status | Duration |');
    lines.push('|-----|-------|------|------|--------|----------|');
    for (const r of report.results) {
        // Derive the stack from the roots
        let stackLabel = '—';
        for (const root of report.roots) {
            if (root.relDir === r.relDir) {
                stackLabel = root.stack;
                break;
            }
        }
        // Fallback: try old command-matching approach
        if (stackLabel === '—') {
            for (const stack of report.stacks) {
                const commands = GATE_COMMANDS[stack];
                if (commands[r.step] === r.command) {
                    stackLabel = stack;
                    break;
                }
            }
        }
        const icon = r.skipped ? ':fast_forward:' : r.mode === 'absent' ? ':grey_question:' : r.passed ? ':white_check_mark:' : ':x:';
        const status = r.skipped ? 'Skipped' : r.mode === 'absent' ? 'Absent' : r.passed ? 'Passed' : 'Failed';
        const dur = r.durationMs > 0 ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
        const dirLabel = r.relDir || '.';
        lines.push(`| ${dirLabel} | ${stackLabel} | ${r.step} | ${r.mode} | ${icon} ${status} | ${dur} |`);
    }

    // Show failing outputs
    const failures = report.results.filter(r => !r.passed && !r.skipped && r.mode !== 'absent');
    if (failures.length > 0) {
        lines.push('');
        lines.push('<details><summary>Failure details</summary>\n');
        for (const f of failures) {
            lines.push(`**${f.step}** (\`${f.command}\`)${f.relDir ? ` [${f.relDir}]` : ''}:\n\`\`\`\n${f.output.slice(0, 1000)}\n\`\`\`\n`);
        }
        lines.push('</details>');
    }

    // Product verification section
    if (report.productVerify) {
        const pv = report.productVerify;
        lines.push('');
        lines.push('### Product verification');
        lines.push('');

        if (pv.artifacts.length > 0) {
            lines.push('**Artifacts:**');
            for (const ac of pv.artifacts) {
                const icon = ac.passed ? ':white_check_mark:' : ':x:';
                lines.push(`- ${icon} ${ac.root || '.'}: ${ac.reason}`);
            }
        }

        if (pv.resolveIssues.length > 0) {
            lines.push(`\n**Unresolved references:** ${pv.resolveIssues.length} issue(s)`);
            for (const issue of pv.resolveIssues.slice(0, 10)) {
                lines.push(`- \`${issue.file}:${issue.line}\` → \`${issue.specifier}\` (${issue.reason})`);
            }
            if (pv.resolveIssues.length > 10) {
                lines.push(`- ... and ${pv.resolveIssues.length - 10} more`);
            }
        }

        if (pv.smoke) {
            const smokeIcon = pv.smoke.passed ? ':white_check_mark:' : pv.smoke.ran ? ':x:' : ':fast_forward:';
            lines.push(`\n**Smoke test:** ${smokeIcon} ${pv.smoke.reason}`);
        }
    }

    return lines.join('\n');
}
