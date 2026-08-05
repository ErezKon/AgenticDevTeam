/**
 * Workspace Sync — Unit & Integration Tests
 *
 * Exercises: syncWorkspaceToBranch (fast-forward, dirty tree, divergence + reset),
 * isDirty (pure), and looksSourceless (pure).
 *
 * Uses local bare repos as "origin" — no network, no GitHub account needed.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { syncWorkspaceToBranch, isDirty, looksSourceless } from '../src/conductor/workspace-sync';

const TIMEOUT = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
        cwd, encoding: 'utf-8', timeout: 10_000,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.local',
            GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.local',
        },
    }).trim();
}

/**
 * Set up a test environment:
 * - bare repo as "origin"
 * - `main` clone (simulates the pipeline checkout)
 * - `dev` clone (simulates a worktree / developer)
 *
 * Both clones start on `branch` with a single `docs/x.md` commit.
 */
function createTestRepos(branch: string = 'project/test-app') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sync-test-'));
    const bareDir = path.join(root, 'origin.git');
    const mainDir = path.join(root, 'main');
    const devDir = path.join(root, 'dev');

    // Create bare origin
    fs.mkdirSync(bareDir, { recursive: true });
    git(bareDir, 'init --bare');

    // Create main clone, seed with docs/x.md on default branch, then create system branch
    git(root, `clone ${bareDir} main`);
    git(mainDir, 'config user.email "test@test.local"');
    git(mainDir, 'config user.name "Test"');
    // Create initial commit on main branch
    fs.mkdirSync(path.join(mainDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'docs', 'x.md'), '# Doc\n');
    git(mainDir, 'add .');
    git(mainDir, 'commit -m "initial: docs/x.md"');
    // Detect the default branch name
    const defaultBranch = git(mainDir, 'rev-parse --abbrev-ref HEAD');
    git(mainDir, `push origin ${defaultBranch}`);
    // Create system branch
    git(mainDir, `checkout -b ${branch}`);
    git(mainDir, `push origin ${branch}`);

    // Create dev clone on the same system branch
    git(root, `clone -b ${branch} ${bareDir} dev`);
    git(devDir, 'config user.email "dev@test.local"');
    git(devDir, 'config user.name "Dev"');

    return { root, bareDir, mainDir, devDir, branch, defaultBranch };
}

function cleanup(root: string) {
    fs.rmSync(root, { recursive: true, force: true });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('syncWorkspaceToBranch', () => {
    let env: ReturnType<typeof createTestRepos>;

    afterEach(() => {
        if (env?.root) cleanup(env.root);
    });

    it('should fast-forward when remote has new commits', () => {
        env = createTestRepos();
        const { mainDir, devDir, branch } = env;

        // Push a new file from the dev clone (simulates a squash-merged PR)
        fs.mkdirSync(path.join(devDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(devDir, 'src', 'app.ts'), 'console.log("hello");\n');
        git(devDir, 'add .');
        git(devDir, 'commit -m "feat: add app.ts"');
        git(devDir, `push origin ${branch}`);

        // main clone is behind — sync should fast-forward
        const result = syncWorkspaceToBranch(mainDir, branch);

        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('fast-forward');
        expect(result.headSha).toBeTruthy();
        expect(result.details).toContain('fast-forward');
        // Verify the file now exists in main
        expect(fs.existsSync(path.join(mainDir, 'src', 'app.ts'))).toBe(true);
    }, TIMEOUT);

    it('should commit dirty files before syncing, and preserve them', () => {
        env = createTestRepos();
        const { mainDir, devDir, branch } = env;

        // Push from dev (remote advances)
        fs.mkdirSync(path.join(devDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(devDir, 'src', 'index.ts'), 'export {};\n');
        git(devDir, 'add .');
        git(devDir, 'commit -m "feat: add index.ts"');
        git(devDir, `push origin ${branch}`);

        // Create an uncommitted file in main
        fs.writeFileSync(path.join(mainDir, 'docs', 'local-notes.md'), '# Notes\n');

        const result = syncWorkspaceToBranch(mainDir, branch);

        expect(result.ok).toBe(true);
        // The uncommitted file should have been committed and preserved
        expect(fs.existsSync(path.join(mainDir, 'docs', 'local-notes.md'))).toBe(true);
        // The remote file should also exist
        expect(fs.existsSync(path.join(mainDir, 'src', 'index.ts'))).toBe(true);
    }, TIMEOUT);

    it('should hard-reset when local and remote have diverged and allowReset is true', () => {
        env = createTestRepos();
        const { mainDir, devDir, branch } = env;

        // Create a local-only commit on main that modifies docs/x.md (not pushed)
        fs.writeFileSync(path.join(mainDir, 'docs', 'x.md'), '# LOCAL CHANGE — line 1\nlocal content\n');
        git(mainDir, 'add .');
        git(mainDir, 'commit -m "local-only: modify docs/x.md"');

        // Force-push a conflicting change to the SAME file from dev
        fs.writeFileSync(path.join(devDir, 'docs', 'x.md'), '# REMOTE CHANGE — line 1\nremote content\n');
        fs.mkdirSync(path.join(devDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(devDir, 'src', 'server.ts'), 'export default {};\n');
        git(devDir, 'add .');
        git(devDir, 'commit -m "feat: add server.ts + modify docs/x.md"');
        git(devDir, `push --force origin ${branch}`);

        const remoteSha = git(devDir, 'rev-parse HEAD');

        // Sync with allowReset: true (explicit, though it's the default)
        const result = syncWorkspaceToBranch(mainDir, branch, null, { allowReset: true });

        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('reset');
        // HEAD should match the remote
        const localHead = git(mainDir, 'rev-parse HEAD');
        expect(localHead).toBe(remoteSha);
        // Remote file should exist
        expect(fs.existsSync(path.join(mainDir, 'src', 'server.ts'))).toBe(true);
    }, TIMEOUT);

    it('should return already-current when no sync is needed', () => {
        env = createTestRepos();
        const { mainDir, branch } = env;

        // No new commits — should be already current
        const result = syncWorkspaceToBranch(mainDir, branch);

        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('already-current');
    }, TIMEOUT);
});

describe('isDirty', () => {
    it('should return false for empty string', () => {
        expect(isDirty('')).toBe(false);
    });

    it('should return false for whitespace-only output', () => {
        expect(isDirty('   \n  ')).toBe(false);
    });

    it('should return true when there are modified files', () => {
        expect(isDirty(' M src/a.ts\n')).toBe(true);
    });

    it('should return true for untracked files', () => {
        expect(isDirty('?? newfile.ts\n')).toBe(true);
    });
});

describe('looksSourceless', () => {
    it('should return true when only docs and convention files exist', () => {
        expect(looksSourceless([
            'docs/a.md',
            '.conventions/Universal.md',
            'README.md',
        ])).toBe(true);
    });

    it('should return false when source files exist', () => {
        expect(looksSourceless([
            'docs/a.md',
            '.conventions/Universal.md',
            'README.md',
            'src/index.ts',
        ])).toBe(false);
    });

    it('should return true for only dotfiles and docs', () => {
        expect(looksSourceless([
            '.gitignore',
            '.conventions/Node.md',
            'docs/api.md',
            '.github/workflows/ci.yml',
            'LICENSE',
        ])).toBe(true);
    });

    it('should return false for a non-doc file at root', () => {
        expect(looksSourceless([
            'docs/x.md',
            'package.json',
        ])).toBe(false);
    });

    it('should return false for nested source files', () => {
        expect(looksSourceless([
            'docs/x.md',
            'lib/utils/helper.ts',
        ])).toBe(false);
    });

    it('should return true for empty file list', () => {
        expect(looksSourceless([])).toBe(true);
    });
});
