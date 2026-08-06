/**
 * Quality Gates — unit tests.
 *
 * Tests detectStacks, GATE_COMMANDS, runQualityGates (with injected fake
 * command runner), and gateReportToTestReport. No real toolchains needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    detectStacks,
    GATE_COMMANDS,
    runQualityGates,
    gateReportToTestReport,
    synthesiseGateBugs,
    gateReportToMarkdown,
} from '../src/conductor/quality-gates';
import type { StackKind, GateStep, GateReport, GateResult } from '../src/conductor/quality-gates';

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// Mock config — use defaults, but allow per-test override
jest.mock('../src/config', () => ({
    QUALITY_GATES_ENABLED: true,
    QUALITY_GATE_STEPS: ['install', 'build', 'lint', 'test'],
    QUALITY_GATE_TIMEOUT_MS: 300000,
    QUALITY_GATE_STRICT_TOOLCHAIN: false,
}));

// ─── Temp dir helpers ───────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gates-'));
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ─── detectStacks ───────────────────────────────────────────────────────────

describe('detectStacks', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = makeTempDir(); });
    afterEach(() => { cleanupDir(tempDir); });

    it('detects node from package.json', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        expect(detectStacks(tempDir)).toEqual(['node']);
    });

    it('detects maven from pom.xml', () => {
        fs.writeFileSync(path.join(tempDir, 'pom.xml'), '<project/>');
        expect(detectStacks(tempDir)).toEqual(['maven']);
    });

    it('detects gradle from build.gradle', () => {
        fs.writeFileSync(path.join(tempDir, 'build.gradle'), '');
        expect(detectStacks(tempDir)).toEqual(['gradle']);
    });

    it('detects gradle from build.gradle.kts', () => {
        fs.writeFileSync(path.join(tempDir, 'build.gradle.kts'), '');
        expect(detectStacks(tempDir)).toEqual(['gradle']);
    });

    it('detects go from go.mod', () => {
        fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/foo');
        expect(detectStacks(tempDir)).toEqual(['go']);
    });

    it('detects python from requirements.txt', () => {
        fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'flask');
        expect(detectStacks(tempDir)).toEqual(['python']);
    });

    it('detects python from pyproject.toml', () => {
        fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '[tool.poetry]');
        expect(detectStacks(tempDir)).toEqual(['python']);
    });

    it('detects dotnet from .csproj', () => {
        fs.writeFileSync(path.join(tempDir, 'MyApp.csproj'), '<Project/>');
        expect(detectStacks(tempDir)).toEqual(['dotnet']);
    });

    it('detects dotnet from .sln', () => {
        fs.writeFileSync(path.join(tempDir, 'MySolution.sln'), '');
        expect(detectStacks(tempDir)).toEqual(['dotnet']);
    });

    it('detects rust from Cargo.toml', () => {
        fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]');
        expect(detectStacks(tempDir)).toEqual(['rust']);
    });

    it('detects polyglot repo (node + go)', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/foo');
        const stacks = detectStacks(tempDir);
        expect(stacks).toContain('node');
        expect(stacks).toContain('go');
        expect(stacks).toHaveLength(2);
    });

    it('returns empty for a dir with no markers', () => {
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Hello');
        expect(detectStacks(tempDir)).toEqual([]);
    });

    it('returns empty for a non-existent dir', () => {
        expect(detectStacks('/nonexistent/path/12345')).toEqual([]);
    });
});

// ─── GATE_COMMANDS ──────────────────────────────────────────────────────────

describe('GATE_COMMANDS', () => {
    it('has a test entry for every StackKind', () => {
        const allStacks: StackKind[] = ['node', 'maven', 'gradle', 'go', 'python', 'dotnet', 'rust'];
        for (const stack of allStacks) {
            expect(GATE_COMMANDS[stack]).toBeDefined();
            expect(GATE_COMMANDS[stack].test).toBeDefined();
            expect(typeof GATE_COMMANDS[stack].test).toBe('string');
        }
    });

    it('node has all four steps', () => {
        expect(GATE_COMMANDS.node.install).toBeDefined();
        expect(GATE_COMMANDS.node.build).toBeDefined();
        expect(GATE_COMMANDS.node.lint).toBeDefined();
        expect(GATE_COMMANDS.node.test).toBeDefined();
    });

    it('go has install, build, lint, and test', () => {
        expect(GATE_COMMANDS.go.install).toBeDefined();
        expect(GATE_COMMANDS.go.build).toBeDefined();
        expect(GATE_COMMANDS.go.lint).toBeDefined();
        expect(GATE_COMMANDS.go.test).toBeDefined();
    });
});

// ─── runQualityGates (with fake exec) ───────────────────────────────────────

describe('runQualityGates', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = makeTempDir(); });
    afterEach(() => { cleanupDir(tempDir); });

    it('runs steps in order: install -> build -> lint -> test', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        const callOrder: string[] = [];
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            // which npm check
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            callOrder.push(cmd);
            return 'ok';
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        expect(report.stacks).toEqual(['node']);
        expect(report.passed).toBe(true);

        // Verify step ordering
        const stepOrder = report.results
            .filter(r => !r.skipped)
            .map(r => r.step);
        expect(stepOrder).toEqual(['install', 'build', 'lint', 'test']);
    });

    it('a failing build still runs test but yields passed: false', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            if (cmd.includes('run build')) throw new Error('build failed');
            return 'ok';
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        expect(report.passed).toBe(false);

        const buildResult = report.results.find(r => r.step === 'build');
        expect(buildResult?.passed).toBe(false);
        expect(buildResult?.skipped).toBe(false);

        // Test still ran
        const testResult = report.results.find(r => r.step === 'test');
        expect(testResult).toBeDefined();
        expect(testResult?.skipped).toBe(false);
    });

    it('missing tool yields skipped (strict=false)', () => {
        fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/foo');
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) throw new Error('not found');
            return 'ok';
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        // All results should be skipped
        for (const r of report.results) {
            expect(r.skipped).toBe(true);
        }
        // passed should be true (skipped is not failed)
        expect(report.passed).toBe(true);
    });

    it('skips install when node_modules exists', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        fs.mkdirSync(path.join(tempDir, 'node_modules'));
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            return 'ok';
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        const installResult = report.results.find(r => r.step === 'install');
        expect(installResult?.skipped).toBe(true);
        expect(installResult?.output).toContain('node_modules already exists');
    });

    it('returns empty report when no stacks detected', () => {
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Hi');
        const report = runQualityGates(tempDir);
        expect(report.stacks).toEqual([]);
        expect(report.results).toEqual([]);
        expect(report.passed).toBe(true);
    });

    it('handles polyglot repo (node + go)', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/foo');
        const executedCommands: string[] = [];
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/tool';
            executedCommands.push(cmd);
            return 'ok';
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        expect(report.stacks).toContain('node');
        expect(report.stacks).toContain('go');
        // Should have results from both stacks
        expect(report.results.length).toBeGreaterThan(4);
        expect(report.passed).toBe(true);
    });

    it('truncates output to 2000 chars', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        const longOutput = 'x'.repeat(5000);
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            return longOutput;
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        for (const r of report.results.filter(r => !r.skipped)) {
            expect(r.output.length).toBeLessThanOrEqual(2000);
        }
    });
});

// ─── gateReportToTestReport ─────────────────────────────────────────────────

describe('gateReportToTestReport', () => {
    it('maps a failing report to status fail with failures populated', () => {
        const report: GateReport = {
            stacks: ['node'],
            results: [
                { step: 'install', command: 'npm ci', passed: true, skipped: false, output: '', durationMs: 100 },
                { step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'TypeScript error TS2345', durationMs: 500 },
                { step: 'test', command: 'npm test', passed: false, skipped: false, output: 'FAIL src/foo.test.ts', durationMs: 300 },
            ],
            passed: false,
        };

        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr).not.toBeNull();
        expect(tr!.status).toBe('fail');
        expect(tr!.total).toBe(3);
        expect(tr!.passed).toBe(1);
        expect(tr!.failed).toBe(2);
        expect(tr!.failures).toHaveLength(2);
        expect(tr!.failures[0].testName).toContain('build');
        expect(tr!.failures[0].error).toContain('TypeScript error');
        expect(tr!.failures[1].testName).toContain('test');
        expect(tr!.agentId).toBe('quality-gates');
    });

    it('maps a passing report to status pass', () => {
        const report: GateReport = {
            stacks: ['go'],
            results: [
                { step: 'build', command: 'go build ./...', passed: true, skipped: false, output: '', durationMs: 200 },
                { step: 'test', command: 'go test ./...', passed: true, skipped: false, output: 'ok', durationMs: 100 },
            ],
            passed: true,
        };

        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr).not.toBeNull();
        expect(tr!.status).toBe('pass');
        expect(tr!.failures).toHaveLength(0);
    });

    it('returns null for an all-skipped report', () => {
        const report: GateReport = {
            stacks: ['rust'],
            results: [
                { step: 'build', command: 'cargo build', passed: true, skipped: true, output: 'cargo not found', durationMs: 0 },
                { step: 'test', command: 'cargo test', passed: true, skipped: true, output: 'cargo not found', durationMs: 0 },
            ],
            passed: true,
        };

        expect(gateReportToTestReport(report, 'quality-gates')).toBeNull();
    });

    it('returns null for empty results', () => {
        const report: GateReport = { stacks: [], results: [], passed: true };
        expect(gateReportToTestReport(report, 'quality-gates')).toBeNull();
    });
});

// ─── synthesiseGateBugs ─────────────────────────────────────────────────────

describe('synthesiseGateBugs', () => {
    it('creates bugs with stable GATE- ids for failing steps', () => {
        const report: GateReport = {
            stacks: ['node'],
            results: [
                { step: 'build', command: 'npm run build --if-present', passed: false, skipped: false, output: 'TS2345 error', durationMs: 100 },
                { step: 'test', command: 'npm test --silent', passed: false, skipped: false, output: 'FAIL test.ts', durationMs: 200 },
                { step: 'lint', command: 'npm run lint --if-present', passed: true, skipped: false, output: '', durationMs: 50 },
            ],
            passed: false,
        };

        const bugs = synthesiseGateBugs(report);
        expect(bugs).toHaveLength(2);
        expect(bugs[0].id).toBe('GATE-node-build');
        expect(bugs[0].severity).toBe('critical'); // build/test = critical
        expect(bugs[1].id).toBe('GATE-node-test');
        expect(bugs[1].severity).toBe('critical');
    });

    it('uses major severity for lint failures', () => {
        const report: GateReport = {
            stacks: ['go'],
            results: [
                { step: 'lint', command: 'go vet ./...', passed: false, skipped: false, output: 'vet: error', durationMs: 100 },
            ],
            passed: false,
        };

        const bugs = synthesiseGateBugs(report);
        expect(bugs).toHaveLength(1);
        expect(bugs[0].id).toBe('GATE-go-lint');
        expect(bugs[0].severity).toBe('major');
    });

    it('returns empty array when all steps pass', () => {
        const report: GateReport = {
            stacks: ['node'],
            results: [
                { step: 'test', command: 'npm test', passed: true, skipped: false, output: '', durationMs: 100 },
            ],
            passed: true,
        };

        expect(synthesiseGateBugs(report)).toEqual([]);
    });

    it('skips skipped steps', () => {
        const report: GateReport = {
            stacks: ['rust'],
            results: [
                { step: 'build', command: 'cargo build', passed: true, skipped: true, output: '', durationMs: 0 },
            ],
            passed: true,
        };

        expect(synthesiseGateBugs(report)).toEqual([]);
    });
});

// ─── gateReportToMarkdown ───────────────────────────────────────────────────

describe('gateReportToMarkdown', () => {
    it('produces a table with correct columns', () => {
        const report: GateReport = {
            stacks: ['node'],
            results: [
                { step: 'test', command: 'npm test --silent', passed: true, skipped: false, output: 'all good', durationMs: 1500 },
            ],
            passed: true,
        };

        const md = gateReportToMarkdown(report);
        expect(md).toContain('All quality gates passed');
        expect(md).toContain('| Stack | Step | Status | Duration |');
        expect(md).toContain('node');
        expect(md).toContain('test');
        expect(md).toContain('Passed');
    });

    it('includes failure details when steps fail', () => {
        const report: GateReport = {
            stacks: ['node'],
            results: [
                { step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'error TS2345', durationMs: 500 },
            ],
            passed: false,
        };

        const md = gateReportToMarkdown(report);
        expect(md).toContain('Some quality gates failed');
        expect(md).toContain('Failed');
        expect(md).toContain('error TS2345');
    });

    it('handles empty results', () => {
        const report: GateReport = { stacks: [], results: [], passed: true };
        const md = gateReportToMarkdown(report);
        expect(md).toContain('No quality gates executed');
    });
});
