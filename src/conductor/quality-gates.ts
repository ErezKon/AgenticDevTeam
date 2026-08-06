/**
 * Multi-language quality gates — deterministic build/lint/test verification.
 *
 * Replaces the npm-only `ensureDepsAndRunTests`: Java, Go, Python, C#/.NET,
 * Rust and Gradle projects previously received NO build, lint or test gate
 * at all (PART A6), leaving reviewers — who Plan 14 taught not to block on
 * anything below 'major' — as the only quality signal.
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
} from '../config';
import type { TestReport } from '../agents/_shared/schemas/testing.schema';
import type { Bug } from '../agents/_shared/schemas/bug.schema';

const log = getLogger('[QualityGates]', 220);

// ─── Types ──────────────────────────────────────────────────────────────────

export type StackKind = 'node' | 'maven' | 'gradle' | 'go' | 'python' | 'dotnet' | 'rust';
export type GateStep = 'install' | 'build' | 'lint' | 'test';

export interface GateResult {
    step: GateStep;
    command: string;
    passed: boolean;
    skipped: boolean;
    output: string;
    durationMs: number;
}

export interface GateReport {
    stacks: StackKind[];
    results: GateResult[];
    passed: boolean;
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

/**
 * Detect every stack present in `workspacePath`, by marker file.
 * A polyglot repo returns several.
 */
export function detectStacks(workspacePath: string): StackKind[] {
    const stacks: StackKind[] = [];
    let entries: string[];
    try {
        entries = fs.readdirSync(workspacePath);
    } catch {
        return [];
    }

    for (const [stack, markers] of STACK_MARKERS) {
        const found = markers.some(marker => {
            if (marker.startsWith('*')) {
                // Glob suffix match (e.g. *.csproj)
                const ext = marker.slice(1);
                return entries.some(e => e.endsWith(ext));
            }
            return entries.includes(marker);
        });
        if (found && !stacks.includes(stack)) {
            stacks.push(stack);
        }
    }
    return stacks;
}

// ─── Command table ──────────────────────────────────────────────────────────

/** The command table. Exported so tests can assert it without shelling out. */
export const GATE_COMMANDS: Record<StackKind, Partial<Record<GateStep, string>>> = {
    node: {
        install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
        build:   'npm run build --if-present',
        lint:    'npm run lint --if-present',
        test:    'npm test --silent',
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
        install: 'go mod download',
        build:   'go build ./...',
        lint:    'go vet ./...',
        test:    'go test ./...',
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

// ─── Main runner ────────────────────────────────────────────────────────────

/**
 * Run install/build/lint/test for every detected stack.
 *
 * Replaces the npm-only ensureDepsAndRunTests: Java, Go, Python and C#
 * projects previously received NO build, lint or test gate at all (PART A6),
 * leaving reviewers — who Plan 14 taught not to block on anything below
 * 'major' — as the only quality signal.
 */
export function runQualityGates(
    workspacePath: string,
    opts?: {
        steps?: GateStep[];
        timeoutMs?: number;
        installTimeoutMs?: number;
        exec?: ExecFn;
    },
): GateReport {
    if (!QUALITY_GATES_ENABLED) {
        log.info('Quality gates disabled (QUALITY_GATES_ENABLED=false)');
        return { stacks: [], results: [], passed: true };
    }

    const stacks = detectStacks(workspacePath);
    if (stacks.length === 0) {
        log.info('No recognized stacks detected — skipping quality gates');
        return { stacks: [], results: [], passed: true };
    }

    const steps = opts?.steps ?? QUALITY_GATE_STEPS;
    const timeoutMs = opts?.timeoutMs ?? QUALITY_GATE_TIMEOUT_MS;
    const installTimeoutMs = opts?.installTimeoutMs ?? timeoutMs;
    const exec = opts?.exec ?? defaultExec;
    const results: GateResult[] = [];

    log.info(`Quality gates: stacks=${stacks.join(',')} steps=${steps.join(',')}`);

    for (const stack of stacks) {
        const commands = GATE_COMMANDS[stack];
        const tool = TOOL_EXECUTABLES[stack];

        // Check if the tool is available
        const toolAvailable = isToolAvailable(tool, workspacePath, exec);
        if (!toolAvailable) {
            log.warn(`Toolchain for '${stack}' not found (${tool} not on PATH)`);
            for (const step of steps) {
                if (commands[step]) {
                    results.push({
                        step,
                        command: commands[step]!,
                        passed: !QUALITY_GATE_STRICT_TOOLCHAIN,
                        skipped: true,
                        output: `Toolchain '${tool}' not available`,
                        durationMs: 0,
                    });
                }
            }
            continue;
        }

        for (const step of steps) {
            let command = commands[step];
            if (!command) continue; // step not defined for this stack → skip silently

            // Python: adjust install command based on which marker file exists
            if (stack === 'python' && step === 'install') {
                command = getPythonInstallCommand(workspacePath);
            }

            // Skip install when the dependency dir already exists
            if (step === 'install') {
                const marker = INSTALL_SKIP_MARKERS[stack];
                if (marker && fs.existsSync(path.join(workspacePath, marker))) {
                    results.push({
                        step,
                        command,
                        passed: true,
                        skipped: true,
                        output: `Skipped: ${marker} already exists`,
                        durationMs: 0,
                    });
                    continue;
                }
            }

            const stepTimeout = step === 'install' ? installTimeoutMs : timeoutMs;
            const start = Date.now();
            try {
                const output = exec(command, { cwd: workspacePath, timeout: stepTimeout });
                results.push({
                    step,
                    command,
                    passed: true,
                    skipped: false,
                    output: (output ?? '').slice(-2000),
                    durationMs: Date.now() - start,
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
                });
            }
        }
    }

    // report.passed = no `failed` result among the executed steps
    const passed = results.every(r => r.passed || r.skipped);

    const report: GateReport = { stacks, results, passed };
    log.info(`Quality gates ${passed ? 'PASSED' : 'FAILED'}: ${results.filter(r => !r.skipped).length} executed, ${results.filter(r => !r.passed && !r.skipped).length} failed`);
    emitRunEvent('gate:result', { passed, stacks, executed: results.filter(r => !r.skipped).length, failed: results.filter(r => !r.passed && !r.skipped).length });
    return report;
}

// ─── GateReport → TestReport conversion ─────────────────────────────────────

/**
 * Convert a GateReport into a deterministic TestReport for ProjectState.
 *
 * Returns `null` for an all-skipped report (nothing was actually checked).
 */
export function gateReportToTestReport(report: GateReport, agentId: string): TestReport | null {
    const executed = report.results.filter(r => !r.skipped);
    if (executed.length === 0) return null;

    const failed = executed.filter(r => !r.passed);
    return {
        type: 'unit' as const,
        framework: 'quality-gates',
        total: executed.length,
        passed: executed.length - failed.length,
        failed: failed.length,
        skipped: report.results.filter(r => r.skipped).length,
        status: failed.length > 0 ? 'fail' as const : 'pass' as const,
        failures: failed.map(r => ({
            testName: `${r.step} (${r.command})`,
            error: r.output.slice(0, 500),
        })),
        agentId,
    };
}

// ─── GateReport → Bug synthesis ─────────────────────────────────────────────

/**
 * Synthesise a Bug per failing gate step so the Team Leader gets something
 * concrete to triage. Uses stable ids (`GATE-<stack>-<step>`) so
 * `dedupeBugs` (Sub-Plan 2) suppresses duplicates across iterations.
 */
export function synthesiseGateBugs(report: GateReport): Bug[] {
    const bugs: Bug[] = [];
    for (const r of report.results) {
        if (r.passed || r.skipped) continue;

        // Determine which stack this result belongs to
        // We need to figure out which stack the command belongs to
        let stackLabel = 'unknown';
        for (const stack of report.stacks) {
            const commands = GATE_COMMANDS[stack];
            if (commands[r.step] === r.command) {
                stackLabel = stack;
                break;
            }
        }

        const severity = (r.step === 'build' || r.step === 'test') ? 'critical' : 'major';
        bugs.push({
            id: `GATE-${stackLabel}-${r.step}`,
            title: `Quality gate failed: ${r.step} (${stackLabel})`,
            severity: severity as 'critical' | 'major',
            stepsToReproduce: `Run: ${r.command}`,
            expectedBehavior: `The ${r.step} step should pass`,
            actualBehavior: r.output.slice(0, 500),
            suspectedArea: `${stackLabel} ${r.step} configuration or source code`,
            reportedBy: 'quality-gates',
        });
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
    if (report.passed) {
        lines.push(':white_check_mark: **All quality gates passed.**\n');
    } else {
        lines.push(':warning: **Some quality gates failed.**\n');
    }
    lines.push('| Stack | Step | Status | Duration |');
    lines.push('|-------|------|--------|----------|');
    for (const r of report.results) {
        // Derive the stack from the command
        let stackLabel = '—';
        for (const stack of report.stacks) {
            const commands = GATE_COMMANDS[stack];
            if (commands[r.step] === r.command) {
                stackLabel = stack;
                break;
            }
        }
        const icon = r.skipped ? ':fast_forward:' : r.passed ? ':white_check_mark:' : ':x:';
        const status = r.skipped ? 'Skipped' : r.passed ? 'Passed' : 'Failed';
        const dur = r.durationMs > 0 ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
        lines.push(`| ${stackLabel} | ${r.step} | ${icon} ${status} | ${dur} |`);
    }

    // Show failing outputs
    const failures = report.results.filter(r => !r.passed && !r.skipped);
    if (failures.length > 0) {
        lines.push('');
        lines.push('<details><summary>Failure details</summary>\n');
        for (const f of failures) {
            lines.push(`**${f.step}** (\`${f.command}\`):\n\`\`\`\n${f.output.slice(0, 1000)}\n\`\`\`\n`);
        }
        lines.push('</details>');
    }

    return lines.join('\n');
}
