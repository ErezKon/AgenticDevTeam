/**
 * Plan 30-04 — worktree disposal, the pre-sync auto-commit and the continue-run
 * repair, against real temp repos with a bare `origin`.
 *
 * claudeopus5 moved every unmerged worktree to `<gitRoot>/.worktrees-failed/`.
 * One `.gitignore` block without that entry was enough for the pre-sync
 * auto-commit to push the salvaged us-027 worktree to the system branch as a
 * gitlink (commit d721a0d).
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/utils/logger', () => ({ getLogger: () => mockLog, setRunLogPath: jest.fn(), logToolAction: jest.fn() }));
// gitPush pushes to `origin` (the bare repo) instead of github.com
jest.mock('../src/utils/github-local', () => ({
    ...jest.requireActual('../src/utils/github-local'),
    GITHUB_MODE: 'local',
}));
jest.mock('../src/config', () => ({ ...jest.requireActual('../src/config'), CONTINUE_GIT_RECONCILE: true }));

import * as fs from 'fs';
import * as path from 'path';
import { git } from './helpers/git';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { createBranchWorktree, disposeWorktree } from '../src/conductor/pr/worktree';
import { commitWorktree } from '../src/conductor/pr/commit';
import { syncWorkspaceToBranch } from '../src/conductor/workspace-sync';
import { reconcileGitState } from '../src/conductor/continue/git-reconciliation';
import { REPAIR_COMMIT_SUBJECT } from '../src/utils/repo-hygiene';
import type { CollectedRunState } from '../src/conductor/continue/state-collector';

jest.setTimeout(30_000);

const SYSTEM = 'project/app';
const BRANCH = 'app/feature/us-027-storage';
const SLUG = 'app-feature-us-027-storage';

function write(dir: string, file: string, content = 'x\n'): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

/** A directory holding its own repository, like a salvaged worktree. */
function nestedRepo(dir: string, rel: string): void {
    const nested = path.join(dir, rel);
    fs.mkdirSync(nested, { recursive: true });
    git(nested, 'init');
    write(nested, 'main.ts', 'export {};\n');
    git(nested, 'add -A');
    git(nested, 'commit -m nested');
}

/** origin (bare) + `repo`, the pipeline's main checkout on the system branch. */
function setup(): { root: string; origin: string; repo: string } {
    const root = makeTempDir('wt-dispose-');
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    git(root, `init --bare "${origin}"`);
    git(root, `clone "${origin}" "${repo}"`);
    git(repo, `checkout -b ${SYSTEM}`);
    write(repo, 'README.md', '# app\n');
    git(repo, 'add -A');
    git(repo, 'commit -m "init"');
    git(repo, `push origin HEAD:refs/heads/${SYSTEM}`);
    return { root, origin, repo };
}

const localBranch = (repo: string): string => git(repo, `branch --list ${BRANCH}`);

let env: ReturnType<typeof setup>;

beforeEach(() => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    env = setup();
});

afterEach(() => cleanupDir(env.root));

describe('disposeWorktree (Plan 30-04)', () => {
    it('merged: removes the worktree and deletes the local branch', () => {
        const wt = createBranchWorktree(env.repo, BRANCH, SYSTEM);

        disposeWorktree(wt.gitRoot, wt.worktreeDir, BRANCH, true);

        expect(fs.existsSync(wt.worktreeDir)).toBe(false);
        expect(localBranch(env.repo)).toBe('');
        expect(git(env.repo, 'worktree list --porcelain')).not.toContain(SLUG);
    });

    it('not merged, but the remote holds every commit: removed, with nothing salvaged', () => {
        const wt = createBranchWorktree(env.repo, BRANCH, SYSTEM);
        write(wt.worktreeWorkspace, 'src/storage.ts', 'export const storage = 1;\n');
        expect(commitWorktree(wt.worktreeWorkspace, BRANCH, 'app', 'US-027', 'feat', 'storage', null).pushed).toBe(true);

        disposeWorktree(wt.gitRoot, wt.worktreeDir, BRANCH, false);

        expect(fs.existsSync(wt.worktreeDir)).toBe(false);
        expect(fs.existsSync(path.join(env.repo, '.worktrees', '_failed'))).toBe(false);
        expect(fs.existsSync(path.join(env.repo, '.worktrees-failed'))).toBe(false);
        expect(localBranch(env.repo)).toBe('');
        expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Could not delete local branch'));
    });

    it('unpushed work: kept, detached, under .worktrees/_failed/ — never .worktrees-failed/ — and the branch can be cut again', () => {
        const wt = createBranchWorktree(env.repo, BRANCH, SYSTEM);
        write(wt.worktreeWorkspace, 'src/storage.ts');
        git(wt.worktreeWorkspace, 'add -A');
        git(wt.worktreeWorkspace, 'commit -m "local only"');
        const head = git(wt.worktreeWorkspace, 'rev-parse HEAD');

        disposeWorktree(wt.gitRoot, wt.worktreeDir, BRANCH, false);

        const salvage = path.join(env.repo, '.worktrees', '_failed', SLUG);
        expect(git(salvage, 'rev-parse HEAD')).toBe(head);
        expect(git(salvage, 'rev-parse --abbrev-ref HEAD')).toBe('HEAD');
        expect(fs.existsSync(path.join(env.repo, '.worktrees-failed'))).toBe(false);
        expect(localBranch(env.repo)).toBe('');

        const next = createBranchWorktree(env.repo, BRANCH, SYSTEM);
        expect(next.resumedFrom).toBeNull();
        expect(fs.existsSync(path.join(salvage, 'src/storage.ts'))).toBe(true);
    });
});

describe('pre-sync auto-commit (Plan 30-04)', () => {
    it('never commits a worktree, even when .gitignore lost its entry (claudeopus5 d721a0d)', async () => {
        nestedRepo(env.repo, `.worktrees-failed/${SLUG}`);
        write(env.repo, '.gitignore', 'node_modules/\n');

        const sync = await syncWorkspaceToBranch(env.repo, SYSTEM, null);

        expect(sync.ok).toBe(true);
        expect(git(env.repo, 'ls-files -s')).not.toContain('160000');
        expect(git(env.repo, 'log -1 --format=%s')).toBe('chore: pipeline artifacts (pre-sync auto-commit)');
        expect(git(env.repo, 'show --name-only --format= HEAD')).toBe('.gitignore');
        expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('committing 1 file(s) before sync: .gitignore'));
    });
});

describe('continue-run reconciliation (Plan 30-04 step 4)', () => {
    const collected = (repo: string, outputPath: string): CollectedRunState => ({
        stateSnapshot: null, manifest: null, ledgerEntries: [], responseIndex: [], agentArtifacts: [],
        gitBranches: { local: [], remote: [] }, gitLog: [], workspaceFiles: [], prBranchStatus: [],
        outputPath, workspacePath: repo, workspaceExists: true, workspaceIsGitRepo: true,
        salvagePatches: [], tokenUsageRecords: [],
    });

    it('removes the gitlink an earlier run committed to the system branch and pushes the repair', () => {
        nestedRepo(env.repo, `.worktrees-failed/${SLUG}`);
        git(env.repo, 'add -A');
        git(env.repo, 'commit -m "chore: pipeline artifacts (pre-sync auto-commit)"');
        git(env.repo, `push origin HEAD:refs/heads/${SYSTEM}`);
        expect(git(env.origin, `ls-tree -r ${SYSTEM}`)).toContain(`160000 commit`);

        const result = reconcileGitState(collected(env.repo, env.root), { systemBranch: SYSTEM, gitContext: null });

        const check = result.checks.find(c => c.check === 'pipeline-artifacts');
        expect(check).toEqual(expect.objectContaining({ ok: true, details: expect.stringContaining('.worktrees-failed') }));
        expect(git(env.origin, `log -1 --format=%s ${SYSTEM}`)).toBe(REPAIR_COMMIT_SUBJECT);
        expect(git(env.origin, `ls-tree -r --name-only ${SYSTEM}`)).toBe('README.md');
    });
});
