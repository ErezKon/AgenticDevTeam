/**
 * Plan 30-04 — safe staging (`stageWorkspaceChanges`) and the polluted-repo
 * repair (`removePipelineArtifacts`), against real temp repos.
 *
 * claudeopus5's pre-sync auto-commit ran `git add .` after a `.gitignore`
 * rewrite had dropped `.worktrees-failed/`, so a salvaged worktree was committed
 * as a gitlink and pushed to the system branch (commit d721a0d).
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/utils/logger', () => ({ getLogger: () => mockLog, setRunLogPath: jest.fn(), logToolAction: jest.fn() }));

import * as fs from 'fs';
import * as path from 'path';
import { git, createTestRepo } from './helpers/git';
import {
    stageWorkspaceChanges, findPipelineArtifacts, removePipelineArtifacts, REPAIR_COMMIT_SUBJECT,
} from '../src/utils/repo-hygiene';
import { commitAndPush } from '../src/conductor/pr/commit';

jest.setTimeout(30_000);

function write(dir: string, file: string, content = 'x\n'): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

/** A directory holding its own repository — what a worktree, `git init` or `ng new` leaves behind. */
function nestedRepo(dir: string, rel: string): void {
    const nested = path.join(dir, rel);
    fs.mkdirSync(nested, { recursive: true });
    git(nested, 'init');
    write(nested, 'main.ts', 'export {};\n');
    git(nested, 'add -A');
    git(nested, 'commit -m nested');
}

/** `<mode> <path>` of every index entry. */
const indexEntries = (dir: string): string[] => git(dir, 'ls-files -s').split('\n').filter(Boolean)
    .map(line => `${line.split(' ')[0]} ${line.split('\t')[1]}`);

let repo: { dir: string; cleanup: () => void };

beforeEach(() => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    repo = createTestRepo('repo-hygiene-');
});

afterEach(() => repo.cleanup());

describe('stageWorkspaceChanges (Plan 30-04)', () => {
    it('never stages a pipeline directory, even when no .gitignore lists it', () => {
        write(repo.dir, 'src/app.ts', 'export const app = 1;\n');
        for (const dir of ['.worktrees/app-feature-x', '.worktrees-failed/app-feature-y', '.agent', '.conventions']) {
            write(repo.dir, `${dir}/notes.md`);
        }

        expect(stageWorkspaceChanges(repo.dir)).toEqual({ staged: ['src/app.ts'], droppedGitlinks: [], unresolvedConflicts: [] });
        expect(git(repo.dir, 'diff --cached --name-only')).toBe('src/app.ts');
    });

    it('takes a nested repository out of the index with an ERROR; a salvaged worktree is never even staged', () => {
        nestedRepo(repo.dir, '.worktrees-failed/claudeopus5-feature-us-027');
        nestedRepo(repo.dir, 'ng-app');
        write(repo.dir, 'src/app.ts');

        const res = stageWorkspaceChanges(repo.dir);

        expect(res.staged).toEqual(['src/app.ts']);
        expect(res.droppedGitlinks).toEqual(['ng-app']);
        expect(indexEntries(repo.dir)).toEqual(['100644 README.md', '100644 src/app.ts']);
        expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('nested git repository'));
        expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('ng-app'));
    });

    it('a nested repository that is already committed keeps its committed entry', () => {
        nestedRepo(repo.dir, 'vendor-app');
        git(repo.dir, 'add -A');
        git(repo.dir, 'commit -m "vendor app"');
        const committed = git(repo.dir, 'ls-files -s vendor-app');
        write(path.join(repo.dir, 'vendor-app'), 'next.ts');
        git(path.join(repo.dir, 'vendor-app'), 'add -A');
        git(path.join(repo.dir, 'vendor-app'), 'commit -m next');

        const res = stageWorkspaceChanges(repo.dir);

        expect(res).toEqual({ staged: [], droppedGitlinks: ['vendor-app'], unresolvedConflicts: [] });
        expect(git(repo.dir, 'ls-files -s vendor-app')).toBe(committed);
    });

    it('keeps a submodule that .gitmodules declares', () => {
        nestedRepo(repo.dir, 'libs/engine');
        write(repo.dir, '.gitmodules', '[submodule "libs/engine"]\n\tpath = libs/engine\n\turl = https://example.com/engine.git\n');

        const res = stageWorkspaceChanges(repo.dir);

        expect(res.droppedGitlinks).toEqual([]);
        expect([...res.staged].sort()).toEqual(['.gitmodules', 'libs/engine']);
        expect(indexEntries(repo.dir)).toContain('160000 libs/engine');
        expect(mockLog.error).not.toHaveBeenCalled();
    });

    it('from a subdirectory: stages only below it, with paths relative to it', () => {
        write(repo.dir, 'app/src/main.ts');
        nestedRepo(repo.dir, 'app/ng-app');
        write(repo.dir, 'other.txt');

        const res = stageWorkspaceChanges(path.join(repo.dir, 'app'));

        expect(res.staged).toEqual(['src/main.ts']);
        expect(res.droppedGitlinks).toEqual(['ng-app']);
        expect(git(repo.dir, 'diff --cached --name-only')).toBe('app/src/main.ts');
    });

    it('leaves a conflicted file that still has conflict markers unstaged, so the merge cannot be completed with them', () => {
        write(repo.dir, 'a.ts', 'base\n');
        git(repo.dir, 'add -A');
        git(repo.dir, 'commit -m base');
        git(repo.dir, 'checkout -b other');
        write(repo.dir, 'a.ts', 'theirs\n');
        git(repo.dir, 'commit -am theirs');
        git(repo.dir, 'checkout main');
        write(repo.dir, 'a.ts', 'ours\n');
        git(repo.dir, 'commit -am ours');
        expect(() => git(repo.dir, 'merge other')).toThrow();
        write(repo.dir, 'b.ts');
        const head = git(repo.dir, 'rev-parse HEAD');

        const open = stageWorkspaceChanges(repo.dir);
        expect(open.unresolvedConflicts).toEqual(['a.ts']);
        expect(open.staged).toEqual(['b.ts']);
        expect(git(repo.dir, 'diff --name-only --diff-filter=U')).toBe('a.ts');
        // The merge ladder's commit after a conflict-resolution attempt commits nothing
        const commit = commitAndPush(repo.dir, 'main', 'resolve merge conflicts (attempt 1)', null);
        expect(commit).toEqual({ sha: null, pushed: false, error: expect.stringContaining('merge-conflict markers') });
        expect(git(repo.dir, 'rev-parse HEAD')).toBe(head);

        write(repo.dir, 'a.ts', 'ours and theirs\n');
        const resolved = stageWorkspaceChanges(repo.dir);
        expect(resolved.unresolvedConflicts).toEqual([]);
        expect(resolved.staged).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
        expect(git(repo.dir, 'diff --name-only --diff-filter=U')).toBe('');
    });
});

describe('removePipelineArtifacts (Plan 30-04 step 4)', () => {
    /** What the old `git add .` committed: a salvaged worktree (gitlink), a worktree file and a nested repo. */
    function pollute(dir: string): void {
        nestedRepo(dir, '.worktrees-failed/claudeopus5-feature-us-027');
        write(dir, '.worktrees/notes.txt');
        nestedRepo(dir, 'vendor-app');
        git(dir, 'add -A');
        git(dir, 'commit -m "chore: pipeline artifacts (pre-sync auto-commit)"');
    }

    it('finds the worktree directories, and nothing else', () => {
        pollute(repo.dir);
        expect(findPipelineArtifacts(repo.dir).paths).toEqual(['.worktrees', '.worktrees-failed']);
    });

    it('removes them from the index in one repair commit and leaves the working tree alone', () => {
        pollute(repo.dir);

        const res = removePipelineArtifacts(repo.dir);

        expect(res.error).toBeUndefined();
        expect(res.removed).toEqual(['.worktrees', '.worktrees-failed']);
        expect(res.commit).toBe(git(repo.dir, 'rev-parse HEAD'));
        expect(git(repo.dir, 'log -1 --format=%s')).toBe(REPAIR_COMMIT_SUBJECT);
        // A nested repository outside the worktree directories is not the pipeline's to remove
        expect(indexEntries(repo.dir)).toEqual(['100644 README.md', '160000 vendor-app']);
        expect(fs.existsSync(path.join(repo.dir, '.worktrees-failed/claudeopus5-feature-us-027/main.ts'))).toBe(true);
        expect(removePipelineArtifacts(repo.dir)).toEqual({ removed: [], commit: null });
    });

    it('keeps a declared submodule, and does nothing in a clean repo', () => {
        nestedRepo(repo.dir, 'libs/engine');
        write(repo.dir, '.gitmodules', '[submodule "libs/engine"]\n\tpath = libs/engine\n\turl = https://example.com/engine.git\n');
        git(repo.dir, 'add -A');
        git(repo.dir, 'commit -m "add engine submodule"');
        const head = git(repo.dir, 'rev-parse HEAD');

        expect(removePipelineArtifacts(repo.dir)).toEqual({ removed: [], commit: null });
        expect(git(repo.dir, 'rev-parse HEAD')).toBe(head);
    });

    it('never mixes the repair with other staged changes', () => {
        pollute(repo.dir);
        write(repo.dir, 'src/app.ts');
        git(repo.dir, 'add src/app.ts');

        const res = removePipelineArtifacts(repo.dir);

        expect(res.commit).toBeNull();
        expect(res.error).toContain('other changes are staged');
        expect(git(repo.dir, 'log -1 --format=%s')).not.toBe(REPAIR_COMMIT_SUBJECT);
    });
});
