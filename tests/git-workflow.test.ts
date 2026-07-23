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

    beforeAll(async () => {
        octokit = new Octokit({ auth: GITHUB_TOKEN });

        // Clean up stale remote branch/PR from a prior failed run
        try {
            const { data: prs } = await octokit.pulls.list({
                owner: GITHUB_OWNER, repo: GITHUB_REPO, head: `${GITHUB_OWNER}:${TEST_BRANCH}`, state: 'open',
            });
            for (const pr of prs) {
                await octokit.pulls.update({ owner: GITHUB_OWNER, repo: GITHUB_REPO, pull_number: pr.number, state: 'closed' });
            }
        } catch { /* ignore */ }
        try {
            await octokit.git.deleteRef({ owner: GITHUB_OWNER, repo: GITHUB_REPO, ref: `heads/${TEST_BRANCH}` });
        } catch { /* ignore — branch may not exist */ }

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

    it('should post a simulated review comment to the PR', async () => {
        expect(createdPrNumber).not.toBeNull();

        const commentBody = [
            '[REVIEW: APPROVED by Test Reviewer (test-reviewer)] — iteration 1',
            '',
            '**Summary:** All changes look good. Code follows conventions.',
            '',
            '### Comments',
            '',
            '- **`git-workflow-test-file.txt`:1** — **[SUGGESTION]** Consider adding a header comment',
        ].join('\n');

        const { data: comment } = await octokit.issues.createComment({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            issue_number: createdPrNumber!, body: commentBody,
        });

        expect(comment.id).toBeGreaterThan(0);
        expect(comment.body).toContain('[REVIEW: APPROVED');

        // Verify the comment is retrievable
        const { data: comments } = await octokit.issues.listComments({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            issue_number: createdPrNumber!,
        });
        const found = comments.find(c => c.body?.includes('[REVIEW: APPROVED by Test Reviewer'));
        expect(found).toBeDefined();
    }, TIMEOUT);
});
