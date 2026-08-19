/**
 * Tests for deterministic merge conflict resolution (Sub-Plan 06 SS5c).
 */
import { compareSemverRange, listConflictedFiles, resolveKnownConflicts } from '../src/conductor/merge-resolve';
import { execSync } from 'child_process';
import * as fs from 'fs';

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));
jest.mock('child_process', () => ({
    execSync: jest.fn(),
}));
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    writeFileSync: jest.fn(),
}));

const mockedExecSync = execSync as unknown as jest.Mock;

describe('compareSemverRange', () => {
    it('compares caret ranges numerically', () => {
        expect(compareSemverRange('^2.0.0', '^1.0.0')).toBeGreaterThan(0);
        expect(compareSemverRange('^1.0.0', '^2.0.0')).toBeLessThan(0);
        expect(compareSemverRange('^1.0.0', '^1.0.0')).toBe(0);
    });

    it('compares tilde ranges', () => {
        expect(compareSemverRange('~1.5.0', '~1.4.0')).toBeGreaterThan(0);
    });

    it('compares exact versions', () => {
        expect(compareSemverRange('3.0.0', '2.9.9')).toBeGreaterThan(0);
    });

    it('strips leading operators before comparing', () => {
        expect(compareSemverRange('>=2.0.0', '^1.0.0')).toBeGreaterThan(0);
        expect(compareSemverRange('~1.0.0', '>=1.0.0')).toBe(0);
    });

    it('handles patch-level differences', () => {
        expect(compareSemverRange('^1.0.3', '^1.0.2')).toBeGreaterThan(0);
        expect(compareSemverRange('^1.0.10', '^1.0.9')).toBeGreaterThan(0);
    });
});

// ─── listConflictedFiles ────────────────────────────────────────────────────

describe('listConflictedFiles', () => {
    beforeEach(() => {
        mockedExecSync.mockReset();
    });

    it('returns parsed file list from git diff output', () => {
        mockedExecSync.mockReturnValue('src/app.ts\npackage.json\n');
        const files = listConflictedFiles('/repo');
        expect(files).toEqual(['src/app.ts', 'package.json']);
    });

    it('returns empty array when output starts with "Error:"', () => {
        mockedExecSync.mockImplementation(() => {
            throw new Error('git failed');
        });
        // gitExecLocal catches and returns "Error: ..."
        // but listConflictedFiles is called via gitExecLocal which wraps execSync.
        // We need to simulate gitExecLocal returning an error string.
        // gitExecLocal catches the throw and returns `Error: ...`.
        const files = listConflictedFiles('/repo');
        expect(files).toEqual([]);
    });

    it('returns empty array on empty output', () => {
        mockedExecSync.mockReturnValue('');
        const files = listConflictedFiles('/repo');
        expect(files).toEqual([]);
    });

    it('trims whitespace from paths', () => {
        mockedExecSync.mockReturnValue('  src/app.ts  \n  lib/utils.ts  \n');
        const files = listConflictedFiles('/repo');
        expect(files).toEqual(['src/app.ts', 'lib/utils.ts']);
    });
});

// ─── resolveKnownConflicts ──────────────────────────────────────────────────

describe('resolveKnownConflicts', () => {
    beforeEach(() => {
        mockedExecSync.mockReset();
        (fs.writeFileSync as jest.Mock).mockReset();
    });

    it('resolves lockfile conflicts via checkout + npm install', () => {
        // All git commands succeed, npm install succeeds
        mockedExecSync.mockImplementation((cmd: string) => {
            if (typeof cmd === 'string' && cmd.includes('npm install')) return '';
            return '';
        });

        const result = resolveKnownConflicts('/repo', ['package-lock.json'], 'origin/main');
        expect(result.resolved).toContain('package-lock.json');
        expect(result.unresolved).toEqual([]);

        // Should have called git checkout for the base version
        const calls = mockedExecSync.mock.calls.map((c: any[]) => c[0]);
        expect(calls.some((c: string) => c.includes('checkout') && c.includes('package-lock.json'))).toBe(true);
        // Should have called npm install
        expect(calls.some((c: string) => c.includes('npm install'))).toBe(true);
    });

    it('resolves package.json via three-way merge', () => {
        const basePkg = JSON.stringify({
            name: 'test',
            scripts: { build: 'tsc' },
            dependencies: { lodash: '^4.17.0' },
            devDependencies: { jest: '^29.0.0' },
        });
        const oursPkg = JSON.stringify({
            name: 'test',
            scripts: { build: 'tsc', test: 'jest' },
            dependencies: { lodash: '^4.17.0', axios: '^1.0.0' },
            devDependencies: { jest: '^29.0.0' },
        });

        mockedExecSync.mockImplementation((cmd: string) => {
            if (typeof cmd === 'string') {
                if (cmd.includes('show') && cmd.includes('origin/main:package.json')) return basePkg;
                if (cmd.includes('show HEAD:package.json')) return oursPkg;
            }
            return '';
        });

        const result = resolveKnownConflicts('/repo', ['package.json'], 'origin/main');
        expect(result.resolved).toContain('package.json');
        expect(result.unresolved).toEqual([]);

        // Verify writeFileSync was called with merged content
        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenContent = (fs.writeFileSync as jest.Mock).mock.calls[0][1];
        const merged = JSON.parse(writtenContent);
        // scripts should come from base (frozen)
        expect(merged.scripts).toEqual({ build: 'tsc' });
        // dependencies should be unioned
        expect(merged.dependencies.axios).toBe('^1.0.0');
        expect(merged.dependencies.lodash).toBe('^4.17.0');
    });

    it('leaves source files (.ts) unresolved', () => {
        // isIdenticalOnBothSides returns false (different content on each side)
        mockedExecSync.mockImplementation((cmd: string) => {
            if (typeof cmd === 'string') {
                if (cmd.includes('show :2:src/app.ts')) return 'version A';
                if (cmd.includes('show :3:src/app.ts')) return 'version B';
            }
            return '';
        });

        const result = resolveKnownConflicts('/repo', ['src/app.ts'], 'origin/main');
        expect(result.resolved).toEqual([]);
        expect(result.unresolved).toContain('src/app.ts');
    });

    it('resolves identical add/add conflicts via checkout --ours', () => {
        const sameContent = 'export const FOO = 42;\n';
        mockedExecSync.mockImplementation((cmd: string) => {
            if (typeof cmd === 'string') {
                if (cmd.includes('show :2:src/const.ts')) return sameContent;
                if (cmd.includes('show :3:src/const.ts')) return sameContent;
            }
            return '';
        });

        const result = resolveKnownConflicts('/repo', ['src/const.ts'], 'origin/main');
        expect(result.resolved).toContain('src/const.ts');
        expect(result.unresolved).toEqual([]);

        const calls = mockedExecSync.mock.calls.map((c: any[]) => c[0]);
        expect(calls.some((c: string) => c.includes('checkout --ours'))).toBe(true);
    });

    it('handles mixed conflicts: lockfile resolved, source unresolved', () => {
        mockedExecSync.mockImplementation((cmd: string) => {
            if (typeof cmd === 'string') {
                // lockfile git commands succeed
                if (cmd.includes('npm install')) return '';
                // source file: different on both sides
                if (cmd.includes('show :2:src/app.ts')) return 'version A';
                if (cmd.includes('show :3:src/app.ts')) return 'version B';
            }
            return '';
        });

        const result = resolveKnownConflicts(
            '/repo',
            ['package-lock.json', 'src/app.ts'],
            'origin/main',
        );
        expect(result.resolved).toContain('package-lock.json');
        expect(result.unresolved).toContain('src/app.ts');
        expect(result.resolved).toHaveLength(1);
        expect(result.unresolved).toHaveLength(1);
    });
});
