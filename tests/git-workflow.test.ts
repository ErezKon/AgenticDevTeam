/**
 * Git Workflow Integration Test
 *
 * Exercises: branch creation → file add/modify → commit → push → PR creation → cleanup.
 * Runs against the REAL GitHub repo from .env.
 * Requires: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO environment variables.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Octokit } from '@octokit/rest';
import { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GIT_DEFAULT_BRANCH } from '../src/config';

const TEST_PROJECT_SLUG = 'test-project';
const TEST_BRANCH = `${TEST_PROJECT_SLUG}/feature/TEST-001-git-workflow-test`;
const TEST_STORY_ID = 'TEST-001';
const TIMEOUT = 60_000;

function git(cwd: string, args: string): string {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

const canRun = Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

const describeIf = canRun ? describe : describe.skip;

describeIf('Git Workflow Integration', () => {
    let tmpDir: string;
    let octokit: Octokit;
    let createdPrNumber: number | null = null;

    beforeAll(() => {
        octokit = new Octokit({ auth: GITHUB_TOKEN });

        // Clone the real repo into a temp directory (shallow)
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-test-'));
        execSync(
            `git clone --depth 1 https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git ${tmpDir}`,
            { encoding: 'utf-8', timeout: 60_000 }
        );
        git(tmpDir, `config user.email "test@agenticdevteam.ci"`);
        git(tmpDir, `config user.name "Git Workflow Test"`);
    }, TIMEOUT);

    afterAll(async () => {
        // Cleanup: close PR and delete remote branch
        if (createdPrNumber && octokit) {
            try {
                await octokit.pulls.update({
                    owner: GITHUB_OWNER, repo: GITHUB_REPO,
                    pull_number: createdPrNumber, state: 'closed',
                });
            } catch { /* ignore */ }
            try {
                await octokit.git.deleteRef({
                    owner: GITHUB_OWNER, repo: GITHUB_REPO,
                    ref: `heads/${TEST_BRANCH}`,
                });
            } catch { /* ignore */ }
        }
        // Remove temp directory
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should create a project-prefixed branch', () => {
        const defaultBranch = GIT_DEFAULT_BRANCH;
        git(tmpDir, `checkout ${defaultBranch}`);
        git(tmpDir, `checkout -b ${TEST_BRANCH}`);
        const currentBranch = git(tmpDir, 'rev-parse --abbrev-ref HEAD');

        expect(currentBranch).toBe(TEST_BRANCH);
        expect(currentBranch.startsWith(`${TEST_PROJECT_SLUG}/`)).toBe(true);
    }, TIMEOUT);

    it('should create and commit a test file with project commit format', () => {
        // Create a dedicated test file
        const testFile = path.join(tmpDir, 'git-workflow-test-file.txt');
        fs.writeFileSync(testFile, `Git workflow test - ${new Date().toISOString()}\n`);

        git(tmpDir, 'add git-workflow-test-file.txt');
        const commitMsg = `[${TEST_PROJECT_SLUG}]-[${TEST_STORY_ID}]-test: add git workflow test file`;
        git(tmpDir, `commit -m "${commitMsg}"`);

        const log = git(tmpDir, 'log --oneline -1');
        expect(log).toContain(`[${TEST_PROJECT_SLUG}]-[${TEST_STORY_ID}]-test:`);
    }, TIMEOUT);

    it('should modify the test file and commit with project format', () => {
        const testFile = path.join(tmpDir, 'git-workflow-test-file.txt');
        fs.appendFileSync(testFile, `Modified at ${new Date().toISOString()}\n`);

        git(tmpDir, 'add git-workflow-test-file.txt');
        const commitMsg = `[${TEST_PROJECT_SLUG}]-[${TEST_STORY_ID}]-feat: update git workflow test file`;
        git(tmpDir, `commit -m "${commitMsg}"`);

        const log = git(tmpDir, 'log --oneline -1');
        expect(log).toContain(`[${TEST_PROJECT_SLUG}]-[${TEST_STORY_ID}]-feat:`);
    }, TIMEOUT);

    it('should push the branch and create a PR', async () => {
        // Push branch to remote
        git(tmpDir, `push -u origin ${TEST_BRANCH}`);

        // Create PR via GitHub API
        const { data: pr } = await octokit.pulls.create({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            title: `[TEST] Git workflow integration test`,
            body: 'Automated test PR — will be closed and branch deleted by afterAll cleanup.',
            head: TEST_BRANCH,
            base: GIT_DEFAULT_BRANCH,
        });

        createdPrNumber = pr.number;

        expect(pr.number).toBeGreaterThan(0);
        expect(pr.html_url).toContain(GITHUB_REPO);
        expect(pr.head.ref).toBe(TEST_BRANCH);
        expect(pr.state).toBe('open');
    }, TIMEOUT);
});
