/**
 * Deterministic test runner — executes real test suites and parses their output.
 *
 * Sub-Plan 09: QA's claim becomes irrelevant; the runner's output is the truth.
 * Supports Jest (--json), Karma (agentjson reporter, test-runners/karma.ts),
 * Vitest, Mocha, pytest (JUnit XML), Maven, Gradle, Go (JSON), dotnet (TRX),
 * and Rust (summary parse).
 *
 * Machine-readable output first. Plan 30-03: runner output is rendered
 * (`renderTerminalOutput`) before anything reads it; it is a labelled fallback
 * for Karma (`caseNames: 'unavailable'`) and the whole result for a runner we
 * cannot ask for a report (framework `unknown`: exit code plus the summary).
 * Node dependencies are installed before the suite runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger';
import { safeChildEnv, execCapture } from '../utils/shell-exec';
import { renderTerminalOutput, summariseTestOutput } from '../utils/terminal-output';
import { GATE_COMMANDS, shouldSkipInstall, type StackRoot } from './quality-gates';
import { isKarmaProject, prepareKarmaRun, readKarmaRun } from './test-runners/karma';
import {
    parseTraceTag, tallyCases,
    type ExecutedTestCase, type ExecutedTestReport, type ParsedRun,
} from './test-runners/executed-report';

const log = getLogger('[TestRunner]', 199);

/** Rendered output kept in a runner-error detail (it becomes the QA-runner-error bug's evidence). */
const RUNNER_DETAIL_CHARS = 1500;

// ─── Jest JSON parsing ──────────────────────────────────────────────────────

interface JestJsonResult {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
    success: boolean;
    testResults: Array<{
        testFilePath: string;
        testResults: Array<{
            ancestorTitles: string[];
            title: string;
            status: 'passed' | 'failed' | 'pending' | 'skipped';
            duration: number | null;
            failureMessages: string[];
        }>;
    }>;
}

export function parseJestJson(raw: string, root: string): ParsedRun {
    const data: JestJsonResult = JSON.parse(raw);
    const cases: ExecutedTestCase[] = [];

    for (const suite of data.testResults) {
        const relFile = path.relative(root, suite.testFilePath) || suite.testFilePath;
        for (const tc of suite.testResults) {
            const fullName = [...tc.ancestorTitles, tc.title].join(' > ');
            const tag = parseTraceTag(tc.title) || parseTraceTag(fullName);
            const status: 'pass' | 'fail' | 'skip' =
                tc.status === 'passed' ? 'pass' :
                tc.status === 'failed' ? 'fail' : 'skip';
            cases.push({
                testName: fullName,
                suite: tc.ancestorTitles.join(' > ') || relFile,
                file: relFile,
                status,
                durationMs: tc.duration ?? 0,
                error: tc.failureMessages.length > 0 ? tc.failureMessages.join('\n').slice(0, 2000) : undefined,
                ...(tag ? { storyId: tag.storyId, acIndex: tag.acIndex } : {}),
            });
        }
    }

    const untraced = cases.filter(c => !c.storyId && c.status !== 'skip');
    return {
        framework: 'jest',
        root,
        total: data.numTotalTests,
        passed: data.numPassedTests,
        failed: data.numFailedTests,
        skipped: data.numPendingTests,
        cases,
        untracedTests: untraced.length,
        untracedTestNames: untraced.slice(0, 10).map(c => c.testName),
    };
}

// ─── JUnit XML parsing ──────────────────────────────────────────────────────

/**
 * Lightweight JUnit XML parser (no xml2js dependency).
 *
 * Handles both `<testsuite>` (single) and `<testsuites>` (wrapper) formats.
 * Used for pytest, mocha, vitest (--reporter=junit), Maven surefire, Gradle.
 */
export function parseJunitXml(xml: string, root: string, framework: string): ParsedRun {
    const cases: ExecutedTestCase[] = [];
    // Match all <testcase ...>...</testcase> or self-closing <testcase ... />
    const testcaseRe = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let match;

    while ((match = testcaseRe.exec(xml)) !== null) {
        const attrs = match[1];
        const body = match[2] || '';

        const name = extractAttr(attrs, 'name') || 'unknown';
        const className = extractAttr(attrs, 'classname') || '';
        const file = extractAttr(attrs, 'file') || className;
        const time = parseFloat(extractAttr(attrs, 'time') || '0');

        // Determine status from body content
        let status: 'pass' | 'fail' | 'skip' = 'pass';
        let error: string | undefined;
        if (/<failure\b/.test(body) || /<error\b/.test(body)) {
            status = 'fail';
            const errMatch = /<(?:failure|error)[^>]*(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/(?:failure|error)>/.exec(body);
            error = (errMatch?.[1] || errMatch?.[2] || '').trim().slice(0, 2000) || undefined;
        } else if (/<skipped\b/.test(body)) {
            status = 'skip';
        }

        const tag = parseTraceTag(name);
        cases.push({
            testName: name,
            suite: className || file,
            file,
            status,
            durationMs: Math.round(time * 1000),
            error,
            ...(tag ? { storyId: tag.storyId, acIndex: tag.acIndex } : {}),
        });
    }

    return tallyCases(framework, root, cases);
}

// ─── Go test JSON parsing ───────────────────────────────────────────────────

interface GoTestEvent {
    Time?: string;
    Action: 'run' | 'output' | 'pass' | 'fail' | 'skip' | 'pause' | 'cont' | 'bench' | 'start';
    Package?: string;
    Test?: string;
    Elapsed?: number;
    Output?: string;
}

export function parseGoTestJson(raw: string, root: string): ParsedRun {
    const lines = raw.trim().split('\n').filter(Boolean);
    const cases: ExecutedTestCase[] = [];
    const testOutputs = new Map<string, string[]>();

    for (const line of lines) {
        let ev: GoTestEvent;
        try { ev = JSON.parse(line); } catch { continue; }

        const key = `${ev.Package || ''}::${ev.Test || ''}`;
        if (ev.Action === 'output' && ev.Test) {
            const arr = testOutputs.get(key) || [];
            arr.push(ev.Output || '');
            testOutputs.set(key, arr);
        }

        if (!ev.Test) continue; // Package-level events
        if (ev.Action !== 'pass' && ev.Action !== 'fail' && ev.Action !== 'skip') continue;

        const tag = parseTraceTag(ev.Test);
        const status: 'pass' | 'fail' | 'skip' = ev.Action;
        const failOutput = status === 'fail' ? (testOutputs.get(key) || []).join('').slice(0, 2000) : undefined;

        cases.push({
            testName: ev.Test,
            suite: ev.Package || '',
            file: ev.Package || '',
            status,
            durationMs: Math.round((ev.Elapsed ?? 0) * 1000),
            error: failOutput,
            ...(tag ? { storyId: tag.storyId, acIndex: tag.acIndex } : {}),
        });
    }

    return tallyCases('go', root, cases);
}

// ─── Coverage parsing ───────────────────────────────────────────────────────

/** Parse Jest/Vitest `coverage/coverage-summary.json`. */
export function parseCoverageSummary(raw: string): ExecutedTestReport['coverage'] | undefined {
    try {
        const data = JSON.parse(raw);
        const total = data.total;
        if (!total) return undefined;
        return {
            lines: total.lines?.pct ?? 0,
            statements: total.statements?.pct ?? 0,
            branches: total.branches?.pct ?? 0,
            functions: total.functions?.pct ?? 0,
        };
    } catch {
        return undefined;
    }
}

// ─── Runner error detection ─────────────────────────────────────────────────

const RUNNER_ERROR_PATTERNS = [
    /Cannot find module/,
    /Module not found/,
    /SyntaxError/,
    /Your test suite must contain at least one test/,
    /Configuration error/,
    /Could not locate module/,
    /Error: Cannot resolve/,
    /jest-haste-map: Haste module naming collision/,
    /Cannot read config file/,
    /TypeError: .* is not a function/,
    /ReferenceError:/,
    /ENOENT.*jest\.config/,
    /ENOENT.*vitest\.config/,
    /ENOENT.*tsconfig/,
];

/** Detect if stderr/stdout indicates the runner itself failed (not a test failure). */
export function isRunnerError(output: string): boolean {
    return RUNNER_ERROR_PATTERNS.some(re => re.test(output));
}

// ─── Run tests for a single stack root ──────────────────────────────────────

export interface RunTestsOptions {
    timeoutMs: number;
    withCoverage: boolean;
    reportDir: string;
}

/** Installs and suites run in CI mode without colour (the output is rendered anyway). */
const TEST_ENV = { CI: 'true', FORCE_COLOR: '0', NODE_ENV: 'test' };

/** Run a shell command in `cwd`; resolves (never rejects) with stdout, the combined output and the exit code. */
async function execCommand(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; output: string; exitCode: number }> {
    const r = await execCapture(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: safeChildEnv(TEST_ENV) });
    return { stdout: r.stdout, output: `${r.stdout}\n${r.stderr}`, exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1 };
}

/** `sh: 1: ng: not found` / `sh: ng: command not found` → `ng` (else the command's first word). */
function missingBinary(output: string, command: string): string {
    return /(\S+): (?:command )?not found/.exec(output)?.[1] ?? command.split(/\s+/)[0];
}

/**
 * Execute the test suite for a single stack root and parse the results.
 *
 * Returns an `ExecutedTestReport` — the authoritative test signal.
 */
export async function runTests(root: StackRoot, opts: RunTestsOptions): Promise<ExecutedTestReport> {
    const { timeoutMs, withCoverage, reportDir } = opts;
    const rootDir = root.dir;
    const label = root.relDir || '.';

    // Determine the test command and framework
    const { command: baseCommand, framework, script } = resolveTestCommand(rootDir, root.stack);
    if (!baseCommand) {
        log.info(`No test command found for ${label} (${root.stack})`);
        return emptyReport(root.relDir, '', 'no-test-command');
    }

    // Ensure report directory exists
    const rootReportDir = path.join(reportDir, root.relDir.replace(/\//g, '-') || 'root');
    fs.mkdirSync(rootReportDir, { recursive: true });

    /** No usable result: the exact command, a headline and the rendered output summary (Plan 30-03 step 7). */
    const runnerError = (command: string, exitCode: number, headline: string, rendered: string): ExecutedTestReport => {
        log.warn(`Runner error in ${label}: ${headline}`);
        const detail = `${headline}\n${summariseTestOutput(rendered, RUNNER_DETAIL_CHARS)}`;
        return { ...emptyReport(root.relDir, command, detail), framework, exitCode, runnerError: true };
    };

    // Plan 30-03 step 4: dependencies first — the claudeopus5 QA run reached `ng test` without node_modules (exit 127).
    // A workspace member is installed by its workspace root, as in the quality gates.
    if (root.stack === 'node' && !root.isWorkspaceMember && !shouldSkipInstall('node', rootDir)) {
        const install = GATE_COMMANDS.node.install!;
        log.info(`Installing dependencies in ${label} before its test run`);
        const installed = await execCommand(install, rootDir, timeoutMs);
        if (installed.exitCode !== 0) {
            return runnerError(install, installed.exitCode, `dependency install failed (exit ${installed.exitCode})`, renderTerminalOutput(installed.output));
        }
    }

    // Build the runner command with machine-readable output flags
    const karma = framework === 'karma'
        ? prepareKarmaRun({ rootDir, testScript: script ?? '', reportDir: rootReportDir, withCoverage })
        : null;
    const command = karma?.command ?? buildRunnerCommand(baseCommand, framework, rootReportDir, withCoverage);
    log.info(`Running tests in ${label}: ${command.slice(0, 200)}`);
    const { stdout, output, exitCode } = await execCommand(command, rootDir, timeoutMs);
    const rendered = renderTerminalOutput(output);
    const fail = (headline: string): ExecutedTestReport => runnerError(command, exitCode, headline, rendered);
    const unmeasured = (why: string): ExecutedTestReport => ({
        ...emptyReport(root.relDir, command, `${why}\n${summariseTestOutput(rendered, RUNNER_DETAIL_CHARS)}`),
        framework, caseNames: 'unavailable',
    });
    const coverage = (): ExecutedTestReport['coverage'] => (withCoverage ? tryParseCoverage(rootDir, rootReportDir) : undefined);

    if (exitCode === 127) return fail(`command not found: ${missingBinary(rendered, command)} — dependencies not installed?`);

    // Karma: the agentjson report, else the totals in the rendered output (Plan 30-03 step 3).
    if (karma) {
        const parsed = readKarmaRun(karma, rendered, root.relDir);
        if (exitCode !== 0 && !parsed?.failed) return fail(`\`${command}\` exited ${exitCode} without a failing spec`);
        if (!parsed) return unmeasured('exit 0, but the output has no Karma totals');
        return { ...parsed, command, exitCode, runnerError: false, coverage: coverage() };
    }

    // No report to ask for: the exit code and the rendered summary are the result (Plan 30-03 step 2).
    if (framework === 'unknown') {
        return exitCode !== 0 ? fail(`\`${command}\` exited ${exitCode}`) : unmeasured('exit 0; this runner has no machine-readable report');
    }

    // Check for runner error (config error, missing dep)
    if (exitCode !== 0 && isRunnerError(rendered)) return fail(`the runner could not start the suite (exit ${exitCode})`);

    // Parse results from the machine-readable output
    const parsed = parseRunnerOutput(framework, rootReportDir, rootDir, stdout);
    if (parsed) return { ...parsed, root: root.relDir, command, exitCode, runnerError: false, coverage: coverage() };

    // Fallback: no machine-readable output found
    if (exitCode === 0 && !stdout.trim()) return emptyReport(root.relDir, command, 'no-output');
    // Try to detect "no tests found" vs real failure
    if (/No tests found/i.test(rendered) || /exiting with code 1/i.test(rendered)) {
        return { ...emptyReport(root.relDir, command, 'no-tests-found'), framework, exitCode };
    }
    if (exitCode !== 0) return fail(`could not parse the runner output (exit ${exitCode})`);
    return { ...emptyReport(root.relDir, command, 'could not parse the runner output (exit 0)'), framework };
}

// ─── Test command resolution ────────────────────────────────────────────────

export interface PackageJson {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    jest?: unknown;
}

function resolveTestCommand(rootDir: string, stack: string): { command: string | null; framework: string; script?: string } {
    if (stack === 'node') {
        const pkgPath = path.join(rootDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const testScript = pkg.scripts?.test;
                if (testScript && !/no test specified|exit 1/.test(testScript)) {
                    return { command: 'npm test', framework: detectNodeFramework(testScript, rootDir, pkg), script: testScript };
                }
            } catch { /* ignore parse errors */ }
        }
        return { command: null, framework: 'unknown' };
    }
    if (stack === 'python') {
        return { command: 'python -m pytest', framework: 'pytest' };
    }
    if (stack === 'maven') {
        return { command: 'mvn -B test', framework: 'maven' };
    }
    if (stack === 'gradle') {
        const gradlew = path.join(rootDir, 'gradlew');
        const cmd = fs.existsSync(gradlew) ? './gradlew test' : 'gradle test';
        return { command: cmd, framework: 'gradle' };
    }
    if (stack === 'go') {
        return { command: 'go test ./...', framework: 'go' };
    }
    if (stack === 'dotnet') {
        return { command: 'dotnet test', framework: 'dotnet' };
    }
    if (stack === 'rust') {
        return { command: 'cargo test', framework: 'rust' };
    }
    return { command: null, framework: 'unknown' };
}

const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'];
const JEST_CONFIGS = ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json'];

/**
 * The framework behind a package's `test` script. Plan 30-03 step 2: Jest only when
 * Jest is really there (the script, a dependency, a `jest` key or a config file) —
 * Jest was the default, so the claudeopus5 Karma project ran with Jest flags. A
 * script we cannot ask for a machine-readable report is `unknown`.
 */
export function detectNodeFramework(testScript: string, rootDir: string, pkg: PackageJson): string {
    if (/vitest/i.test(testScript)) return 'vitest';
    if (/mocha/i.test(testScript)) return 'mocha';
    if (/\bjest\b|react-scripts\s+test|craco\s+test/i.test(testScript)) return 'jest';
    if (isKarmaProject(testScript, rootDir)) return 'karma';
    const hasFile = (names: string[]): boolean => names.some(name => fs.existsSync(path.join(rootDir, name)));
    if (hasFile(VITEST_CONFIGS)) return 'vitest';
    if (pkg.jest || 'jest' in { ...pkg.dependencies, ...pkg.devDependencies } || hasFile(JEST_CONFIGS)) return 'jest';
    return 'unknown';
}

// ─── Runner command construction ────────────────────────────────────────────

function buildRunnerCommand(
    baseCommand: string,
    framework: string,
    reportDir: string,
    withCoverage: boolean,
): string {
    const jsonOut = path.join(reportDir, 'jest-results.json');
    const junitOut = path.join(reportDir, 'junit.xml');

    switch (framework) {
        case 'jest':
            return [
                baseCommand,
                '-- --ci --json',
                `--outputFile=${jsonOut}`,
                withCoverage ? '--coverage --coverageReporters=json-summary' : '',
            ].filter(Boolean).join(' ');

        case 'vitest':
            return [
                baseCommand,
                '-- --run --reporter=junit',
                `--outputFile=${junitOut}`,
                withCoverage ? '--coverage' : '',
            ].filter(Boolean).join(' ');

        case 'mocha':
            return [
                baseCommand,
                `-- --reporter xunit --reporter-option output=${junitOut}`,
            ].join(' ');

        case 'pytest':
            return [
                baseCommand,
                '-q',
                `--junitxml=${junitOut}`,
                withCoverage ? '--cov --cov-report=json' : '',
            ].filter(Boolean).join(' ');

        case 'maven':
            return `${baseCommand} -Dmaven.test.failure.ignore=true`;

        case 'gradle':
            return baseCommand;

        case 'go':
            return [
                'go test ./... -json',
                withCoverage ? '-cover' : '',
            ].filter(Boolean).join(' ');

        case 'dotnet':
            return `${baseCommand} --logger "trx;LogFileName=${path.join(reportDir, 'results.trx')}"`;

        case 'rust':
            return `${baseCommand} -- -Z unstable-options --format json 2>/dev/null || ${baseCommand}`;

        default:
            return baseCommand;
    }
}

// ─── Runner output parsing ──────────────────────────────────────────────────

function parseRunnerOutput(
    framework: string,
    reportDir: string,
    rootDir: string,
    stdout: string,
): ParsedRun | null {
    switch (framework) {
        case 'jest': {
            // Try JSON file first, then stdout
            const jsonPath = path.join(reportDir, 'jest-results.json');
            let raw: string | null = null;
            if (fs.existsSync(jsonPath)) {
                raw = fs.readFileSync(jsonPath, 'utf-8');
            } else if (stdout.trim().startsWith('{')) {
                raw = stdout;
            }
            if (!raw) return null;
            try {
                return parseJestJson(raw, rootDir);
            } catch (err: any) {
                log.warn(`Failed to parse Jest JSON: ${err.message}`);
                return null;
            }
        }

        case 'vitest':
        case 'mocha':
        case 'pytest': {
            const junitPath = path.join(reportDir, 'junit.xml');
            if (!fs.existsSync(junitPath)) return null;
            try {
                const xml = fs.readFileSync(junitPath, 'utf-8');
                return parseJunitXml(xml, rootDir, framework);
            } catch (err: any) {
                log.warn(`Failed to parse JUnit XML: ${err.message}`);
                return null;
            }
        }

        case 'maven': {
            // Parse surefire reports
            const surefireDir = path.join(rootDir, 'target', 'surefire-reports');
            if (!fs.existsSync(surefireDir)) return null;
            try {
                const xmlFiles = fs.readdirSync(surefireDir).filter(f => f.endsWith('.xml'));
                const combined = xmlFiles.map(f =>
                    fs.readFileSync(path.join(surefireDir, f), 'utf-8')
                ).join('\n');
                return parseJunitXml(combined, rootDir, 'maven');
            } catch (err: any) {
                log.warn(`Failed to parse Maven surefire: ${err.message}`);
                return null;
            }
        }

        case 'gradle': {
            const testResultsDir = path.join(rootDir, 'build', 'test-results', 'test');
            if (!fs.existsSync(testResultsDir)) return null;
            try {
                const xmlFiles = fs.readdirSync(testResultsDir).filter(f => f.endsWith('.xml'));
                const combined = xmlFiles.map(f =>
                    fs.readFileSync(path.join(testResultsDir, f), 'utf-8')
                ).join('\n');
                return parseJunitXml(combined, rootDir, 'gradle');
            } catch (err: any) {
                log.warn(`Failed to parse Gradle results: ${err.message}`);
                return null;
            }
        }

        case 'go': {
            if (!stdout.trim()) return null;
            try {
                return parseGoTestJson(stdout, rootDir);
            } catch (err: any) {
                log.warn(`Failed to parse Go test JSON: ${err.message}`);
                return null;
            }
        }

        case 'dotnet': {
            const trxPath = path.join(reportDir, 'results.trx');
            if (!fs.existsSync(trxPath)) return null;
            try {
                const xml = fs.readFileSync(trxPath, 'utf-8');
                return parseDotnetTrx(xml, rootDir);
            } catch (err: any) {
                log.warn(`Failed to parse dotnet TRX: ${err.message}`);
                return null;
            }
        }

        default:
            return null;
    }
}

// ─── dotnet TRX parsing ─────────────────────────────────────────────────────

function parseDotnetTrx(xml: string, root: string): ParsedRun {
    const cases: ExecutedTestCase[] = [];
    const testRe = /<UnitTestResult\s+([^>]*)\/?>(?:([\s\S]*?)<\/UnitTestResult>)?/g;
    let match;

    while ((match = testRe.exec(xml)) !== null) {
        const attrs = match[1];
        const body = match[2] || '';

        const name = extractAttr(attrs, 'testName') || 'unknown';
        const outcome = extractAttr(attrs, 'outcome') || 'Passed';
        const duration = extractAttr(attrs, 'duration') || '00:00:00';

        let status: 'pass' | 'fail' | 'skip' = 'pass';
        let error: string | undefined;
        if (outcome === 'Failed') {
            status = 'fail';
            const errMatch = /<Message>([\s\S]*?)<\/Message>/.exec(body);
            error = errMatch?.[1]?.trim().slice(0, 2000);
        } else if (outcome === 'NotExecuted' || outcome === 'Inconclusive') {
            status = 'skip';
        }

        // Parse duration "00:00:01.234" → ms
        const dParts = duration.split(':');
        const seconds = parseFloat(dParts[dParts.length - 1] || '0');
        const minutes = parseInt(dParts[dParts.length - 2] || '0', 10);
        const hours = parseInt(dParts[dParts.length - 3] || '0', 10);
        const durationMs = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);

        const tag = parseTraceTag(name);
        cases.push({
            testName: name,
            suite: '',
            file: '',
            status,
            durationMs,
            error,
            ...(tag ? { storyId: tag.storyId, acIndex: tag.acIndex } : {}),
        });
    }

    return tallyCases('dotnet', root, cases);
}

// ─── Coverage resolution ────────────────────────────────────────────────────

function tryParseCoverage(rootDir: string, reportDir: string): ExecutedTestReport['coverage'] | undefined {
    // Jest/Vitest coverage-summary.json
    const candidates = [
        path.join(rootDir, 'coverage', 'coverage-summary.json'),
        path.join(reportDir, 'coverage-summary.json'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                return parseCoverageSummary(fs.readFileSync(p, 'utf-8'));
            } catch { /* ignore */ }
        }
    }
    // pytest coverage.json
    const pytestCov = path.join(rootDir, 'coverage.json');
    if (fs.existsSync(pytestCov)) {
        try {
            const data = JSON.parse(fs.readFileSync(pytestCov, 'utf-8'));
            const pct = data.totals?.percent_covered ?? 0;
            return { lines: pct, statements: pct, branches: 0, functions: 0 };
        } catch { /* ignore */ }
    }
    return undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A report for a root that produced no parseable results. */
function emptyReport(root: string, command: string, detail: string): ExecutedTestReport {
    return {
        framework: 'unknown',
        root,
        command,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        cases: [],
        exitCode: 0,
        runnerError: false,
        runnerErrorDetail: detail,
        untracedTests: 0,
        untracedTestNames: [],
    };
}

function extractAttr(attrs: string, name: string): string | null {
    // Use word boundary to avoid matching 'classname' when looking for 'name'
    const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
    const m = re.exec(attrs);
    return m ? m[1] : null;
}

// ─── ExecutedTestReport → TestReport conversion ─────────────────────────────

import type { TestReport } from '../agents/_shared/schemas/testing.schema';

/**
 * Convert one or more ExecutedTestReports into authoritative TestReports
 * for ProjectState. These have `source: 'executed'`.
 */
export function executedToTestReports(executed: ExecutedTestReport[]): TestReport[] {
    return executed.map(e => {
        let status: 'pass' | 'fail' | 'inconclusive';
        if (e.runnerError) {
            status = 'inconclusive';
        } else if (e.total === 0) {
            status = 'inconclusive';
        } else if (e.failed > 0) {
            status = 'fail';
        } else {
            status = 'pass';
        }

        return {
            type: 'unit' as const,
            framework: e.framework,
            total: e.total,
            passed: e.passed,
            failed: e.failed,
            skipped: e.skipped,
            status,
            source: 'executed' as const,
            iterationIndex: 0,
            runnerError: e.runnerError,
            failures: e.cases
                .filter(c => c.status === 'fail')
                .map(c => ({
                    testName: c.testName,
                    error: c.error || 'Test failed',
                })),
            agentId: 'test-runner',
            cases: e.cases.map(c => ({
                testName: c.testName,
                storyId: c.storyId || '',
                acIndex: c.acIndex ?? -1,
                status: c.status,
            })),
            coverage: e.coverage,
        };
    });
}

// ─── Claim vs Reality comparison ────────────────────────────────────────────

export interface ClaimDiscrepancy {
    field: string;
    claimed: number | string;
    actual: number | string;
}

/**
 * Compare a QA agent's self-reported TestReport against the real runner results.
 * Logs discrepancies and returns them for state recording.
 */
export function compareClaimVsReality(
    claimed: TestReport,
    executed: TestReport[],
    logger: { warn: (msg: string) => void },
): ClaimDiscrepancy[] {
    const discrepancies: ClaimDiscrepancy[] = [];
    const totalExecuted = executed.reduce((sum, r) => sum + r.total, 0);
    const totalPassed = executed.reduce((sum, r) => sum + r.passed, 0);
    const totalFailed = executed.reduce((sum, r) => sum + r.failed, 0);

    if (claimed.total !== totalExecuted) {
        discrepancies.push({ field: 'total', claimed: claimed.total, actual: totalExecuted });
    }
    if (claimed.passed !== totalPassed) {
        discrepancies.push({ field: 'passed', claimed: claimed.passed, actual: totalPassed });
    }
    if (claimed.failed !== totalFailed) {
        discrepancies.push({ field: 'failed', claimed: claimed.failed, actual: totalFailed });
    }
    if (claimed.status === 'pass' && totalFailed > 0) {
        discrepancies.push({ field: 'status', claimed: 'pass', actual: 'fail' });
    }
    if (claimed.status === 'pass' && totalExecuted === 0) {
        discrepancies.push({ field: 'status', claimed: 'pass', actual: 'inconclusive (0 tests)' });
    }

    if (discrepancies.length > 0) {
        const summary = discrepancies.map(d => `${d.field}: claimed=${d.claimed}, actual=${d.actual}`).join('; ');
        logger.warn(`QA claim/reality divergence: ${summary}. Using the runner result.`);
    }

    return discrepancies;
}
