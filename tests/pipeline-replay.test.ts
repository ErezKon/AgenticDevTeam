/**
 * Pipeline Replay — deterministic end-to-end test using LLM cassettes
 * and the local GitHub stand-in.
 *
 * This test verifies that the cassette + local-GitHub machinery works
 * end-to-end: a pre-recorded cassette is loaded, and the local GitHub
 * stand-in handles PR creation and merge without any network calls.
 *
 * NOTE: This is a *structural* smoke test — it validates that the
 * plumbing is wired correctly. A full replay test requires a real
 * cassette recorded via `npm run record:cassette`.
 */

// Set env BEFORE imports
process.env.LLM_CASSETTE_MODE = 'replay';
process.env.CASSETTE_NAME = 'pipeline-smoke';
process.env.LLM_CASSETTE_ON_MISS = 'strict';
process.env.GITHUB_MODE = 'local';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
    buildCassetteKey,
    _resetCassette,
    _loadFromContent,
    cassetteFetch,
    getCassetteStats,
} from '../src/utils/llm-cassette';
import { createLocalGitHub, type OctokitLike } from '../src/utils/github-local';

// Mock logger
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

describe('Pipeline Replay (smoke)', () => {
    let tmpDir: string;
    let bareDir: string;
    let workDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-replay-'));
        bareDir = path.join(tmpDir, 'origin.git');
        workDir = path.join(tmpDir, 'work');

        // Set up a bare repo + working clone
        git(tmpDir, `init --bare "${bareDir}"`);
        git(tmpDir, `clone "${bareDir}" "${workDir}"`);
        fs.writeFileSync(path.join(workDir, 'README.md'), '# Replay Test\n');
        git(workDir, 'add -A');
        git(workDir, 'commit -m "Initial"');
        git(workDir, 'push origin HEAD:refs/heads/main');

        // Feature branch
        git(workDir, 'checkout -b feat/replay-test');
        fs.writeFileSync(path.join(workDir, 'app.ts'), 'console.log("hello");\n');
        git(workDir, 'add -A');
        git(workDir, 'commit -m "Add app"');
        git(workDir, 'push origin HEAD:refs/heads/feat/replay-test');
        git(workDir, 'checkout main');
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        _resetCassette();
    });

    it('cassetteFetch replays a pre-loaded entry without calling the inner fetch', async () => {
        // Build a cassette entry that matches a specific request
        const url = 'https://api.example.com/v1/chat/completions';
        const method = 'POST';
        const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] };
        const key = buildCassetteKey(url, method, body);

        const cassetteContent = JSON.stringify({
            key,
            seq: 0,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi!' } }] }),
        });

        _loadFromContent(cassetteContent);

        const inner = jest.fn();
        const wrapped = cassetteFetch(inner);

        const response = await wrapped(url, {
            method: 'POST',
            body: JSON.stringify(body),
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.choices[0].message.content).toBe('Hi!');

        // The inner fetch should NOT have been called
        expect(inner).not.toHaveBeenCalled();

        // Stats
        const stats = getCassetteStats();
        expect(stats.replayed).toBe(1);
        expect(stats.misses).toBe(0);
    });

    it('cassetteFetch in strict mode throws on a miss', async () => {
        _loadFromContent(''); // Empty cassette

        const inner = jest.fn();
        const wrapped = cassetteFetch(inner);

        await expect(
            wrapped('https://api.example.com/v1/missing', {
                method: 'POST',
                body: JSON.stringify({ model: 'gpt-4', messages: [] }),
            }),
        ).rejects.toThrow('cassette miss');

        const stats = getCassetteStats();
        expect(stats.misses).toBe(1);
    });

    it('local GitHub creates a PR and merges it within a local bare repo', async () => {
        const gh: OctokitLike = createLocalGitHub(bareDir);

        // Create a PR
        const { data: pr } = await gh.pulls.create({
            owner: 'test', repo: 'replay',
            title: 'Replay PR', body: 'Automated test',
            head: 'feat/replay-test', base: 'main',
        });
        expect(pr.number).toBeGreaterThanOrEqual(1);

        // Add a comment
        const { data: comment } = await gh.issues.createComment({
            owner: 'test', repo: 'replay',
            issue_number: pr.number,
            body: 'Review passed',
        });
        expect(comment.id).toBeGreaterThanOrEqual(1);

        // Merge
        const { data: merged } = await gh.pulls.merge({
            owner: 'test', repo: 'replay',
            pull_number: pr.number,
            merge_method: 'squash',
        });
        expect(merged.merged).toBe(true);

        // Verify the merge reached the bare repo:
        // main should now contain app.ts after the squash merge
        const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
        try {
            git(verifyDir, `clone "${bareDir}" .`);
            git(verifyDir, 'checkout main');
            const files = fs.readdirSync(verifyDir);
            expect(files).toContain('app.ts');
        } finally {
            fs.rmSync(verifyDir, { recursive: true, force: true });
        }
    });

    it('end-to-end: cassette replay + local GitHub coexist in the same test', async () => {
        // This is the key integration test: both subsystems work together
        // in the same process with the same env vars.

        // 1. Set up cassette replay
        const url = 'https://api.example.com/v1/chat/completions';
        const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'plan' }] };
        const key = buildCassetteKey(url, 'POST', body);
        _loadFromContent(JSON.stringify({
            key, seq: 0, status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ choices: [{ message: { content: 'Step 1: ...' } }] }),
        }));

        // 2. Replay an LLM call
        const wrapped = cassetteFetch(jest.fn());
        const llmResp = await wrapped(url, { method: 'POST', body: JSON.stringify(body) });
        expect(llmResp.status).toBe(200);

        // 3. Use local GitHub for a PR
        const gh = createLocalGitHub(bareDir);
        const { data: user } = await gh.users.getAuthenticated();
        expect(user.login).toBe('local-user');

        const { data: repo } = await gh.repos.get({ owner: 'test', repo: 'replay' });
        expect(repo.clone_url).toBe(bareDir);

        // Both worked without any network calls
        expect(getCassetteStats().replayed).toBe(1);
    });
});
