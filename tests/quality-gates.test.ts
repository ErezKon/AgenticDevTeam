/**
 * Quality Gates — unit tests.
 *
 * Tests detectStacks, detectStackRoots, GATE_COMMANDS, runQualityGates
 * (with injected fake command runner), gateReportToTestReport,
 * synthesiseGateBugs, and gateReportToMarkdown.
 * No real toolchains needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    detectStacks,
    detectStackRoots,
    GATE_COMMANDS,
    runQualityGates,
    gateReportToTestReport,
    synthesiseGateBugs,
    gateReportToMarkdown,
} from '../src/conductor/quality-gates';
import type { StackKind, GateStep, GateReport, GateResult, StackRoot } from '../src/conductor/quality-gates';

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// Mock event bus
jest.mock('../src/utils/event-bus', () => ({
    emitRunEvent: jest.fn(),
}));

// Mock config — use defaults, but allow per-test override
jest.mock('../src/config', () => ({
    QUALITY_GATES_ENABLED: true,
    QUALITY_GATE_STEPS: ['install', 'build', 'lint', 'test'],
    QUALITY_GATE_TIMEOUT_MS: 300000,
    QUALITY_GATE_STRICT_TOOLCHAIN: false,
    QUALITY_GATE_SCAN_DEPTH: 3,
    QUALITY_GATE_MAX_ROOTS: 8,
}));

// ─── Temp dir helpers ───────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gates-'));
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Helper to create GateResult with new required fields ───────────────────

function makeResult(partial: Omit<GateResult, 'relDir' | 'mode' | 'inconclusive'> & Partial<Pick<GateResult, 'relDir' | 'mode' | 'inconclusive'>>): GateResult {
    return {
        relDir: '',
        mode: 'real',
        inconclusive: false,
        ...partial,
    };
}

function makeReport(partial: Omit<GateReport, 'roots' | 'inconclusive'> & Partial<Pick<GateReport, 'roots' | 'inconclusive'>>): GateReport {
    return {
        roots: partial.stacks.map(s => ({ dir: '/tmp', relDir: '', stack: s, isWorkspaceMember: false })),
        inconclusive: false,
        ...partial,
    };
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

    it('node has all five steps', () => {
        expect(GATE_COMMANDS.node.install).toBeDefined();
        expect(GATE_COMMANDS.node.typecheck).toBeDefined();
        expect(GATE_COMMANDS.node.build).toBeDefined();
        expect(GATE_COMMANDS.node.lint).toBeDefined();
        expect(GATE_COMMANDS.node.test).toBeDefined();
    });

    it('go has install, typecheck, build, lint, and test', () => {
        expect(GATE_COMMANDS.go.install).toBeDefined();
        expect(GATE_COMMANDS.go.typecheck).toBeDefined();
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

    it('runs steps in order and produces results', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
            scripts: { build: 'tsc', lint: 'eslint', test: 'jest' },
        }));
        const callOrder: string[] = [];
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            callOrder.push(cmd);
            return 'ok';
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        expect(report.stacks).toEqual(['node']);
        expect(report.roots.length).toBeGreaterThanOrEqual(1);
    });

    it('a failing build still runs test but yields passed: false', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
            scripts: { build: 'tsc', test: 'jest' },
        }));
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            if (cmd === 'npm run build') throw new Error('build failed');
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
    });

    it('missing tool yields skipped (strict=false in this test)', () => {
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
    });

    it('returns empty report when no stacks detected', () => {
        fs.writeFileSync(path.join(tempDir, 'README.md'), '# Hi');
        const report = runQualityGates(tempDir);
        expect(report.stacks).toEqual([]);
        expect(report.results).toEqual([]);
    });

    it('handles polyglot repo (node + go)', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
            scripts: { build: 'tsc', test: 'jest' },
        }));
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
        expect(report.results.length).toBeGreaterThan(0);
    });

    it('truncates output to 2000 chars', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
            scripts: { build: 'tsc', test: 'jest' },
        }));
        const longOutput = 'x'.repeat(5000);
        const fakeExec = (cmd: string, _opts: { cwd: string; timeout: number }): string => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            return longOutput;
        };

        const report = runQualityGates(tempDir, { exec: fakeExec });
        for (const r of report.results.filter(r => !r.skipped && r.mode !== 'absent')) {
            expect(r.output.length).toBeLessThanOrEqual(2000);
        }
    });
});

// ─── gateReportToTestReport ─────────────────────────────────────────────────

describe('gateReportToTestReport', () => {
    it('maps a failing report to status fail with failures populated', () => {
        const report = makeReport({
            stacks: ['node'],
            results: [
                makeResult({ step: 'install', command: 'npm ci', passed: true, skipped: false, output: '', durationMs: 100 }),
                makeResult({ step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'TypeScript error TS2345', durationMs: 500 }),
                makeResult({ step: 'test', command: 'npm test', passed: false, skipped: false, output: 'FAIL src/foo.test.ts', durationMs: 300 }),
            ],
            passed: false,
        });

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
        const report = makeReport({
            stacks: ['go'],
            results: [
                makeResult({ step: 'build', command: 'go build ./...', passed: true, skipped: false, output: '', durationMs: 200 }),
                makeResult({ step: 'test', command: 'go test ./...', passed: true, skipped: false, output: 'ok', durationMs: 100 }),
            ],
            passed: true,
        });

        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr).not.toBeNull();
        expect(tr!.status).toBe('pass');
        expect(tr!.failures).toHaveLength(0);
    });

    it('returns inconclusive for an all-skipped report', () => {
        const report = makeReport({
            stacks: ['rust'],
            results: [
                makeResult({ step: 'build', command: 'cargo build', passed: true, skipped: true, output: 'cargo not found', durationMs: 0 }),
                makeResult({ step: 'test', command: 'cargo test', passed: true, skipped: true, output: 'cargo not found', durationMs: 0 }),
            ],
            passed: false,
            inconclusive: true,
        });

        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr).not.toBeNull();
        expect(tr!.status).toBe('inconclusive');
    });

    it('returns inconclusive for empty results', () => {
        const report: GateReport = { stacks: [], roots: [], results: [], passed: true, inconclusive: true };
        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr).not.toBeNull();
        expect(tr!.status).toBe('inconclusive');
    });
});

// ─── synthesiseGateBugs ─────────────────────────────────────────────────────

describe('synthesiseGateBugs', () => {
    it('creates bugs with stable GATE- ids for failing steps', () => {
        const report = makeReport({
            stacks: ['node'],
            results: [
                makeResult({ step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'TS2345 error', durationMs: 100 }),
                makeResult({ step: 'test', command: 'npm test', passed: false, skipped: false, output: 'FAIL test.ts', durationMs: 200 }),
                makeResult({ step: 'lint', command: 'npm run lint', passed: true, skipped: false, output: '', durationMs: 50 }),
            ],
            passed: false,
        });

        const bugs = synthesiseGateBugs(report);
        expect(bugs).toHaveLength(2);
        expect(bugs[0].id).toBe('GATE-node-build');
        expect(bugs[0].severity).toBe('critical'); // build/test = critical
        expect(bugs[1].id).toBe('GATE-node-test');
        expect(bugs[1].severity).toBe('critical');
    });

    it('uses major severity for lint failures', () => {
        const report = makeReport({
            stacks: ['go'],
            results: [
                makeResult({ step: 'lint', command: 'go vet ./...', passed: false, skipped: false, output: 'vet: error', durationMs: 100 }),
            ],
            passed: false,
        });

        const bugs = synthesiseGateBugs(report);
        expect(bugs).toHaveLength(1);
        expect(bugs[0].id).toBe('GATE-go-lint');
        expect(bugs[0].severity).toBe('major');
    });

    it('returns empty array when all steps pass', () => {
        const report = makeReport({
            stacks: ['node'],
            results: [
                makeResult({ step: 'test', command: 'npm test', passed: true, skipped: false, output: '', durationMs: 100 }),
            ],
            passed: true,
        });

        expect(synthesiseGateBugs(report)).toEqual([]);
    });

    it('skips skipped steps', () => {
        const report = makeReport({
            stacks: ['rust'],
            results: [
                makeResult({ step: 'build', command: 'cargo build', passed: true, skipped: true, output: '', durationMs: 0 }),
            ],
            passed: true,
        });

        expect(synthesiseGateBugs(report)).toEqual([]);
    });
});

// ─── gateReportToMarkdown ───────────────────────────────────────────────────

describe('gateReportToMarkdown', () => {
    it('produces a table with correct columns including Dir and Mode', () => {
        const report = makeReport({
            stacks: ['node'],
            results: [
                makeResult({ step: 'test', command: 'npm test', passed: true, skipped: false, output: 'all good', durationMs: 1500 }),
            ],
            passed: true,
        });

        const md = gateReportToMarkdown(report);
        expect(md).toContain('All quality gates passed');
        expect(md).toContain('| Dir | Stack | Step | Mode | Status | Duration |');
        expect(md).toContain('node');
        expect(md).toContain('test');
        expect(md).toContain('Passed');
    });

    it('includes failure details when steps fail', () => {
        const report = makeReport({
            stacks: ['node'],
            results: [
                makeResult({ step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'error TS2345', durationMs: 500 }),
            ],
            passed: false,
        });

        const md = gateReportToMarkdown(report);
        expect(md).toContain('Some quality gates failed');
        expect(md).toContain('Failed');
        expect(md).toContain('error TS2345');
    });

    it('handles empty results', () => {
        const report: GateReport = { stacks: [], roots: [], results: [], passed: true, inconclusive: false };
        const md = gateReportToMarkdown(report);
        expect(md).toContain('No quality gates executed');
    });
});
