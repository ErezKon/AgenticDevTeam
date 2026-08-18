/**
 * Tests for src/conductor/layout-lint.ts — LayoutLint mechanical enforcement.
 *
 * All offline, fixture-based. Tests:
 *   - unknown-root / file-outside-source-dirs detection (retro-split fixture)
 *   - duplicate-module detection (pacman-duplicate fixture)
 *   - missing-declared-export detection (missing-export fixture)
 *   - clean fixture produces zero violations
 *   - entrypoint-missing when entry point does not exist on disk
 */
import * as path from 'path';
import { lintLayout } from '../src/conductor/layout-lint';
import type { RepoContract } from '../src/agents/_shared/schemas/repo-contract.schema';
import { findProductSourceFiles } from '../src/conductor/gate-integrity';
import { buildImportGraph, transitiveReachable } from '../src/utils/source-graph';

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
    REPO_CONTRACT_MODE: 'enforce',
    REPO_CONTRACT_MAX_MODULES: 60,
}));
jest.mock('../src/conductor/gate-integrity', () => ({
    findProductSourceFiles: jest.fn().mockReturnValue([]),
    NO_OP_SCRIPT_RE: /^\s*(echo\b.*|true|:|exit\s+0)\s*$/i,
}));
jest.mock('../src/utils/source-graph', () => ({
    buildImportGraph: jest.fn().mockReturnValue(new Map()),
    extractImportSpecifiers: jest.fn().mockReturnValue([]),
    transitiveReachable: jest.fn().mockReturnValue(new Set()),
}));

const mockedBuildImportGraph = buildImportGraph as jest.MockedFunction<typeof buildImportGraph>;
const mockedTransitiveReachable = transitiveReachable as jest.MockedFunction<typeof transitiveReachable>;
const mockedFindProductSourceFiles = findProductSourceFiles as jest.MockedFunction<typeof findProductSourceFiles>;

// ─── Fixture paths ──────────────────────────────────────────────────────────

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'layout-lint');
const RETRO_SPLIT = path.join(FIXTURE_ROOT, 'retro-split');
const PACMAN_DUPLICATE = path.join(FIXTURE_ROOT, 'pacman-duplicate');
const MISSING_EXPORT = path.join(FIXTURE_ROOT, 'missing-export');
const CLEAN = path.join(FIXTURE_ROOT, 'clean');

// ─── Contracts ──────────────────────────────────────────────────────────────

const retroSplitContract: RepoContract = {
    layout: 'npm-workspaces',
    roots: [{
        dir: 'packages/frontend',
        kind: 'frontend',
        stack: 'node',
        entryPoints: ['src/main.tsx'],
        sourceDirs: ['src'],
        testDirs: ['src/__tests__'],
        scripts: { build: 'vite build', test: 'jest' },
        buildOutputDir: 'dist',
    }],
    modules: [{
        id: 'MOD-APP',
        path: 'packages/frontend/src/App.tsx',
        componentName: 'UI',
        exports: [{ name: 'default', kind: 'default', signature: 'App(): JSX.Element' }],
        dependsOn: [],
    }],
    namingConvention: 'PascalCase',
    sharedTypes: [],
    frozenPaths: [],
};

const pacmanDuplicateContract: RepoContract = {
    layout: 'single-root',
    roots: [{
        dir: '.',
        kind: 'frontend',
        stack: 'node',
        entryPoints: ['src/main.tsx'],
        sourceDirs: ['src', 'src/hooks'],
        testDirs: ['src/__tests__'],
        scripts: { build: 'vite build', test: 'jest' },
        buildOutputDir: 'dist',
    }],
    modules: [
        {
            id: 'MOD-INPUT',
            path: 'src/InputHandler.ts',
            componentName: 'Input',
            exports: [{ name: 'handleInput', kind: 'function', signature: 'handleInput(): void' }],
            dependsOn: [],
        },
        {
            id: 'MOD-USE-INPUT',
            path: 'src/hooks/useInputHandler.ts',
            componentName: 'Input',
            exports: [{ name: 'useInputHandler', kind: 'hook', signature: 'useInputHandler(): void' }],
            dependsOn: [],
        },
    ],
    namingConvention: 'PascalCase',
    sharedTypes: [],
    frozenPaths: [],
};

const missingExportContract: RepoContract = {
    layout: 'single-root',
    roots: [{
        dir: '.',
        kind: 'frontend',
        stack: 'node',
        entryPoints: ['src/main.tsx'],
        sourceDirs: ['src'],
        testDirs: ['src/__tests__'],
        scripts: { build: 'vite build', test: 'jest' },
        buildOutputDir: 'dist',
    }],
    modules: [{
        id: 'MOD-GHOST-AI',
        path: 'src/GhostAI.ts',
        componentName: 'AI',
        exports: [{ name: 'chooseTarget', kind: 'function', signature: 'chooseTarget(): void' }],
        dependsOn: [],
    }],
    namingConvention: 'PascalCase',
    sharedTypes: [],
    frozenPaths: [],
};

const cleanContract: RepoContract = {
    layout: 'single-root',
    roots: [{
        dir: '.',
        kind: 'frontend',
        stack: 'node',
        entryPoints: ['src/main.tsx'],
        sourceDirs: ['src'],
        testDirs: ['src/__tests__'],
        scripts: { build: 'vite build', test: 'jest' },
        buildOutputDir: 'dist',
    }],
    modules: [{
        id: 'MOD-APP',
        path: 'src/App.tsx',
        componentName: 'UI',
        exports: [{ name: 'default', kind: 'default', signature: 'App(): JSX.Element' }],
        dependsOn: [],
    }],
    namingConvention: 'PascalCase',
    sharedTypes: [],
    frozenPaths: [],
};

// ─── lintLayout ─────────────────────────────────────────────────────────────

describe('lintLayout', () => {
    beforeEach(() => {
        mockedBuildImportGraph.mockReturnValue(new Map());
        mockedFindProductSourceFiles.mockReturnValue([]);
    });

    it('retro-split fixture produces >= 2 file-outside-source-dirs violations for root src/ files', () => {
        const violations = lintLayout(RETRO_SPLIT, retroSplitContract);
        // Files in root src/ are not under the declared root packages/frontend,
        // so they surface as unknown-root (even stricter than file-outside-source-dirs).
        const outside = violations.filter(
            v => v.kind === 'file-outside-source-dirs' || v.kind === 'unknown-root',
        );
        expect(outside.length).toBeGreaterThanOrEqual(2);
        const flaggedPaths = outside.map(v => v.path);
        expect(flaggedPaths.some(p => p.includes('src/components/Board.tsx'))).toBe(true);
        expect(flaggedPaths.some(p => p.includes('src/server.ts'))).toBe(true);
    });

    it('pacman-duplicate fixture produces >= 1 duplicate-module violation', () => {
        const violations = lintLayout(PACMAN_DUPLICATE, pacmanDuplicateContract);
        const dupes = violations.filter(v => v.kind === 'duplicate-module');
        expect(dupes.length).toBeGreaterThanOrEqual(1);
        const detail = dupes.map(v => v.detail).join(' ');
        expect(detail.toLowerCase()).toContain('inputhandler');
    });

    it('missing-export fixture produces 1 missing-declared-export violation', () => {
        const violations = lintLayout(MISSING_EXPORT, missingExportContract);
        const missing = violations.filter(v => v.kind === 'missing-declared-export');
        expect(missing.length).toBe(1);
        expect(missing[0].detail).toContain('chooseTarget');
    });

    it('clean fixture produces zero violations', () => {
        // Provide a realistic import graph so entrypoint-does-not-compose
        // does not fire: main.tsx transitively reaches App.tsx.
        const mainAbs = path.join(CLEAN, 'src', 'main.tsx');
        const appAbs = path.join(CLEAN, 'src', 'App.tsx');
        const graph = new Map<string, Set<string>>();
        graph.set(mainAbs, new Set([appAbs]));
        mockedBuildImportGraph.mockReturnValue(graph);
        mockedFindProductSourceFiles.mockReturnValue([mainAbs, appAbs]);
        mockedTransitiveReachable.mockReturnValue(new Set([mainAbs, appAbs]));

        const violations = lintLayout(CLEAN, cleanContract);
        expect(violations.length).toBe(0);
    });

    it('returns entrypoint-missing when entry point does not exist on disk', () => {
        const contract: RepoContract = {
            ...cleanContract,
            roots: [{
                ...cleanContract.roots[0],
                entryPoints: ['src/nonexistent-entry.tsx'],
            }],
        };
        const violations = lintLayout(CLEAN, contract);
        const epMissing = violations.filter(v => v.kind === 'entrypoint-missing');
        expect(epMissing.length).toBe(1);
        expect(epMissing[0].severity).toBe('critical');
        expect(epMissing[0].detail).toContain('nonexistent-entry.tsx');
    });
});
