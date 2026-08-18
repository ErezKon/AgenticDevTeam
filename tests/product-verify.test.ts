/**
 * Product Verification — unit tests.
 *
 * Tests detectStackRoots, findUnresolvedReferences, verifyBuildArtifacts,
 * and the smoke server. Fixtures under tests/fixtures/product-verify/
 * reproduce both headline bugs from pacman8 and retroboard3.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    detectStackRoots,
    detectStacks,
    resolveNodeStep,
    runQualityGates,
    gateReportToTestReport,
    synthesiseGateBugs,
    gateReportToMarkdown,
} from '../src/conductor/quality-gates';
import type { GateReport } from '../src/conductor/quality-gates';
import {
    findUnresolvedReferences,
    verifyBuildArtifacts,
    runSmokeTest,
} from '../src/conductor/product-verify';

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

// Mock config — use test defaults
jest.mock('../src/config', () => ({
    QUALITY_GATES_ENABLED: true,
    QUALITY_GATE_STEPS: ['install', 'typecheck', 'build', 'lint', 'test'],
    QUALITY_GATE_TIMEOUT_MS: 300000,
    QUALITY_GATE_STRICT_TOOLCHAIN: true,
    QUALITY_GATE_SCAN_DEPTH: 3,
    QUALITY_GATE_MAX_ROOTS: 8,
    PRODUCT_VERIFY_ENABLED: true,
    PRODUCT_MIN_ARTIFACT_BYTES: 2048,
    PRODUCT_RESOLVE_MAX_FILES: 2000,
    PRODUCT_SMOKE_BASE_PORT: 18190,
    PRODUCT_SMOKE_TIMEOUT_MS: 10000,
}));

// ─── Fixture paths ──────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures', 'product-verify');
const fix = (name: string) => path.join(FIXTURES, name);

// ─── Temp dir helpers ───────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'product-verify-'));
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ─── detectStackRoots ───────────────────────────────────────────────────────

describe('detectStackRoots', () => {
    it('detects monorepo with 3 roots including workspace members', () => {
        const roots = detectStackRoots(fix('monorepo'));
        expect(roots.length).toBeGreaterThanOrEqual(3);
        // Root package.json
        const rootNode = roots.find(r => r.relDir === '' && r.stack === 'node');
        expect(rootNode).toBeDefined();
        expect(rootNode!.isWorkspaceMember).toBe(false);
        // Frontend package
        const frontend = roots.find(r => r.relDir.includes('frontend') && r.stack === 'node');
        expect(frontend).toBeDefined();
        expect(frontend!.isWorkspaceMember).toBe(true);
        // Backend package
        const backend = roots.find(r => r.relDir.includes('backend') && r.stack === 'node');
        expect(backend).toBeDefined();
        expect(backend!.isWorkspaceMember).toBe(true);
    });

    it('detects single root', () => {
        const roots = detectStackRoots(fix('pacman-missing-css'));
        expect(roots.length).toBe(1);
        expect(roots[0].stack).toBe('node');
        expect(roots[0].relDir).toBe('');
        expect(roots[0].isWorkspaceMember).toBe(false);
    });

    it('returns empty for non-existent dir', () => {
        expect(detectStackRoots('/nonexistent/path/12345')).toEqual([]);
    });

    it('backward-compat detectStacks still works', () => {
        const stacks = detectStacks(fix('monorepo'));
        expect(stacks).toContain('node');
        // Should be deduped
        expect(stacks.filter(s => s === 'node').length).toBe(1);
    });
});

// ─── resolveNodeStep ────────────────────────────────────────────────────────

describe('resolveNodeStep', () => {
    it('returns real mode for existing scripts', () => {
        const result = resolveNodeStep(fix('healthy-vite'), 'build');
        expect(result.mode).toBe('real');
        expect(result.command).toBe('npm run build');
    });

    it('returns fallback mode for typecheck when tsconfig exists but no script', () => {
        const result = resolveNodeStep(fix('alias-paths'), 'typecheck');
        expect(result.mode).toBe('fallback');
        expect(result.command).toContain('tsc --noEmit');
    });

    it('returns absent for test when no test script', () => {
        const result = resolveNodeStep(fix('alias-paths'), 'test');
        expect(result.mode).toBe('absent');
        expect(result.command).toBe('');
    });

    it('returns absent for build when no build script and no bundler', () => {
        const result = resolveNodeStep(fix('alias-paths'), 'build');
        expect(result.mode).toBe('absent');
    });
});

// ─── findUnresolvedReferences ───────────────────────────────────────────────

describe('findUnresolvedReferences', () => {
    it('finds missing ./index.css in pacman fixture', () => {
        const issues = findUnresolvedReferences(fix('pacman-missing-css'));
        const cssIssue = issues.find(i => i.specifier === './index.css');
        expect(cssIssue).toBeDefined();
        expect(cssIssue!.reason).toBe('missing-file');
        expect(cssIssue!.file).toContain('main.tsx');
        expect(cssIssue!.line).toBe(4);
    });

    it('finds missing /src/main.tsx in retro fixture index.html', () => {
        const issues = findUnresolvedReferences(fix('retro-echo-build'));
        const mainIssue = issues.find(i => i.specifier === '/src/main.tsx');
        expect(mainIssue).toBeDefined();
        expect(mainIssue!.reason).toBe('missing-file');
        expect(mainIssue!.kind).toBe('html-src');
    });

    it('reports no issues for healthy-vite fixture', () => {
        const issues = findUnresolvedReferences(fix('healthy-vite'));
        // Should have no missing-file issues for local imports
        const localIssues = issues.filter(i => i.reason === 'missing-file');
        expect(localIssues.length).toBe(0);
    });

    it('finds missing package socket.io-client', () => {
        const issues = findUnresolvedReferences(fix('missing-package'));
        const socketIssue = issues.find(i => i.specifier === 'socket.io-client');
        expect(socketIssue).toBeDefined();
        expect(socketIssue!.reason).toBe('missing-package');
    });

    it('finds broken alias import but not working one', () => {
        const issues = findUnresolvedReferences(fix('alias-paths'));
        const brokenAlias = issues.find(i => i.specifier === '@/lib/nonexistent');
        expect(brokenAlias).toBeDefined();
        expect(brokenAlias!.reason).toBe('missing-file');
        // The working alias should NOT appear
        const workingAlias = issues.find(i => i.specifier === '@/lib/utils');
        expect(workingAlias).toBeUndefined();
    });
});

// ─── verifyBuildArtifacts ───────────────────────────────────────────────────

describe('verifyBuildArtifacts', () => {
    it('passes for healthy-vite with committed dist/', () => {
        const roots = detectStackRoots(fix('healthy-vite'));
        const results = verifyBuildArtifacts(fix('healthy-vite'), roots);
        expect(results.length).toBeGreaterThanOrEqual(1);
        const webRoot = results.find(r => r.root === '');
        expect(webRoot).toBeDefined();
        expect(webRoot!.passed).toBe(true);
        expect(webRoot!.foundDir).toBe('dist');
    });

    it('fails for retro-echo-build (no artifacts)', () => {
        const roots = detectStackRoots(fix('retro-echo-build'));
        const results = verifyBuildArtifacts(fix('retro-echo-build'), roots);
        expect(results.length).toBeGreaterThanOrEqual(1);
        const root = results[0];
        expect(root.passed).toBe(false);
        expect(root.reason).toContain('no artifacts');
    });
});

// ─── Aggregation ────────────────────────────────────────────────────────────

describe('quality gate aggregation', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = makeTempDir(); });
    afterEach(() => { cleanupDir(tempDir); });

    it('all-skipped ⇒ passed: false, inconclusive: true', async () => {
        fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/foo');
        const fakeExec = async (cmd: string, _opts: { cwd: string; timeout: number }): Promise<string> => {
            if (cmd.startsWith('which ')) throw new Error('not found');
            return 'ok';
        };

        const report = await runQualityGates(tempDir, { exec: fakeExec });
        expect(report.passed).toBe(false);
        expect(report.inconclusive).toBe(true);
    });

    it('one real failing step ⇒ passed: false', async () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
            scripts: { build: 'tsc', test: 'jest' },
        }));
        const fakeExec = async (cmd: string, _opts: { cwd: string; timeout: number }): Promise<string> => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            if (cmd === 'npm run build') throw new Error('build failed');
            return 'ok';
        };

        const report = await runQualityGates(tempDir, { exec: fakeExec });
        expect(report.passed).toBe(false);
        expect(report.inconclusive).toBe(false);
    });

    it('node root with no test script ⇒ test step mode=absent, report inconclusive=true', async () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
            scripts: { build: 'tsc' },
        }));
        const fakeExec = async (cmd: string, _opts: { cwd: string; timeout: number }): Promise<string> => {
            if (cmd.startsWith('which ')) return '/usr/bin/npm';
            return 'ok';
        };

        const report = await runQualityGates(tempDir, { exec: fakeExec });
        const testResult = report.results.find(r => r.step === 'test');
        expect(testResult).toBeDefined();
        expect(testResult!.mode).toBe('absent');
        expect(report.inconclusive).toBe(true);
    });

    it('missing toolchain with strict=true ⇒ passed: false', async () => {
        fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/foo');
        const fakeExec = async (cmd: string, _opts: { cwd: string; timeout: number }): Promise<string> => {
            if (cmd.startsWith('which ')) throw new Error('not found');
            return 'ok';
        };

        // strict is true in our mock config
        const report = await runQualityGates(tempDir, { exec: fakeExec });
        expect(report.passed).toBe(false);
    });
});

// ─── gateReportToTestReport ─────────────────────────────────────────────────

describe('gateReportToTestReport (updated)', () => {
    it('never returns null — returns inconclusive for all-skipped', () => {
        const report: GateReport = {
            stacks: ['rust'],
            roots: [{ dir: '/tmp', relDir: '', stack: 'rust', isWorkspaceMember: false }],
            results: [
                { step: 'build', command: 'cargo build', passed: true, skipped: true, output: '', durationMs: 0, relDir: '', mode: 'real', inconclusive: false },
            ],
            passed: false,
            inconclusive: true,
        };

        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr).not.toBeNull();
        expect(tr.status).toBe('inconclusive');
    });

    it('maps a failing report to status fail', () => {
        const report: GateReport = {
            stacks: ['node'],
            roots: [{ dir: '/tmp', relDir: '', stack: 'node', isWorkspaceMember: false }],
            results: [
                { step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'error', durationMs: 100, relDir: '', mode: 'real', inconclusive: false },
                { step: 'test', command: 'npm test', passed: true, skipped: false, output: '', durationMs: 50, relDir: '', mode: 'real', inconclusive: false },
            ],
            passed: false,
            inconclusive: false,
        };

        const tr = gateReportToTestReport(report, 'quality-gates');
        expect(tr.status).toBe('fail');
        expect(tr.failed).toBe(1);
    });
});

// ─── synthesiseGateBugs ─────────────────────────────────────────────────────

describe('synthesiseGateBugs (updated)', () => {
    it('produces PRODUCT-RESOLVE with a stable id across two calls', () => {
        const report: GateReport = {
            stacks: ['node'],
            roots: [{ dir: '/tmp', relDir: '', stack: 'node', isWorkspaceMember: false }],
            results: [],
            passed: false,
            inconclusive: false,
            productVerify: {
                artifacts: [],
                resolveIssues: [{
                    file: 'src/main.tsx',
                    line: 4,
                    specifier: './index.css',
                    kind: 'import',
                    reason: 'missing-file',
                }],
                smoke: null,
                passed: false,
                summary: 'test',
            },
        };

        const bugs1 = synthesiseGateBugs(report);
        const bugs2 = synthesiseGateBugs(report);
        const resolveId1 = bugs1.find(b => b.id === 'PRODUCT-RESOLVE');
        const resolveId2 = bugs2.find(b => b.id === 'PRODUCT-RESOLVE');
        expect(resolveId1).toBeDefined();
        expect(resolveId2).toBeDefined();
        expect(resolveId1!.id).toBe(resolveId2!.id);
    });

    it('skips absent-mode results', () => {
        const report: GateReport = {
            stacks: ['node'],
            roots: [{ dir: '/tmp', relDir: '', stack: 'node', isWorkspaceMember: false }],
            results: [
                { step: 'test', command: '', passed: false, skipped: false, output: 'no test script', durationMs: 0, relDir: '', mode: 'absent', inconclusive: true },
            ],
            passed: false,
            inconclusive: true,
        };

        const bugs = synthesiseGateBugs(report);
        expect(bugs).toEqual([]);
    });
});

// ─── Smoke server test ──────────────────────────────────────────────────────

describe('runSmokeTest', () => {
    it('passes for healthy-vite/dist with index.html and JS', async () => {
        const roots = detectStackRoots(fix('healthy-vite'));
        const artifacts = verifyBuildArtifacts(fix('healthy-vite'), roots);
        const result = await runSmokeTest(fix('healthy-vite'), roots, artifacts);
        expect(result.ran).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.httpStatus).toBe(200);
        expect(result.bodyBytes).toBeGreaterThan(0);
    }, 15000);

    it('skips when no web root detected', async () => {
        const tempDir = makeTempDir();
        try {
            fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'api', scripts: { start: 'node index.js' } }));
            const roots = detectStackRoots(tempDir);
            const artifacts = verifyBuildArtifacts(tempDir, roots);
            const result = await runSmokeTest(tempDir, roots, artifacts);
            expect(result.ran).toBe(false);
            expect(result.passed).toBe(true);
            expect(result.skippedReason).toContain('no web root');
        } finally {
            cleanupDir(tempDir);
        }
    });
});

// ─── gateReportToMarkdown ───────────────────────────────────────────────────

describe('gateReportToMarkdown (updated)', () => {
    it('includes Dir and Mode columns', () => {
        const report: GateReport = {
            stacks: ['node'],
            roots: [{ dir: '/tmp', relDir: '', stack: 'node', isWorkspaceMember: false }],
            results: [
                { step: 'build', command: 'npm run build', passed: true, skipped: false, output: '', durationMs: 100, relDir: '', mode: 'real', inconclusive: false },
            ],
            passed: true,
            inconclusive: false,
        };

        const md = gateReportToMarkdown(report);
        expect(md).toContain('| Dir | Stack | Step | Mode |');
        expect(md).toContain('| . | node | build | real |');
    });

    it('renders product verification section', () => {
        const report: GateReport = {
            stacks: ['node'],
            roots: [{ dir: '/tmp', relDir: '', stack: 'node', isWorkspaceMember: false }],
            results: [
                { step: 'build', command: 'npm run build', passed: false, skipped: false, output: 'error', durationMs: 100, relDir: '', mode: 'real' as const, inconclusive: false },
            ],
            passed: false,
            inconclusive: false,
            productVerify: {
                artifacts: [{ root: '', expectedDirs: ['dist'], foundDir: null, fileCount: 0, totalBytes: 0, hasEntryHtml: false, hasEntryJs: false, passed: false, reason: 'no artifacts' }],
                resolveIssues: [{ file: 'src/main.tsx', line: 4, specifier: './index.css', kind: 'import', reason: 'missing-file' }],
                smoke: null,
                passed: false,
                summary: 'FAILED',
            },
        };

        const md = gateReportToMarkdown(report);
        expect(md).toContain('Product verification');
        expect(md).toContain('Unresolved references');
        expect(md).toContain('./index.css');
    });
});
