/**
 * Plan 30-S: execCapture kills the whole process group on timeout.
 *
 * pacman-live-analysis-8: an agent ran `npm test` (→ watch-mode `ng test` → Karma →
 * Chrome). exec()'s own timeout only signalled `/bin/sh`; the runner and its browsers
 * kept running as orphans, two of them for over 10 minutes.
 */
import * as os from 'os';
import { spawnSync } from 'child_process';
import { execCapture } from '../src/utils/shell-exec';

jest.mock('../src/utils/logger');

const posix = process.platform !== 'win32';
const marker = `sleep 47.${process.pid % 1000}`;
const alive = () => spawnSync('pgrep', ['-f', marker], { encoding: 'utf-8' }).stdout.trim();

(posix ? describe : describe.skip)('execCapture timeout (Plan 30-S)', () => {
    afterAll(() => { spawnSync('pkill', ['-f', marker]); });

    it('returns promptly and kills background grandchildren with the shell', async () => {
        const start = Date.now();
        const result = await execCapture(`${marker} & ${marker}; echo never`, { cwd: os.tmpdir(), timeout: 500 });

        expect(Date.now() - start).toBeLessThan(5_000);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain('never');
        expect(result.stderr).toContain('timed out after');
        await new Promise(r => setTimeout(r, 200));
        expect(alive()).toBe('');
    });

    it('still reports normal exit codes and output', async () => {
        const result = await execCapture('echo out; echo err >&2; exit 3', { cwd: os.tmpdir(), timeout: 5_000 });
        expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 });
    });
});
