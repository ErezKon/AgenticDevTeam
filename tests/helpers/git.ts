/**
 * Shared git helpers for tests.
 *
 * Replaces the ~8 hand-written `git()` helpers scattered across test files.
 * Uses a fully-isolated git environment (no system config, deterministic
 * author/committer) to prevent host-specific test pollution.
 *
 * Usage:
 *   import { git, createTestRepo } from './helpers/git';
 *
 *   const { dir, cleanup } = createTestRepo('my-test-');
 *   afterAll(cleanup);
 *   git(dir, 'checkout -b feature');
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import { makeTempDir, cleanupDir } from './tmp';

/** Isolated git env — no system config, deterministic identity. */
const GIT_TEST_ENV = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.local',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.local',
};

/**
 * Run a git command in the given directory with test-isolated env.
 * Returns trimmed stdout.
 */
export function git(cwd: string, args: string, timeout = 10_000): string {
    return execSync(`git ${args}`, {
        cwd,
        encoding: 'utf-8',
        timeout,
        env: GIT_TEST_ENV,
    }).trim();
}

/**
 * Create a temporary git repository with an initial commit.
 * Returns the directory path and a cleanup function.
 */
export function createTestRepo(prefix: string): { dir: string; cleanup: () => void } {
    const dir = makeTempDir(prefix);
    git(dir, 'init');
    git(dir, 'checkout -b main');
    fs.writeFileSync(`${dir}/README.md`, '# Test\n');
    git(dir, 'add .');
    git(dir, 'commit -m "init"');
    return {
        dir,
        cleanup: () => cleanupDir(dir),
    };
}
