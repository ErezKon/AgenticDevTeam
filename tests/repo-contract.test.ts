/**
 * Tests for the Repo Contract schema, persistence, prompt rendering,
 * and derivation from codebase analysis.
 *
 * All offline, no LLM, no network. Tests:
 *   - RepoContractSchema validation (accept / reject)
 *   - renderContractForPrompt budget and formatting
 *   - writeRepoContract / readRepoContract round-trip
 *   - deriveContractFromAnalysis layout inference
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RepoContractSchema } from '../src/agents/_shared/schemas/repo-contract.schema';
import {
    writeRepoContract,
    readRepoContract,
    renderContractForPrompt,
    deriveContractFromAnalysis,
} from '../src/utils/repo-contract-writer';
import type { RepoContract } from '../src/agents/_shared/schemas/repo-contract.schema';
import type { CodebaseAnalysis } from '../src/agents/_shared/base-schemas';

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
    CONTRACT_PROMPT_MAX_CHARS: 6000,
    REPO_CONTRACT_MAX_MODULES: 60,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMinimalContract(): RepoContract {
    return {
        layout: 'single-root',
        roots: [{
            dir: '.',
            kind: 'frontend',
            stack: 'node',
            entryPoints: ['src/main.tsx'],
            sourceDirs: ['src/'],
            testDirs: ['src/__tests__/'],
            scripts: { build: 'vite build', test: 'jest' },
            buildOutputDir: 'dist',
        }],
        modules: [],
        namingConvention: 'PascalCase',
        sharedTypes: [],
        frozenPaths: [],
    };
}

function makeMinimalAnalysis(overrides: Partial<CodebaseAnalysis> = {}): CodebaseAnalysis {
    return {
        projectName: 'test-project',
        projectType: 'web app',
        primaryLanguages: ['TypeScript'],
        frameworks: ['React'],
        architecture: {
            style: 'monolith',
            description: 'Single-page app',
            mermaidDiagram: 'graph TD; A-->B',
        },
        modules: [],
        database: {
            hasExistingMigrations: false,
        },
        testing: {
            hasTests: false,
            frameworks: [],
        },
        buildAndDeploy: {
            containerized: false,
        },
        knownIssues: [],
        entryPoints: [],
        lastAnalyzedAt: new Date().toISOString(),
        fileTree: '.',
        ...overrides,
    };
}

// ─── RepoContractSchema ─────────────────────────────────────────────────────

describe('RepoContractSchema', () => {
    it('accepts a minimal single-root contract', () => {
        const minimal = {
            layout: 'single-root',
            roots: [{
                dir: '.',
                kind: 'frontend',
                stack: 'node',
                entryPoints: ['src/main.tsx'],
                sourceDirs: ['src/'],
                testDirs: ['src/__tests__/'],
                scripts: { build: 'vite build', test: 'jest' },
                buildOutputDir: 'dist',
            }],
            modules: [],
            namingConvention: 'PascalCase',
        };
        const result = RepoContractSchema.safeParse(minimal);
        expect(result.success).toBe(true);
    });

    it('rejects a contract with empty entryPoints', () => {
        const bad = {
            layout: 'single-root',
            roots: [{
                dir: '.',
                kind: 'frontend',
                stack: 'node',
                entryPoints: [],
                sourceDirs: ['src/'],
                testDirs: ['src/__tests__/'],
                scripts: { build: 'vite build', test: 'jest' },
                buildOutputDir: 'dist',
            }],
            modules: [],
            namingConvention: 'PascalCase',
        };
        const result = RepoContractSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects a contract with an echo build script (NO_OP_SCRIPT_RE refine)', () => {
        const bad = {
            layout: 'single-root',
            roots: [{
                dir: '.',
                kind: 'frontend',
                stack: 'node',
                entryPoints: ['src/main.tsx'],
                sourceDirs: ['src/'],
                testDirs: ['src/__tests__/'],
                scripts: { build: 'echo Build successful', test: 'jest' },
                buildOutputDir: 'dist',
            }],
            modules: [],
            namingConvention: 'PascalCase',
        };
        const result = RepoContractSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });

    it('rejects a module path containing "generated-projects/"', () => {
        const bad = {
            layout: 'single-root',
            roots: [{
                dir: '.',
                kind: 'frontend',
                stack: 'node',
                entryPoints: ['src/main.tsx'],
                sourceDirs: ['src/'],
                testDirs: ['src/__tests__/'],
                scripts: { build: 'vite build', test: 'jest' },
                buildOutputDir: 'dist',
            }],
            modules: [{
                id: 'MOD-BAD',
                path: 'generated-projects/foo/src/Bar.ts',
                componentName: 'Bad',
                exports: [],
                dependsOn: [],
            }],
            namingConvention: 'PascalCase',
        };
        const result = RepoContractSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });
});

// ─── renderContractForPrompt ────────────────────────────────────────────────

describe('renderContractForPrompt', () => {
    it('stays under CONTRACT_PROMPT_MAX_CHARS for a 60-module contract', () => {
        const contract = makeMinimalContract();
        for (let i = 0; i < 60; i++) {
            contract.modules.push({
                id: `MOD-${i}`,
                path: `src/modules/Module${i}.ts`,
                componentName: `Component${i}`,
                exports: [{ name: `fn${i}`, kind: 'function', signature: `fn${i}(): void` }],
                dependsOn: [],
            });
        }
        const rendered = renderContractForPrompt(contract);
        expect(rendered.length).toBeLessThanOrEqual(6000);
    });

    it('always includes owning modules in full when moduleIds is provided', () => {
        const contract = makeMinimalContract();
        contract.modules = [
            {
                id: 'MOD-MINE',
                path: 'src/Mine.ts',
                componentName: 'Mine',
                exports: [{ name: 'doStuff', kind: 'function', signature: 'doStuff(): void' }],
                dependsOn: ['MOD-OTHER'],
            },
            {
                id: 'MOD-OTHER',
                path: 'src/Other.ts',
                componentName: 'Other',
                exports: [{ name: 'helper', kind: 'function', signature: 'helper(): string' }],
                dependsOn: [],
            },
        ];
        const rendered = renderContractForPrompt(contract, { moduleIds: ['MOD-MINE'] });
        expect(rendered).toContain('Your modules:');
        expect(rendered).toContain('MOD-MINE');
        expect(rendered).toContain('doStuff');
        expect(rendered).toContain('depends on: MOD-OTHER');
    });

    it('produces expected format with roots and modules sections', () => {
        const contract = makeMinimalContract();
        contract.modules = [{
            id: 'MOD-APP',
            path: 'src/App.tsx',
            componentName: 'UI',
            exports: [{ name: 'default', kind: 'default', signature: 'App(): JSX.Element' }],
            dependsOn: [],
        }];
        const rendered = renderContractForPrompt(contract);
        expect(rendered).toContain('## Repo Contract (binding');
        expect(rendered).toContain('Layout: single-root');
        expect(rendered).toContain('Root `.`');
        expect(rendered).toContain('entry src/main.tsx');
        expect(rendered).toContain('MOD-APP');
    });
});

// ─── writeRepoContract / readRepoContract ───────────────────────────────────

describe('writeRepoContract / readRepoContract', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-contract-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true });
    });

    it('round-trip: write then read returns same contract', () => {
        const contract = makeMinimalContract();
        writeRepoContract(tmpDir, contract);
        const read = readRepoContract(tmpDir);
        expect(read).not.toBeNull();
        expect(read!.layout).toBe(contract.layout);
        expect(read!.roots.length).toBe(contract.roots.length);
        expect(read!.roots[0].dir).toBe(contract.roots[0].dir);
        expect(read!.roots[0].entryPoints).toEqual(contract.roots[0].entryPoints);
        expect(read!.modules).toEqual(contract.modules);
        expect(read!.namingConvention).toBe(contract.namingConvention);
    });

    it('readRepoContract returns null on missing file', () => {
        const result = readRepoContract(tmpDir);
        expect(result).toBeNull();
    });

    it('writeRepoContract creates .agent/repo-contract.json and docs/ARCHITECTURE-CONTRACT.md', () => {
        const contract = makeMinimalContract();
        const { jsonPath, mdPath } = writeRepoContract(tmpDir, contract);
        expect(fs.existsSync(jsonPath)).toBe(true);
        expect(fs.existsSync(mdPath)).toBe(true);
        expect(jsonPath).toContain('.agent/repo-contract.json');
        expect(mdPath).toContain('docs/ARCHITECTURE-CONTRACT.md');
    });
});

// ─── deriveContractFromAnalysis ─────────────────────────────────────────────

describe('deriveContractFromAnalysis', () => {
    it('on a fixture mirroring npm-workspaces monorepo, yields layout: npm-workspaces', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-contract-'));

        // Build workspace structure
        fs.writeFileSync(
            path.join(tmpDir, 'package.json'),
            JSON.stringify({
                workspaces: ['packages/*'],
                scripts: { build: 'npm run build --workspaces' },
            }),
        );

        // packages/frontend
        fs.mkdirSync(path.join(tmpDir, 'packages', 'frontend', 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'packages', 'frontend', 'package.json'),
            JSON.stringify({ scripts: { build: 'vite build', test: 'jest' } }),
        );
        fs.writeFileSync(path.join(tmpDir, 'packages', 'frontend', 'src', 'main.tsx'), '');

        // packages/backend
        fs.mkdirSync(path.join(tmpDir, 'packages', 'backend', 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'packages', 'backend', 'package.json'),
            JSON.stringify({ scripts: { build: 'tsc', test: 'jest' } }),
        );
        fs.writeFileSync(path.join(tmpDir, 'packages', 'backend', 'src', 'index.ts'), '');

        const analysis = makeMinimalAnalysis({
            entryPoints: [
                { file: 'packages/frontend/src/main.tsx', description: 'Frontend entry' },
                { file: 'packages/backend/src/index.ts', description: 'Backend entry' },
            ],
        });

        const contract = deriveContractFromAnalysis(analysis, tmpDir);
        expect(contract.layout).toBe('npm-workspaces');

        fs.rmSync(tmpDir, { recursive: true });
    });
});
