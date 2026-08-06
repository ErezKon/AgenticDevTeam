/**
 * Local GitHub stand-in — unit tests.
 *
 * Tests the OctokitLike API surface returned by createLocalGitHub:
 *   - PR creation, retrieval, and merge (real git squash merge)
 *   - Issue comments
 *   - Ref deletion
 *   - Repos get / createForAuthenticatedUser
 *   - User authentication stub
 *
 * Uses real bare git repos in tmp directories — no mocks needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createLocalGitHub, type OctokitLike } from '../src/utils/github-local';

// Mock logger to avoid console noise
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
        cwd, encoding: 'utf-8',
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@test.local',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@test.local',
        },
    }).trim();
}

/**
 * Set up a bare repo + a working clone with a file on `main`,
 * and a feature branch with an additional file.
 */
function setupTestRepos(): { bareDir: string; workDir: string; cleanup: () => void } {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-local-test-'));
    const bareDir = path.join(tmpRoot, 'origin.git');
    const workDir = path.join(tmpRoot, 'work');

    // Create a bare repo
    git(tmpRoot, `init --bare "${bareDir}"`);

    // Clone it, add a commit on main, push
    git(tmpRoot, `clone "${bareDir}" "${workDir}"`);
    fs.writeFileSync(path.join(workDir, 'README.md'), '# Test\n');
    git(workDir, 'add -A');
    git(workDir, 'commit -m "Initial commit"');
    git(workDir, 'push origin HEAD:refs/heads/main');

    // Create a feature branch with a change
    git(workDir, 'checkout -b feature/test');
    fs.writeFileSync(path.join(workDir, 'feature.ts'), 'export const x = 1;\n');
    git(workDir, 'add -A');
    git(workDir, 'commit -m "Add feature"');
    git(workDir, 'push origin HEAD:refs/heads/feature/test');

    // Return to main
    git(workDir, 'checkout main');

    return {
        bareDir,
        workDir,
        cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createLocalGitHub', () => {
    let bareDir: string;
    let workDir: string;
    let cleanup: () => void;
    let gh: OctokitLike;

    beforeAll(() => {
        const repos = setupTestRepos();
        bareDir = repos.bareDir;
        workDir = repos.workDir;
        cleanup = repos.cleanup;
        gh = createLocalGitHub(bareDir);
    });

    afterAll(() => {
        cleanup();
    });

    // ─── users ──────────────────────────────────────────────────────

    it('users.getAuthenticated returns a local-user stub', async () => {
        const { data } = await gh.users.getAuthenticated();
        expect(data.login).toBe('local-user');
    });

    // ─── repos ──────────────────────────────────────────────────────

    it('repos.get returns synthetic repo metadata', async () => {
        const { data } = await gh.repos.get({ owner: 'testowner', repo: 'testrepo' });
        expect(data.full_name).toBe('testowner/testrepo');
        expect(data.clone_url).toBe(bareDir);
        expect(data.default_branch).toBe('main');
    });

    it('repos.createForAuthenticatedUser returns synthetic data', async () => {
        const { data } = await gh.repos.createForAuthenticatedUser({
            name: 'new-repo',
            private: true,
            auto_init: false,
        });
        expect(data.full_name).toBe('local/new-repo');
        expect(data.default_branch).toBe('main');
    });

    // ─── pulls.create ───────────────────────────────────────────────

    it('pulls.create returns a PR with a monotonic number', async () => {
        const { data: pr1 } = await gh.pulls.create({
            owner: 'o', repo: 'r',
            title: 'First PR', body: 'Body 1',
            head: 'feature/test', base: 'main',
        });
        expect(pr1.number).toBeGreaterThanOrEqual(1);
        expect(pr1.html_url).toContain('local://pr/');

        const { data: pr2 } = await gh.pulls.create({
            owner: 'o', repo: 'r',
            title: 'Second PR', body: 'Body 2',
            head: 'feature/test', base: 'main',
        });
        expect(pr2.number).toBe(pr1.number + 1);
    });

    // ─── pulls.get ──────────────────────────────────────────────────

    it('pulls.get retrieves a previously created PR', async () => {
        const { data: created } = await gh.pulls.create({
            owner: 'o', repo: 'r',
            title: 'Get Test', body: 'body',
            head: 'feature/test', base: 'main',
        });

        const { data: retrieved } = await gh.pulls.get({
            owner: 'o', repo: 'r',
            pull_number: created.number,
        });

        expect(retrieved.title).toBe('Get Test');
        expect(retrieved.state).toBe('open');
        expect(retrieved.merged).toBe(false);
    });

    it('pulls.get throws for a non-existent PR', async () => {
        await expect(
            gh.pulls.get({ owner: 'o', repo: 'r', pull_number: 99999 }),
        ).rejects.toThrow('not found');
    });

    // ─── pulls.merge ────────────────────────────────────────────────

    it('pulls.merge performs a real squash merge and marks the PR as merged', async () => {
        // Create a fresh local GitHub to avoid interference from earlier tests
        const freshGH = createLocalGitHub(bareDir);

        const { data: pr } = await freshGH.pulls.create({
            owner: 'o', repo: 'r',
            title: 'Merge Test', body: 'body',
            head: 'feature/test', base: 'main',
        });

        const { data: merged } = await freshGH.pulls.merge({
            owner: 'o', repo: 'r',
            pull_number: pr.number,
            merge_method: 'squash',
        });

        expect(merged.merged).toBe(true);
        expect(merged.sha).toMatch(/^[0-9a-f]+$/);

        // Verify the PR is now closed/merged
        const { data: after } = await freshGH.pulls.get({
            owner: 'o', repo: 'r',
            pull_number: pr.number,
        });
        expect(after.state).toBe('closed');
        expect(after.merged).toBe(true);
    });

    it('pulls.merge throws if the PR is already merged', async () => {
        const freshGH = createLocalGitHub(bareDir);

        const { data: pr } = await freshGH.pulls.create({
            owner: 'o', repo: 'r',
            title: 'Double Merge', body: 'body',
            head: 'feature/test', base: 'main',
        });
        await freshGH.pulls.merge({
            owner: 'o', repo: 'r',
            pull_number: pr.number,
        });

        await expect(
            freshGH.pulls.merge({ owner: 'o', repo: 'r', pull_number: pr.number }),
        ).rejects.toThrow('already merged');
    });

    // ─── issues.createComment ───────────────────────────────────────

    it('issues.createComment records a comment on a PR', async () => {
        const freshGH = createLocalGitHub(bareDir);

        const { data: pr } = await freshGH.pulls.create({
            owner: 'o', repo: 'r',
            title: 'Comment Test', body: 'body',
            head: 'feature/test', base: 'main',
        });

        const { data: comment } = await freshGH.issues.createComment({
            owner: 'o', repo: 'r',
            issue_number: pr.number,
            body: 'LGTM!',
        });

        expect(comment.id).toBeGreaterThanOrEqual(1);
    });

    // ─── git.deleteRef ──────────────────────────────────────────────

    it('git.deleteRef does not throw even if the branch does not exist', async () => {
        await expect(
            gh.git.deleteRef({ owner: 'o', repo: 'r', ref: 'heads/nonexistent-branch' }),
        ).resolves.not.toThrow();
    });
});
