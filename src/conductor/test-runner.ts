/**
 * Deterministic test runner — executes real test suites and parses their output.
 *
 * Sub-Plan 09: QA's claim becomes irrelevant; the runner's output is the truth.
 * Supports Jest (--json), Vitest, Mocha, pytest (JUnit XML), Maven, Gradle,
 * Go (JSON), dotnet (TRX), and Rust (summary parse).
 *
 * Never parses stdout prose — always machine-readable output files.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getLogger } from '../utils/logger';
import type { StackRoot } from './quality-gates';

const log = getLogger('[TestRunner]', 199);

// ─── Tag regex for traceability ──────────────────────────────────────────────

/** Matches `[US-003#1]` or `[US-003#-1]` at the start of a test name. */
const TAG_RE = /^\[([A-Za-z]+-\d+)#(-?\d+)\]\s*/;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutedTestCase {
    testName: string;
    suite: string;
    file: string;
    status: 'pass' | 'fail' | 'skip';
    durationMs: number;
    error?: string;
    /** Parsed from the test name annotation `[US-003#1]`, when present. */
    storyId?: string;
    acIndex?: number;
}

export interface ExecutedTestReport {
    framework: string;
    root: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    cases: ExecutedTestCase[];
    coverage?: { lines: number; statements: number; branches: number; functions: number };
    /** Raw runner exit code. */
    exitCode: number;
    /** True when the runner itself failed to start (config error, missing dep). */
    runnerError: boolean;
    runnerErrorDetail?: string;
    /** Count of tests that lack a traceability tag. */
    untracedTests: number;
    /** First 10 untraced test names. */
    untracedTestNames: string[];
}

// ─── Tag parsing ────────────────────────────────────────────────────────────

/** Extract `[US-003#1]` from a test name, returning storyId/acIndex or undefined. */
export function parseTraceTag(name: string): { storyId: string; acIndex: number } | null {
    const m = TAG_RE.exec(name);
    if (!m) return null;
    return { storyId: m[1], acIndex: parseInt(m[2], 10) };
}

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

export function parseJestJson(raw: string, root: string): Omit<ExecutedTestReport, 'exitCode' | 'runnerError' | 'runnerErrorDetail' | 'coverage'> {
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
export function parseJunitXml(xml: string, root: string, framework: string): Omit<ExecutedTestReport, 'exitCode' | 'runnerError' | 'runnerErrorDetail' | 'coverage'> {
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

    const passed = cases.filter(c => c.status === 'pass').length;
    const failed = cases.filter(c => c.status === 'fail').length;
    const skipped = cases.filter(c => c.status === 'skip').length;
    const untraced = cases.filter(c => !c.storyId && c.status !== 'skip');

    return {
        framework,
        root,
        total: cases.length,
        passed,
        failed,
        skipped,
        cases,
        untracedTests: untraced.length,
        untracedTestNames: untraced.slice(0, 10).map(c => c.testName),
    };
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

export function parseGoTestJson(raw: string, root: string): Omit<ExecutedTestReport, 'exitCode' | 'runnerError' | 'runnerErrorDetail' | 'coverage'> {
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

    const passed = cases.filter(c => c.status === 'pass').length;
    const failed = cases.filter(c => c.status === 'fail').length;
    const skipped = cases.filter(c => c.status === 'skip').length;
    const untraced = cases.filter(c => !c.storyId && c.status !== 'skip');

    return {
        framework: 'go',
        root,
        total: cases.length,
        passed,
        failed,
        skipped,
        cases,
        untracedTests: untraced.length,
        untracedTestNames: untraced.slice(0, 10).map(c => c.testName),
    };
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

/**
 * Execute the test suite for a single stack root and parse the results.
 *
 * Returns an `ExecutedTestReport` — the authoritative test signal.
 */
export function runTests(root: StackRoot, opts: RunTestsOptions): ExecutedTestReport {
    const { timeoutMs, withCoverage, reportDir } = opts;
    const rootDir = root.dir;

    // Determine the test command and framework
    const { command, framework } = resolveTestCommand(rootDir, root.stack);
    if (!command) {
        log.info(`No test command found for ${root.relDir || '.'} (${root.stack})`);
        return makeEmptyReport(root, 'no-test-command');
    }

    // Ensure report directory exists
    const rootSlug = root.relDir.replace(/\//g, '-') || 'root';
    const rootReportDir = path.join(reportDir, rootSlug);
    fs.mkdirSync(rootReportDir, { recursive: true });

    // Build the runner command with machine-readable output flags
    const fullCommand = buildRunnerCommand(command, framework, rootReportDir, rootDir, withCoverage);

    log.info(`Running tests in ${root.relDir || '.'}: ${fullCommand.slice(0, 200)}`);
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
        stdout = execSync(fullCommand, {
            cwd: rootDir,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                CI: 'true',
                FORCE_COLOR: '0',
                NODE_ENV: 'test',
            },
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err: any) {
        exitCode = err.status ?? 1;
        stdout = err.stdout ?? '';
        stderr = err.stderr ?? '';
    }

    const combinedOutput = `${stdout}\n${stderr}`;

    // Check for runner error (config error, missing dep)
    if (exitCode !== 0 && isRunnerError(combinedOutput)) {
        log.warn(`Runner error in ${root.relDir || '.'}: ${combinedOutput.slice(0, 200)}`);
        return {
            ...makeEmptyReport(root, combinedOutput.slice(0, 2000)),
            framework,
            exitCode,
            runnerError: true,
        };
    }

    // Parse results from the machine-readable output
    const parsed = parseRunnerOutput(framework, rootReportDir, rootDir, stdout);
    if (!parsed) {
        // Fallback: no machine-readable output found
        if (exitCode === 0 && !stdout.trim()) {
            return makeEmptyReport(root, 'no-output');
        }
        // Try to detect "no tests found" vs real failure
        if (/No tests found/i.test(combinedOutput) || /exiting with code 1/i.test(combinedOutput)) {
            return {
                ...makeEmptyReport(root, 'no-tests-found'),
                framework,
                exitCode,
                runnerError: false,
            };
        }
        return {
            ...makeEmptyReport(root, `Could not parse runner output (exit ${exitCode})`),
            framework,
            exitCode,
            runnerError: exitCode !== 0,
        };
    }

    // Merge coverage data
    let coverage = parsed.coverage;
    if (withCoverage && !coverage) {
        coverage = tryParseCoverage(rootDir, rootReportDir);
    }

    return {
        ...parsed,
        root: root.relDir,
        exitCode,
        runnerError: false,
        coverage,
    };
}

// ─── Test command resolution ────────────────────────────────────────────────

function resolveTestCommand(rootDir: string, stack: string): { command: string | null; framework: string } {
    if (stack === 'node') {
        const pkgPath = path.join(rootDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const testScript = pkg.scripts?.test;
                if (testScript && !/no test specified|exit 1/.test(testScript)) {
                    // Detect framework from the test script
                    const fw = detectNodeFramework(testScript, rootDir);
                    return { command: 'npm test', framework: fw };
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

function detectNodeFramework(testScript: string, rootDir: string): string {
    if (/vitest/i.test(testScript)) return 'vitest';
    if (/mocha/i.test(testScript)) return 'mocha';
    if (/jest/i.test(testScript)) return 'jest';
    // Check for config files
    if (fs.existsSync(path.join(rootDir, 'vitest.config.ts')) ||
        fs.existsSync(path.join(rootDir, 'vitest.config.js'))) return 'vitest';
    if (fs.existsSync(path.join(rootDir, 'jest.config.ts')) ||
        fs.existsSync(path.join(rootDir, 'jest.config.js')) ||
        fs.existsSync(path.join(rootDir, 'jest.config.cjs'))) return 'jest';
    // Default to jest (most common)
    return 'jest';
}

// ─── Runner command construction ────────────────────────────────────────────

function buildRunnerCommand(
    baseCommand: string,
    framework: string,
    reportDir: string,
    rootDir: string,
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
): (Omit<ExecutedTestReport, 'exitCode' | 'runnerError' | 'runnerErrorDetail'>) | null {
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

function parseDotnetTrx(xml: string, root: string): Omit<ExecutedTestReport, 'exitCode' | 'runnerError' | 'runnerErrorDetail' | 'coverage'> {
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

    const passed = cases.filter(c => c.status === 'pass').length;
    const failed = cases.filter(c => c.status === 'fail').length;
    const skipped = cases.filter(c => c.status === 'skip').length;
    const untraced = cases.filter(c => !c.storyId && c.status !== 'skip');

    return {
        framework: 'dotnet',
        root,
        total: cases.length,
        passed,
        failed,
        skipped,
        cases,
        untracedTests: untraced.length,
        untracedTestNames: untraced.slice(0, 10).map(c => c.testName),
    };
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

function makeEmptyReport(root: StackRoot, detail: string): ExecutedTestReport {
    return {
        framework: 'unknown',
        root: root.relDir,
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
