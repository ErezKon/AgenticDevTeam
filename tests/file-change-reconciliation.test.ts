/**
 * File change reconciliation — unit tests.
 *
 * Sub-Plan 08 §7: verifies that phantom file changes are detected and
 * unreported files are added.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { reconcileFileChanges } from '../src/conductor/file-change-reconciliation';

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// Mock git-exec — we can't run real git in unit tests
jest.mock('../src/utils/git-exec', () => ({
    gitExec: jest.fn(() => ''),
    gitExecVerbose: jest.fn(() => ({ ok: true, stdout: '', stderr: '', code: 0 })),
    gitPush: jest.fn(),
    findGitRoot: jest.fn(() => '/tmp'),
}));

describe('File Change Reconciliation', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const makeFC = (p: string, summary = 'test') => ({
        path: p, action: 'created' as const, summary, storyId: 'US-001', agentId: 'senior-backend',
    });

    it('drops phantom files that do not exist on disk', () => {
        // Create one real file, claim two
        fs.writeFileSync(path.join(tmpDir, 'real.ts'), 'export const x = 1;');

        const claimed = [
            makeFC('real.ts', 'real file'),
            makeFC('jest.config.js', 'phantom'),
        ];

        const result = reconcileFileChanges(tmpDir, claimed);

        expect(result.verified).toHaveLength(1);
        expect(result.verified[0].path).toBe('real.ts');
        expect(result.phantoms).toHaveLength(1);
        expect(result.phantoms[0].path).toBe('jest.config.js');
    });

    it('adds unreported files that exist on disk but were not claimed', () => {
        // Create two files, claim one
        fs.writeFileSync(path.join(tmpDir, 'claimed.ts'), 'export const x = 1;');
        fs.writeFileSync(path.join(tmpDir, 'unreported.ts'), 'export const y = 2;');

        // Mock git to return both files
        const { gitExec } = require('../src/utils/git-exec');
        gitExec.mockImplementation((_cwd: string, cmd: string) => {
            if (cmd.includes('ls-files')) return 'claimed.ts\nunreported.ts\n';
            return '';
        });

        const claimed = [makeFC('claimed.ts', 'real file')];

        const result = reconcileFileChanges(tmpDir, claimed);

        expect(result.verified).toHaveLength(1);
        expect(result.unreported).toHaveLength(1);
        expect(result.unreported[0].path).toBe('unreported.ts');
        expect(result.unreported[0].summary).toBe('(unreported by agent)');
    });

    it('handles empty claims correctly', () => {
        const result = reconcileFileChanges(tmpDir, []);

        expect(result.verified).toHaveLength(0);
        expect(result.phantoms).toHaveLength(0);
    });

    it('verifies all files when all claims are valid', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const a = 1;');
        fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export const b = 2;');

        const claimed = [makeFC('a.ts', 'file a'), makeFC('b.ts', 'file b')];

        const result = reconcileFileChanges(tmpDir, claimed);

        expect(result.verified).toHaveLength(2);
        expect(result.phantoms).toHaveLength(0);
    });
});
