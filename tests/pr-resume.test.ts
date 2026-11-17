/**
 * Plan 30-02 step 5 — a branch that was pushed in an earlier round (blocked,
 * open or deferred) resumes from its remote head, against real temp repos:
 * executed assignments are recognised from their durable commits and skipped,
 * the latest base is merged in before any dev work, and the next push is a
 * fast-forward (round 2/3 of the claudeopus5 run rebuilt the branch from the
 * base, so every push was rejected as non-fast-forward).
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/utils/logger', () => ({ getLogger: () => mockLog, setRunLogPath: jest.fn() }));
// gitPush pushes to `origin` (the bare repo) instead of github.com
jest.mock('../src/utils/github-local', () => ({
    ...jest.requireActual('../src/utils/github-local'),
    GITHUB_MODE: 'local',
}));

import * as fs from 'fs';
import * as path from 'path';
import { git } from './helpers/git';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { createBranchWorktree } from '../src/conductor/pr/worktree';
import { commitWorktree, durableCommitSubject, executedAssignmentIds } from '../src/conductor/pr/commit';
import { resolveBaseRef } from '../src/conductor/pr/agent-invoke';
import { integrateBase } from '../src/conductor/pr/merge-ladder';
import { partitionByExecution } from '../src/conductor/pr/assignment-runner';
import type { Assignment } from '../src/agents/_shared/base-schemas';

jest.setTimeout(30_000);

const SYSTEM = 'project/app';
const BRANCH = 'app/feature/us-027-storage';

function assignment(id: string): Assignment {
    return {
        id, storyId: 'US-027', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
        devAgentId: 'junior-angular', rank: 'junior', priority: 'high', complexity: 'moderate', estimate: '2h',
        description: `Implement ${id}`, dependsOn: [], branchName: BRANCH, reviewerAgentIds: ['senior-frontend'],
        taskType: 'feature', moduleIds: [],
    };
}

function write(dir: string, file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

/**
 * Round 1 ran ASSIGN-021 on BRANCH and the PR was blocked: the branch is on the
 * remote, its local branch was disposed, and another PR has since merged into the base.
 */
function setupBlockedBranch(): { root: string; origin: string; repo: string; round1Head: string } {
    const root = makeTempDir('pr-resume-');
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    git(root, `init --bare "${origin}"`);
    git(root, `clone "${origin}" "${repo}"`);
    git(repo, `checkout -b ${SYSTEM}`);
    write(repo, 'README.md', '# app\n');
    git(repo, 'add -A');
    git(repo, 'commit -m "init"');
    git(repo, `push origin HEAD:refs/heads/${SYSTEM}`);

    git(repo, `checkout -b ${BRANCH}`);
    write(repo, 'src/storage.ts', 'export const storage = 1;\n');
    git(repo, 'add -A');
    git(repo, `commit -m "[app]-[US-027]-feat: ${durableCommitSubject('junior-angular', 'ASSIGN-021')}"`);
    git(repo, `push origin HEAD:refs/heads/${BRANCH}`);
    const round1Head = git(repo, 'rev-parse HEAD');
    git(repo, `checkout ${SYSTEM}`);
    git(repo, `branch -D ${BRANCH}`);

    write(repo, 'src/engine.ts', 'export const engine = 1;\n');
    git(repo, 'add -A');
    git(repo, 'commit -m "feat: engine (#1)"');
    git(repo, `push origin HEAD:refs/heads/${SYSTEM}`);
    return { root, origin, repo, round1Head };
}

let setup: ReturnType<typeof setupBlockedBranch>;

beforeEach(() => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    setup = setupBlockedBranch();
});

afterEach(() => cleanupDir(setup.root));

describe('resumable re-dispatch (Plan 30-02)', () => {
    it('resumes a pushed branch from origin/<branch> instead of rebuilding it from the base', () => {
        const wt = createBranchWorktree(setup.repo, BRANCH, SYSTEM);

        expect(wt.resumedFrom).toBe(`origin/${BRANCH}`);
        expect(git(wt.worktreeWorkspace, 'rev-parse HEAD')).toBe(setup.round1Head);
        expect(git(wt.worktreeWorkspace, 'rev-parse --abbrev-ref HEAD')).toBe(BRANCH);
        expect(fs.existsSync(path.join(wt.worktreeWorkspace, 'src/storage.ts'))).toBe(true);
    });

    it('cuts a branch the remote does not have from the base', () => {
        const wt = createBranchWorktree(setup.repo, 'app/feature/new', SYSTEM);

        expect(wt.resumedFrom).toBeNull();
        expect(git(wt.worktreeWorkspace, 'rev-parse HEAD')).toBe(git(setup.origin, `rev-parse refs/heads/${SYSTEM}`));
    });

    it('skips executed assignments, merges the base in first, and pushes fast-forward', async () => {
        const wt = createBranchWorktree(setup.repo, BRANCH, SYSTEM);
        const dir = wt.worktreeWorkspace;
        git(dir, `fetch origin ${SYSTEM}`);
        const baseRef = resolveBaseRef(dir, SYSTEM);
        expect(baseRef).toBe(`origin/${SYSTEM}`);

        // Executed work is read back from the durable-commit subjects
        const executed = executedAssignmentIds(dir, baseRef);
        expect([...executed]).toEqual(['ASSIGN-021']);
        const { previouslyExecuted, toRun } = partitionByExecution(
            [assignment('ASSIGN-021'), assignment('ASSIGN-022'), assignment('BUGFIX-1-ASSIGN-021')], executed);
        expect(previouslyExecuted.map(a => a.id)).toEqual(['ASSIGN-021']);
        expect(toRun.map(a => a.id)).toEqual(['ASSIGN-022', 'BUGFIX-1-ASSIGN-021']);

        // The latest base is merged in before any dev work
        const integration = await integrateBase(
            dir, BRANCH, SYSTEM, 'app', 'US-027', toRun, 'context', 'key', null, [], false, { worktreeDir: dir, baseRef });
        expect(integration.resolved).toBe(true);
        expect(fs.existsSync(path.join(dir, 'src/engine.ts'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'src/storage.ts'))).toBe(true);

        // New work on top: the push is a fast-forward of round 1's head
        write(dir, 'src/storage-ui.ts', 'export const ui = 1;\n');
        const res = commitWorktree(dir, BRANCH, 'app', 'US-027', 'feat', durableCommitSubject('junior-angular', 'ASSIGN-022'), null);
        expect(res.pushed).toBe(true);
        const remoteHead = git(setup.origin, `rev-parse refs/heads/${BRANCH}`);
        expect(remoteHead).toBe(git(dir, 'rev-parse HEAD'));
        expect(() => git(setup.origin, `merge-base --is-ancestor ${setup.round1Head} ${remoteHead}`)).not.toThrow();
        expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('non-fast-forward'));

        // The next resume sees both assignments as executed
        expect([...executedAssignmentIds(dir, baseRef)].sort()).toEqual(['ASSIGN-021', 'ASSIGN-022']);
    });
});
