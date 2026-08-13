/**
 * DevOps Fallback — unit tests for generateFallbackDeployment.
 * Sub-Plan 11 Work Item 2.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateFallbackDeployment } from '../src/conductor/devops-fallback';
import type { StackRoot } from '../src/conductor/quality-gates';

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'devops-fallback-'));
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function makeRoot(overrides: Partial<StackRoot> = {}): StackRoot {
    return {
        dir: overrides.dir ?? '.',
        relDir: overrides.relDir ?? '',
        stack: overrides.stack ?? 'node',
        isWorkspaceMember: overrides.isWorkspaceMember ?? false,
    } as StackRoot;
}

describe('generateFallbackDeployment', () => {
    let tempDir: string;
    beforeEach(() => { tempDir = makeTempDir(); });
    afterEach(() => { cleanupDir(tempDir); });

    it('generates a SPA Dockerfile for a frontend root with buildOutputDir', () => {
        const roots = [makeRoot({ dir: tempDir, relDir: '', stack: 'node' })];
        const contract = {
            layout: 'single-root' as const,
            roots: [{ dir: '.', kind: 'frontend' as const, stack: 'node', entryPoints: [], sourceDirs: ['src'], testDirs: ['tests'], scripts: {}, buildOutputDir: 'dist' }],
            modules: [], namingConvention: '', sharedTypes: [], frozenPaths: [],
        };
        const result = generateFallbackDeployment(tempDir, roots, contract);
        expect(result.files.length).toBeGreaterThan(0);
        expect(result.composeServices.length).toBe(1);
        const df = fs.readFileSync(path.join(tempDir, 'Dockerfile'), 'utf-8');
        expect(df).toContain('nginx:alpine');
        expect(df).toContain('/dist');
        expect(df).toContain('npm config set strict-ssl false');
    });

    it('generates a Node server Dockerfile for a backend root', () => {
        const roots = [makeRoot({ dir: tempDir, relDir: '', stack: 'node' })];
        const contract = {
            layout: 'single-root' as const,
            roots: [{ dir: '.', kind: 'backend' as const, stack: 'node', entryPoints: ['src/server.ts'], sourceDirs: ['src'], testDirs: ['tests'], scripts: {}, buildOutputDir: null }],
            modules: [], namingConvention: '', sharedTypes: [], frozenPaths: [],
        };
        const result = generateFallbackDeployment(tempDir, roots, contract);
        expect(result.files.length).toBeGreaterThan(0);
        const df = fs.readFileSync(path.join(tempDir, 'Dockerfile'), 'utf-8');
        expect(df).toContain('node:20-alpine');
        expect(df).toContain('--omit=dev');
    });

    it('generates two services for a monorepo with frontend and backend', () => {
        const feDir = path.join(tempDir, 'packages', 'frontend');
        const beDir = path.join(tempDir, 'packages', 'backend');
        fs.mkdirSync(feDir, { recursive: true });
        fs.mkdirSync(beDir, { recursive: true });
        const roots = [
            makeRoot({ dir: feDir, relDir: 'packages/frontend', stack: 'node' }),
            makeRoot({ dir: beDir, relDir: 'packages/backend', stack: 'node' }),
        ];
        const contract = {
            layout: 'npm-workspaces' as const,
            roots: [
                { dir: 'packages/frontend', kind: 'frontend' as const, stack: 'node', entryPoints: [], sourceDirs: ['src'], testDirs: [], scripts: {}, buildOutputDir: 'dist' },
                { dir: 'packages/backend', kind: 'backend' as const, stack: 'node', entryPoints: ['src/index.ts'], sourceDirs: ['src'], testDirs: [], scripts: {}, buildOutputDir: null },
            ],
            modules: [], namingConvention: '', sharedTypes: [], frozenPaths: [],
        };
        const result = generateFallbackDeployment(tempDir, roots, contract);
        expect(result.composeServices.length).toBe(2);
        expect(fs.existsSync(path.join(tempDir, 'docker-compose.yml'))).toBe(true);
    });

    it('applies patchDockerfilesSsl (npm config set strict-ssl false)', () => {
        const roots = [makeRoot({ dir: tempDir, relDir: '', stack: 'node' })];
        const result = generateFallbackDeployment(tempDir, roots, null);
        expect(result.files.length).toBeGreaterThan(0);
        const df = fs.readFileSync(path.join(tempDir, 'Dockerfile'), 'utf-8');
        expect(df).toContain('strict-ssl false');
    });

    it('skips roots that already have a Dockerfile', () => {
        fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM node:20', 'utf-8');
        const roots = [makeRoot({ dir: tempDir, relDir: '', stack: 'node' })];
        const result = generateFallbackDeployment(tempDir, roots, null);
        expect(result.files.length).toBe(0);
        expect(result.composeServices.length).toBe(0);
    });
});
