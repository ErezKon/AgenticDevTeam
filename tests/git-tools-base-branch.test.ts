/**
 * Git Tools — Base Branch Resolution Tests
 *
 * Verifies that createGitTools correctly resolves the base branch using
 * the priority: explicit tool argument → defaultBaseBranch → gitContext.defaultBranch → GIT_DEFAULT_BRANCH.
 * Falls back to origin/<ref> if the local ref does not exist.
 *
 * Uses a temporary git repo with real branches to test resolution logic.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createGitTools } from '../src/tools/git/git-tools';

const TIMEOUT = 30_000;

function git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
        cwd, encoding: 'utf-8', timeout: 15_000,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.local',
            GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.local',
        },
    }).trim();
}

describe('Git Tools — Base Branch Resolution', () => {
    let tmpDir: string;

    beforeAll(() => {
        // Create a temp git repo with branches: main, project/demo
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-base-branch-test-'));
        git(tmpDir, 'init -b main');
        git(tmpDir, 'config user.email "test@test.local"');
        git(tmpDir, 'config user.name "Test"');

        // Initial commit on main
        fs.writeFileSync(path.join(tmpDir, 'README.md'), 'initial\n');
        git(tmpDir, 'add .');
        git(tmpDir, 'commit -m "initial commit"');

        // Create the system branch project/demo from main
        git(tmpDir, 'checkout -b project/demo');
        fs.writeFileSync(path.join(tmpDir, 'base-file.txt'), 'base content\n');
        git(tmpDir, 'add .');
        git(tmpDir, 'commit -m "add base file on project/demo"');

        // Create a feature branch from project/demo
        git(tmpDir, 'checkout -b feature/test-feature');
        fs.writeFileSync(path.join(tmpDir, 'feature-file.txt'), 'feature content\n');
        git(tmpDir, 'add .');
        git(tmpDir, 'commit -m "add feature file"');
    });

    afterAll(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should use defaultBaseBranch when no explicit baseBranch is passed', async () => {
        // We're on feature/test-feature. Tools created with defaultBaseBranch='project/demo'.
        // git_diff_stat with no baseBranch arg should diff against project/demo.
        const tools = createGitTools(tmpDir, null, 'project/demo');
        const diffStatTool = tools.find(t => t.name === 'git_diff_stat')!;
        expect(diffStatTool).toBeDefined();

        const result = await diffStatTool.invoke({});
        // The diff between project/demo and feature/test-feature should show feature-file.txt
        expect(result).toContain('feature-file.txt');
        // Should NOT show base-file.txt (it exists on both branches)
        expect(result).not.toContain('base-file.txt');
    }, TIMEOUT);

    it('should fall back gracefully when baseBranch does not exist locally', async () => {
        // Create tools with defaultBaseBranch='project/demo' but pass an explicit
        // baseBranch='master' (which does not exist). resolveBase should skip it
        // and fall back to project/demo.
        const tools = createGitTools(tmpDir, null, 'project/demo');
        const diffStatTool = tools.find(t => t.name === 'git_diff_stat')!;

        // Call with an explicit nonexistent baseBranch — should fall back
        const result = await diffStatTool.invoke({ baseBranch: 'master' });
        // Should still produce a meaningful diff (fell back to project/demo)
        // rather than a git error
        expect(result).not.toContain('Error (exit');
        expect(result).toContain('feature-file.txt');
    }, TIMEOUT);

    it('should use explicit baseBranch when it exists', async () => {
        // Call with explicit baseBranch='main' (which exists). Diff should show
        // both base-file.txt and feature-file.txt (relative to main).
        const tools = createGitTools(tmpDir, null, 'project/demo');
        const diffStatTool = tools.find(t => t.name === 'git_diff_stat')!;

        const result = await diffStatTool.invoke({ baseBranch: 'main' });
        // Diff from main should include both files added after main
        expect(result).toContain('feature-file.txt');
        expect(result).toContain('base-file.txt');
    }, TIMEOUT);

    it('should use gitContext.defaultBranch as second fallback', async () => {
        // No defaultBaseBranch, but gitContext has defaultBranch='project/demo'.
        const gitContext = { defaultBranch: 'project/demo' } as any;
        const tools = createGitTools(tmpDir, gitContext);
        const diffStatTool = tools.find(t => t.name === 'git_diff_stat')!;

        const result = await diffStatTool.invoke({});
        expect(result).toContain('feature-file.txt');
        expect(result).not.toContain('base-file.txt');
    }, TIMEOUT);

    it('should resolve git_merge_base_diff with correct base branch', async () => {
        const tools = createGitTools(tmpDir, null, 'project/demo');
        const mergeBaseDiff = tools.find(t => t.name === 'git_merge_base_diff')!;

        const result = await mergeBaseDiff.invoke({});
        // Should show the diff for feature-file.txt against project/demo
        expect(result).toContain('feature-file.txt');
    }, TIMEOUT);
});
