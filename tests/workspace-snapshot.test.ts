/**
 * Workspace snapshot — unit tests.
 *
 * Sub-Plan 08 §2: verifies the snapshot includes verbatim scripts and stays
 * under SNAPSHOT_MAX_CHARS for a tree with many files.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildWorkspaceSnapshot } from '../src/conductor/workspace-snapshot';

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

describe('Workspace Snapshot', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-snap-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes the verbatim scripts block from package.json', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'test-project',
            scripts: {
                build: 'tsc && vite build',
                test: 'jest --coverage',
                lint: 'eslint src/',
            },
            dependencies: { react: '^18.0.0' },
        }));
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;');

        const snap = buildWorkspaceSnapshot(tmpDir, { maxFiles: 400, maxChars: 8000 });

        expect(snap).toContain('"build": "tsc && vite build"');
        expect(snap).toContain('"test": "jest --coverage"');
        expect(snap).toContain('"lint": "eslint src/"');
    });

    it('stays under maxChars for a large file tree', () => {
        // Create 200 files across directories
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'big-project',
            scripts: { build: 'tsc', test: 'jest' },
            dependencies: { react: '18.0.0', express: '4.0.0', lodash: '4.17.0' },
            devDependencies: { jest: '29.0.0', typescript: '5.0.0' },
        }));

        for (let d = 0; d < 10; d++) {
            const dir = path.join(tmpDir, 'src', `module-${d}`);
            fs.mkdirSync(dir, { recursive: true });
            for (let f = 0; f < 20; f++) {
                fs.writeFileSync(path.join(dir, `file-${f}.ts`), `export const x${f} = ${f};`);
            }
        }

        const snap = buildWorkspaceSnapshot(tmpDir, { maxFiles: 400, maxChars: 8000 });

        expect(snap.length).toBeLessThanOrEqual(8000);
        expect(snap).toContain('## Workspace Snapshot');
    });

    it('includes dependency names', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            dependencies: { react: '18.0.0', express: '4.0.0' },
            devDependencies: { jest: '29.0.0' },
        }));

        const snap = buildWorkspaceSnapshot(tmpDir, { maxFiles: 100, maxChars: 4000 });

        expect(snap).toContain('react');
        expect(snap).toContain('express');
        expect(snap).toContain('jest');
    });

    it('detects test framework', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            scripts: { test: 'jest --forceExit' },
            devDependencies: { jest: '29.0.0' },
        }));
        fs.mkdirSync(path.join(tmpDir, 'tests'));
        fs.writeFileSync(path.join(tmpDir, 'tests', 'example.test.ts'), 'it("works", () => {});');

        const snap = buildWorkspaceSnapshot(tmpDir, { maxFiles: 100, maxChars: 4000 });

        expect(snap).toContain('jest');
        expect(snap).toContain('Test');
    });

    it('handles missing package.json gracefully', () => {
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(path.join(tmpDir, 'src', 'main.py'), 'print("hello")');

        const snap = buildWorkspaceSnapshot(tmpDir, { maxFiles: 100, maxChars: 4000 });

        expect(snap).toContain('## Workspace Snapshot');
        expect(snap).toContain('main.py');
    });
});
