/**
 * Shared temp directory helpers for tests.
 *
 * Replaces the ~27 hand-written `makeTempDir` / `createTmpDir` / `createTempDir`
 * functions scattered across test files.
 *
 * Usage:
 *   import { makeTempDir, withTempDir } from './helpers/tmp';
 *
 *   // Manual lifecycle:
 *   const dir = makeTempDir('my-test-');
 *   afterEach(() => cleanupDir(dir));
 *
 *   // Automatic lifecycle:
 *   await withTempDir('my-test-', async (dir) => {
 *       // dir is cleaned up after the callback returns (or throws)
 *   });
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Create a temporary directory with the given prefix. */
export function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a directory tree (best-effort, no-throw). */
export function cleanupDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best-effort — don't fail a test on cleanup.
    }
}

/**
 * Run a callback with a temporary directory that is automatically
 * cleaned up after the callback completes (even on error).
 */
export async function withTempDir(
    prefix: string,
    fn: (dir: string) => void | Promise<void>,
): Promise<void> {
    const dir = makeTempDir(prefix);
    try {
        await fn(dir);
    } finally {
        cleanupDir(dir);
    }
}
