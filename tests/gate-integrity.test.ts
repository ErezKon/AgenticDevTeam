/**
 * Tests for Sub-Plan 02 — Gate Integrity & Anti-Gaming.
 *
 * All offline, all fixture-based. Tests:
 *   - captureConfigBaseline
 *   - detectTampering (all TamperKind variants)
 *   - detectTrivialTests
 *   - Protected-path enforcement (workspace tools)
 *   - Shell denylist extensions
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    captureConfigBaseline,
    detectTampering,
    detectTrivialTests,
    findTestFiles,
    findProductSourceFiles,
    matchesProtectedGlob,
    countTestBlocks,
    NO_OP_SCRIPT_RE,
    PROTECTED_CONFIG_GLOBS,
    type ConfigBaseline,
} from '../src/conductor/gate-integrity';
import { createWorkspaceTools } from '../src/tools/fs/workspace-tools';
import { isDeniedCommand } from '../src/tools/shell/shell-tools';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/utils/logger', () => ({
    getLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
    logToolAction: jest.fn(),
}));
jest.mock('../src/utils/event-bus', () => ({
    emitRunEvent: jest.fn(),
}));
jest.mock('../src/config', () => ({
    GATE_INTEGRITY_MODE: 'enforce',
    FS_CONFIG_PROTECTION: 'deny',
    REJECT_TRIVIAL_TESTS: true,
    PRODUCT_RESOLVE_MAX_FILES: 2000,
    MAX_TOOL_RESULT_CHARS: 6000,
}));

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'gate-integrity', 'retro-math');

// ─── NO_OP_SCRIPT_RE ────────────────────────────────────────────────────────

describe('NO_OP_SCRIPT_RE', () => {
    it('matches "echo Build successful"', () => {
        expect(NO_OP_SCRIPT_RE.test('echo Build successful')).toBe(true);
    });
    it('matches "true"', () => {
        expect(NO_OP_SCRIPT_RE.test('true')).toBe(true);
    });
    it('matches ":"', () => {
        expect(NO_OP_SCRIPT_RE.test(':')).toBe(true);
    });
    it('matches "exit 0"', () => {
        expect(NO_OP_SCRIPT_RE.test('exit 0')).toBe(true);
    });
    it('matches "echo hi && true"', () => {
        expect(NO_OP_SCRIPT_RE.test('echo hi && true')).toBe(true);
    });
    it('matches "cd ."', () => {
        expect(NO_OP_SCRIPT_RE.test('cd .')).toBe(true);
    });
    it('does NOT match "tsc && vite build"', () => {
        expect(NO_OP_SCRIPT_RE.test('tsc && vite build')).toBe(false);
    });
    it('does NOT match "npm run build --workspaces"', () => {
        expect(NO_OP_SCRIPT_RE.test('npm run build --workspaces')).toBe(false);
    });
    it('does NOT match "jest"', () => {
        expect(NO_OP_SCRIPT_RE.test('jest')).toBe(false);
    });
});

// ─── matchesProtectedGlob ───────────────────────────────────────────────────

describe('matchesProtectedGlob', () => {
    it('matches package.json', () => {
        expect(matchesProtectedGlob('package.json', PROTECTED_CONFIG_GLOBS)).toBe(true);
    });
    it('matches tsconfig.json', () => {
        expect(matchesProtectedGlob('tsconfig.json', PROTECTED_CONFIG_GLOBS)).toBe(true);
    });
    it('matches tsconfig.build.json', () => {
        expect(matchesProtectedGlob('tsconfig.build.json', PROTECTED_CONFIG_GLOBS)).toBe(true);
    });
    it('matches jest.config.ts', () => {
        expect(matchesProtectedGlob('jest.config.ts', PROTECTED_CONFIG_GLOBS)).toBe(true);
    });
    it('matches .eslintrc.json', () => {
        expect(matchesProtectedGlob('.eslintrc.json', PROTECTED_CONFIG_GLOBS)).toBe(true);
    });
    it('matches .gitignore', () => {
        expect(matchesProtectedGlob('.gitignore', PROTECTED_CONFIG_GLOBS)).toBe(true);
    });
    it('does NOT match src/index.ts', () => {
        expect(matchesProtectedGlob('src/index.ts', PROTECTED_CONFIG_GLOBS)).toBe(false);
    });
    it('does NOT match README.md', () => {
        expect(matchesProtectedGlob('README.md', PROTECTED_CONFIG_GLOBS)).toBe(false);
    });
});

// ─── countTestBlocks ────────────────────────────────────────────────────────

describe('countTestBlocks', () => {
    it('counts test blocks', () => {
        const content = `
            test('a', () => {});
            it('b', () => {});
            test('c', () => {});
        `;
        expect(countTestBlocks(content)).toEqual({ tests: 3, skipped: 0 });
    });

    it('counts skipped blocks', () => {
        const content = `
            test('a', () => {});
            it.skip('b', () => {});
            xit('c', () => {});
            describe.skip('d', () => {});
        `;
        expect(countTestBlocks(content)).toEqual({ tests: 1, skipped: 3 });
    });
});

// ─── captureConfigBaseline ──────────────────────────────────────────────────

describe('captureConfigBaseline', () => {
    it('captures scripts from package.json', () => {
        const baseline = captureConfigBaseline(FIXTURE_DIR, [{ dir: FIXTURE_DIR, relDir: '', stack: 'node', isWorkspaceMember: false }]);
        expect(baseline.scripts['package.json']).toEqual({
            build: 'echo Build successful',
            test: 'npx jest',
        });
    });

    it('captures test files', () => {
        const baseline = captureConfigBaseline(FIXTURE_DIR, [{ dir: FIXTURE_DIR, relDir: '', stack: 'node', isWorkspaceMember: false }]);
        expect(baseline.testFiles).toContain('__tests__/math.test.js');
        expect(baseline.testFiles).toContain(path.join('src', 'components', 'Board.test.tsx'));
    });

    it('captures test counts', () => {
        const baseline = captureConfigBaseline(FIXTURE_DIR, [{ dir: FIXTURE_DIR, relDir: '', stack: 'node', isWorkspaceMember: false }]);
        expect(baseline.testCounts['__tests__/math.test.js']).toEqual({ tests: 1, skipped: 0 });
    });

    it('stores protected file bodies', () => {
        const baseline = captureConfigBaseline(FIXTURE_DIR, [{ dir: FIXTURE_DIR, relDir: '', stack: 'node', isWorkspaceMember: false }]);
        expect(baseline.protectedBodies['package.json']).toBeDefined();
        expect(baseline.protectedBodies['package.json']).toContain('"echo Build successful"');
    });

    it('has a capturedAt timestamp', () => {
        const baseline = captureConfigBaseline(FIXTURE_DIR, [{ dir: FIXTURE_DIR, relDir: '', stack: 'node', isWorkspaceMember: false }]);
        expect(baseline.capturedAt).toBeTruthy();
        expect(new Date(baseline.capturedAt).getTime()).toBeGreaterThan(0);
    });
});

// ─── detectTampering ────────────────────────────────────────────────────────

describe('detectTampering', () => {
    function makeBaseline(overrides: Partial<ConfigBaseline> = {}): ConfigBaseline {
        return {
            capturedAt: new Date().toISOString(),
            fileHashes: {},
            scripts: { 'package.json': { build: 'npm run build --workspaces', test: 'jest', lint: 'eslint .', typecheck: 'tsc --noEmit' } },
            deps: { 'package.json': { react: '^18.0.0', 'react-dom': '^18.0.0', typescript: '^5.0.0', jest: '^29.0.0', '@testing-library/jest-dom': '^6.0.0', vite: '^5.0.0' } },
            testFiles: ['src/board.test.ts', 'src/app.test.ts'],
            testCounts: { 'src/board.test.ts': { tests: 5, skipped: 0 }, 'src/app.test.ts': { tests: 3, skipped: 0 } },
            protectedBodies: {
                'package.json': JSON.stringify({
                    name: 'retroboard3', private: true,
                    workspaces: ['packages/*'],
                    scripts: { build: 'npm run build --workspaces', test: 'jest', lint: 'eslint .', typecheck: 'tsc --noEmit' },
                    dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
                    devDependencies: { typescript: '^5.0.0', jest: '^29.0.0', '@testing-library/jest-dom': '^6.0.0', vite: '^5.0.0' },
                }),
            },
            ...overrides,
        };
    }

    it('detects script-neutered: "build" → "echo Build successful" (the retroboard3 case)', () => {
        const before = makeBaseline();
        const after = makeBaseline({
            scripts: { 'package.json': { build: 'echo Build successful', test: 'npx jest', lint: 'eslint .', typecheck: 'tsc --noEmit' } },
        });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        const neutered = findings.filter(f => f.kind === 'script-neutered');
        expect(neutered.length).toBeGreaterThanOrEqual(1);
        expect(neutered[0].severity).toBe('critical');
        expect(neutered[0].detail).toContain('echo Build successful');
    });

    it('detects script-weakened: "vite build" → "vite build || true"', () => {
        const before = makeBaseline({ scripts: { 'package.json': { build: 'vite build', test: 'jest' } } });
        const after = makeBaseline({ scripts: { 'package.json': { build: 'vite build || true', test: 'jest' } } });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        expect(findings.some(f => f.kind === 'script-weakened')).toBe(true);
    });

    it('detects script-weakened: "jest" → "jest --passWithNoTests"', () => {
        const before = makeBaseline({ scripts: { 'package.json': { test: 'jest' } } });
        const after = makeBaseline({ scripts: { 'package.json': { test: 'jest --passWithNoTests' } } });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        expect(findings.some(f => f.kind === 'script-weakened')).toBe(true);
    });

    it('detects script-removed', () => {
        const before = makeBaseline({ scripts: { 'package.json': { build: 'vite build', test: 'jest' } } });
        const after = makeBaseline({ scripts: { 'package.json': {} } });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        const removed = findings.filter(f => f.kind === 'script-removed');
        expect(removed.length).toBeGreaterThanOrEqual(1);
        expect(removed[0].severity).toBe('critical');
    });

    it('detects workspaces-removed (the retroboard3 delta)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-int-'));
        // Write a package.json WITHOUT workspaces
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'retroboard3', private: true,
            scripts: { build: 'npm run build --workspaces', test: 'jest' },
        }));
        const before = makeBaseline();
        const after = makeBaseline();
        const findings = detectTampering(before, after, tmpDir);
        expect(findings.some(f => f.kind === 'workspaces-removed')).toBe(true);
        // Cleanup
        fs.rmSync(tmpDir, { recursive: true });
    });

    it('detects deps-removed (6 deps from retroboard3)', () => {
        const before = makeBaseline();
        const after = makeBaseline({ deps: { 'package.json': {} } });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        const depsRemoved = findings.filter(f => f.kind === 'deps-removed');
        expect(depsRemoved.length).toBe(6);
    });

    it('detects test-file-deleted', () => {
        const before = makeBaseline();
        const after = makeBaseline({ testFiles: ['src/app.test.ts'] }); // board.test.ts removed
        const findings = detectTampering(before, after, FIXTURE_DIR);
        expect(findings.some(f => f.kind === 'test-file-deleted' && f.file === 'src/board.test.ts')).toBe(true);
        expect(findings.find(f => f.kind === 'test-file-deleted')!.severity).toBe('critical');
    });

    it('does NOT flag a moved test file', () => {
        const before = makeBaseline({ testFiles: ['src/board.test.ts'] });
        const after = makeBaseline({ testFiles: ['tests/board.test.ts'] });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        expect(findings.some(f => f.kind === 'test-file-deleted')).toBe(false);
    });

    it('detects test-skipped (it → it.skip)', () => {
        const before = makeBaseline({ testCounts: { 'src/board.test.ts': { tests: 5, skipped: 0 } } });
        const after = makeBaseline({ testCounts: { 'src/board.test.ts': { tests: 5, skipped: 2 } } });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        expect(findings.some(f => f.kind === 'test-skipped')).toBe(true);
    });

    it('detects test-count-reduced', () => {
        const before = makeBaseline({ testCounts: { 'src/board.test.ts': { tests: 5, skipped: 0 } } });
        const after = makeBaseline({ testCounts: { 'src/board.test.ts': { tests: 3, skipped: 0 } } });
        const findings = detectTampering(before, after, FIXTURE_DIR);
        expect(findings.some(f => f.kind === 'test-count-reduced')).toBe(true);
    });

    it('detects typecheck-weakened: strict true→false', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-int-'));
        const tscBody = JSON.stringify({ compilerOptions: { strict: false } });
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), tscBody);

        const before = makeBaseline({
            fileHashes: { 'tsconfig.json': 'old' },
            protectedBodies: { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }) },
        });
        const after = makeBaseline({
            fileHashes: { 'tsconfig.json': 'new' },
        });
        const findings = detectTampering(before, after, tmpDir);
        expect(findings.some(f => f.kind === 'typecheck-weakened' && f.detail.includes('strict'))).toBe(true);
        fs.rmSync(tmpDir, { recursive: true });
    });

    it('returns >= 3 critical findings for the full retroboard3 scenario', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-int-'));
        // Write the gamed package.json
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'retroboard3', private: true,
            scripts: { build: 'echo Build successful', test: 'npx jest' },
            devDependencies: { '@testing-library/jest-dom': '^6.9.1' },
        }));

        const before = makeBaseline();
        const after = makeBaseline({
            scripts: { 'package.json': { build: 'echo Build successful', test: 'npx jest' } },
            deps: { 'package.json': { '@testing-library/jest-dom': '^6.9.1' } },
            testFiles: ['__tests__/math.test.js'],
            testCounts: { '__tests__/math.test.js': { tests: 1, skipped: 0 } },
        });

        const findings = detectTampering(before, after, tmpDir);
        const criticals = findings.filter(f => f.severity === 'critical');
        expect(criticals.length).toBeGreaterThanOrEqual(3);
        fs.rmSync(tmpDir, { recursive: true });
    });
});

// ─── detectTrivialTests ─────────────────────────────────────────────────────

describe('detectTrivialTests', () => {
    it('flags __tests__/math.test.js as subject-not-in-product', () => {
        const testFiles = findTestFiles(FIXTURE_DIR);
        const productFiles = findProductSourceFiles(FIXTURE_DIR);
        const findings = detectTrivialTests(FIXTURE_DIR, testFiles, productFiles);

        const mathFinding = findings.find(f => f.file === '__tests__/math.test.js');
        expect(mathFinding).toBeDefined();
        expect(mathFinding!.reason).toBe('subject-not-in-product');
    });

    it('does NOT flag Board.test.tsx (Board is imported by App, reachable from entry)', () => {
        const testFiles = findTestFiles(FIXTURE_DIR);
        const productFiles = findProductSourceFiles(FIXTURE_DIR);
        const findings = detectTrivialTests(FIXTURE_DIR, testFiles, productFiles);

        const boardFinding = findings.find(f => f.file.includes('Board.test.tsx'));
        expect(boardFinding).toBeUndefined();
    });

    it('detects single-arithmetic-test', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivial-'));
        const testContent = `const { add } = require('./math');\ntest('adds', () => { expect(add(2, 3)).toBe(5); });`;
        fs.writeFileSync(path.join(tmpDir, 'arith.test.js'), testContent);

        const findings = detectTrivialTests(tmpDir, ['arith.test.js'], []);
        // Should be flagged either as no-product-import or single-arithmetic-test
        expect(findings.length).toBeGreaterThanOrEqual(1);
        fs.rmSync(tmpDir, { recursive: true });
    });
});

// ─── Protected paths (workspace tools) ──────────────────────────────────────

describe('createWorkspaceTools with protection', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-protect-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "name": "test" }');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it('deny mode: write_file to package.json returns REFUSED', async () => {
        const tools = createWorkspaceTools(tmpDir, { protectionMode: 'deny' });
        const writeTool = tools.find(t => t.name === 'write_file')!;
        const result = await writeTool.invoke({ filePath: 'package.json', content: '{}' });
        expect(result).toContain('REFUSED');
        // Verify file was NOT changed
        expect(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8')).toBe('{ "name": "test" }');
    });

    it('deny mode: edit_file on package.json returns REFUSED', async () => {
        const tools = createWorkspaceTools(tmpDir, { protectionMode: 'deny' });
        const editTool = tools.find(t => t.name === 'edit_file')!;
        const result = await editTool.invoke({ filePath: 'package.json', oldString: '"test"', newString: '"hacked"' });
        expect(result).toContain('REFUSED');
        // Verify file was NOT changed
        expect(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8')).toBe('{ "name": "test" }');
    });

    it('warn mode: write_file to package.json succeeds', async () => {
        const tools = createWorkspaceTools(tmpDir, { protectionMode: 'warn' });
        const writeTool = tools.find(t => t.name === 'write_file')!;
        const result = await writeTool.invoke({ filePath: 'package.json', content: '{ "name": "updated" }' });
        expect(result).toContain('File written');
    });

    it('off mode: write_file to package.json succeeds silently', async () => {
        const tools = createWorkspaceTools(tmpDir, { protectionMode: 'off' });
        const writeTool = tools.find(t => t.name === 'write_file')!;
        const result = await writeTool.invoke({ filePath: 'package.json', content: '{ "name": "updated" }' });
        expect(result).toContain('File written');
    });

    it('deny mode: write_file to src/index.ts succeeds (not protected)', async () => {
        const tools = createWorkspaceTools(tmpDir, { protectionMode: 'deny' });
        const writeTool = tools.find(t => t.name === 'write_file')!;
        const result = await writeTool.invoke({ filePath: 'src/index.ts', content: 'export const x = 2;' });
        expect(result).toContain('File written');
    });
});

// ─── Shell denylist extensions ──────────────────────────────────────────────

describe('shell denylist (gate integrity)', () => {
    it('denies npm pkg set scripts.build="echo hi"', () => {
        expect(isDeniedCommand('npm pkg set scripts.build="echo hi"').denied).toBe(true);
    });

    it('denies npm pkg delete scripts.test', () => {
        expect(isDeniedCommand('npm pkg delete scripts.test').denied).toBe(true);
    });

    it('denies git checkout -- package.json', () => {
        expect(isDeniedCommand('git checkout -- package.json').denied).toBe(true);
    });

    it('denies git restore package.json', () => {
        expect(isDeniedCommand('git restore package.json').denied).toBe(true);
    });

    it('denies sed -i targeting package.json', () => {
        expect(isDeniedCommand('sed -i "s/build/echo hi/" package.json').denied).toBe(true);
    });

    it('denies > package.json (shell redirect)', () => {
        expect(isDeniedCommand('echo "{}" > package.json').denied).toBe(true);
    });

    it('denies rm of a test file', () => {
        expect(isDeniedCommand('rm src/board.test.ts').denied).toBe(true);
    });

    it('allows npm install lodash', () => {
        expect(isDeniedCommand('npm install lodash').denied).toBe(false);
    });

    it('allows npm test', () => {
        expect(isDeniedCommand('npm test').denied).toBe(false);
    });

    it('allows npm run build', () => {
        expect(isDeniedCommand('npm run build').denied).toBe(false);
    });
});
