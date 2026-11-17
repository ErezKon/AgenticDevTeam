/**
 * Plan 30-02 step 6 — push verification in pr/commit.ts, against real temp repos.
 *
 * A non-fast-forward rejection is integrated (rebase, merge as fallback) and
 * retried once; a push that still fails returns `pushed: false`, logs an ERROR,
 * emits `branch:push-failed` and never logs "Branch pushed". Also covers the
 * durable-commit subject formatter/parser pair used to resume branches.
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
import {
    commitWorktree, pushBranch, isNonFastForward,
    durableCommitSubject, parseDurableCommitSubject, executedAssignmentIds,
} from '../src/conductor/pr/commit';
import { getRecentEvents, _resetEventBus } from '../src/utils/event-bus';

jest.setTimeout(30_000);

const BASE = 'project/app';
const BRANCH = 'app/feature/x';

/** origin (bare) + `work` (our worktree, on BRANCH) + `other` (someone else's clone of BRANCH). */
function setupRepos(): { root: string; origin: string; work: string; other: string } {
    const root = makeTempDir('push-verify-');
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    const other = path.join(root, 'other');
    git(root, `init --bare "${origin}"`);
    git(root, `clone "${origin}" "${work}"`);
    git(work, `checkout -b ${BASE}`);
    fs.writeFileSync(path.join(work, 'README.md'), '# app\n');
    git(work, 'add -A');
    git(work, 'commit -m "init"');
    git(work, `push origin HEAD:refs/heads/${BASE}`);
    git(work, `checkout -b ${BRANCH}`);
    fs.writeFileSync(path.join(work, 'a.ts'), 'export const a = 1;\n');
    git(work, 'add -A');
    git(work, 'commit -m "a"');
    git(work, `push origin HEAD:refs/heads/${BRANCH}`);
    git(root, `clone "${origin}" "${other}"`);
    git(other, `checkout ${BRANCH}`);
    return { root, origin, work, other };
}

/** Someone else pushes `file` = `content` to BRANCH; returns the new remote head. */
function pushFromOther(other: string, file: string, content: string): string {
    fs.writeFileSync(path.join(other, file), content);
    git(other, 'add -A');
    git(other, `commit -m "other: ${file}"`);
    git(other, `push origin HEAD:refs/heads/${BRANCH}`);
    return git(other, 'rev-parse HEAD');
}

const events = (type: string) => getRecentEvents().filter(e => e.type === type).map(e => e.payload);
const commit = (work: string, assignmentId: string) =>
    commitWorktree(work, BRANCH, 'app', 'US-001', 'feat', durableCommitSubject('junior-angular', assignmentId), null);

let repos: ReturnType<typeof setupRepos>;

beforeEach(() => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    _resetEventBus();
    repos = setupRepos();
});

afterEach(() => cleanupDir(repos.root));

describe('commitWorktree / pushBranch push verification (Plan 30-02)', () => {
    it('integrates a non-fast-forward rejection and retries once', () => {
        const { origin, work, other } = repos;
        pushFromOther(other, 'b.ts', 'export const b = 2;\n');
        fs.writeFileSync(path.join(work, 'c.ts'), 'export const c = 3;\n');

        const res = commit(work, 'ASSIGN-002');

        expect(res.pushed).toBe(true);
        expect(res.error).toBeUndefined();
        const remoteHead = git(origin, `rev-parse refs/heads/${BRANCH}`);
        expect(res.sha).toBe(remoteHead);
        expect(git(work, 'rev-parse HEAD')).toBe(remoteHead);
        // Both sides' work is on the branch
        expect(fs.existsSync(path.join(work, 'b.ts'))).toBe(true);
        expect(git(origin, `show --name-only --format= ${remoteHead}`)).toContain('c.ts');
        expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('non-fast-forward'));
        expect(events('branch:pushed')).toHaveLength(1);
        expect(events('branch:push-failed')).toEqual([]);
    });

    it('a persistent rejection returns pushed:false, logs an ERROR and never "Branch pushed"', () => {
        const { origin, work, other } = repos;
        const theirs = pushFromOther(other, 'a.ts', 'export const a = "theirs";\n');
        fs.writeFileSync(path.join(work, 'a.ts'), 'export const a = "ours";\n');

        const res = commit(work, 'ASSIGN-002');

        expect(res.pushed).toBe(false);
        expect(res.error).toContain('conflicts');
        expect(res.sha).toBe(git(work, 'rev-parse HEAD'));   // the local commit is kept
        expect(git(origin, `rev-parse refs/heads/${BRANCH}`)).toBe(theirs);
        expect(git(work, 'status --porcelain')).toBe('');    // rebase and merge were aborted
        expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining('Branch pushed'));
        expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining(`Push of ${BRANCH} FAILED`));
        expect(events('branch:push-failed')).toEqual([expect.objectContaining({ branchName: BRANCH })]);
        expect(events('branch:pushed')).toEqual([]);
    });

    it('a rejection that is not non-fast-forward is reported without an integration attempt', () => {
        const { origin, work } = repos;
        fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "push frozen" >&2\nexit 1\n', { mode: 0o755 });
        fs.writeFileSync(path.join(work, 'd.ts'), 'export const d = 4;\n');

        const res = commit(work, 'ASSIGN-003');

        expect(res.pushed).toBe(false);
        expect(res.error).toContain('pre-receive hook declined');
        expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('non-fast-forward'));
        expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining('Branch pushed'));
    });

    it('nothing to commit: no commit, no push, no error', () => {
        const res = commit(repos.work, 'ASSIGN-004');
        expect(res).toEqual({ sha: null, pushed: false });
        expect(events('branch:pushed')).toEqual([]);
    });

    it('pushBranch pushes commits an earlier failed push left behind', () => {
        const { origin, work } = repos;
        fs.writeFileSync(path.join(work, 'e.ts'), 'export const e = 5;\n');
        git(work, 'add -A');
        git(work, 'commit -m "local only"');

        expect(pushBranch(work, BRANCH, null)).toEqual({ pushed: true });
        expect(git(origin, `rev-parse refs/heads/${BRANCH}`)).toBe(git(work, 'rev-parse HEAD'));
    });

    it('recognises git non-fast-forward rejections', () => {
        expect(isNonFastForward(' ! [rejected]        HEAD -> app/feature/x (fetch first)')).toBe(true);
        expect(isNonFastForward(' ! [rejected]        HEAD -> app/feature/x (non-fast-forward)')).toBe(true);
        expect(isNonFastForward(' ! [remote rejected] HEAD -> app/feature/x (pre-receive hook declined)')).toBe(false);
    });
});

describe('durable-commit subjects (Plan 30-02)', () => {
    it('round-trips through the formatter and parser, including the prefixed commit line', () => {
        const subject = durableCommitSubject('junior-angular', 'BUGFIX-2-ASSIGN-021');
        expect(parseDurableCommitSubject(subject)).toBe('BUGFIX-2-ASSIGN-021');
        expect(parseDurableCommitSubject(`[app]-[US-027]-feat: ${subject}`)).toBe('BUGFIX-2-ASSIGN-021');
        expect(parseDurableCommitSubject('[app]-[US-027]-chore: final cleanup for app/feature/x')).toBeNull();
        expect(parseDurableCommitSubject('[app]-[US-027]-fix: address review comments (fix for x, iteration 1)')).toBeNull();
    });

    it('a failed run is marked, so a resumed branch runs that assignment again', () => {
        const failed = durableCommitSubject('junior-angular', 'ASSIGN-021', true);
        expect(failed).toBe('work from junior-angular on ASSIGN-021 (durable commit, failed)');
        expect(parseDurableCommitSubject(`[app]-[US-027]-feat: ${failed}`)).toBeNull();
    });

    it('executedAssignmentIds reads the successful durable commits on the branch, not the base', () => {
        const { work } = repos;
        git(work, `commit --allow-empty -m "[app]-[US-001]-feat: ${durableCommitSubject('junior-angular', 'ASSIGN-001')}"`);
        git(work, `commit --allow-empty -m "[app]-[US-001]-feat: ${durableCommitSubject('senior-frontend', 'ASSIGN-002')}"`);
        git(work, `commit --allow-empty -m "[app]-[US-001]-feat: ${durableCommitSubject('senior-frontend', 'ASSIGN-003', true)}"`);
        git(work, 'commit --allow-empty -m "[app]-[US-001]-chore: final cleanup for app/feature/x"');

        expect([...executedAssignmentIds(work, BASE)].sort()).toEqual(['ASSIGN-001', 'ASSIGN-002']);
        expect([...executedAssignmentIds(work, 'HEAD')]).toEqual([]);
    });

    it('an unreadable range yields no executed assignments (re-running is safe, skipping is not)', () => {
        expect(executedAssignmentIds(repos.work, 'no-such-ref').size).toBe(0);
        expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('every assignment will run'));
    });
});
