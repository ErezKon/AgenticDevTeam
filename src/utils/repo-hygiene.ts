/**
 * Repository hygiene (Plan 30-04): pipeline internals never reach the product repo.
 *
 * In the claudeopus5 run the development node's `.gitignore` block lacked
 * `.worktrees-failed/`. The pre-sync auto-commit (`git add .`) then staged the
 * salvaged worktree as a gitlink (`Subproject commit d249047…`) and pushed it to
 * the system branch (commit d721a0d).
 *
 * - `stageWorkspaceChanges()` replaces every `git add .`. It never stages a
 *   pipeline directory, refuses to stage a gitlink `.gitmodules` does not
 *   declare (a worktree, or an agent's `git init` / `ng new`), and leaves
 *   conflicted files that still contain conflict markers unstaged, so a merge
 *   cannot be completed with them.
 * - `removePipelineArtifacts()` repairs a repository an earlier run polluted:
 *   it takes the committed worktree directories out of the index.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';
import { gitExec, findGitRoot } from './git-exec';
import { PIPELINE_DIRS, WORKTREE_DIRS } from './workspace';

const log = getLogger('[RepoHygiene]', 136);

const GITLINK_MODE = '160000';
const CONFLICT_MARKER_RE = /^(?:<{7}|>{7})(?: |$)/m;

/** Subject of the commit that removes pipeline artifacts from the index. */
export const REPAIR_COMMIT_SUBJECT = 'chore: remove pipeline worktree artifacts';

/** One `gitExec` argument (it shell-splits its argument string), quoted so any path survives. */
function quoteArg(arg: string): string {
    return `"${arg.replace(/["\\]/g, '\\$&')}"`;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Paths `.gitmodules` declares (repository-relative): the only legitimate gitlinks. */
function declaredSubmodules(repoRoot: string): Set<string> {
    const file = path.join(repoRoot, '.gitmodules');
    if (!fs.existsSync(file)) return new Set();
    return new Set([...fs.readFileSync(file, 'utf-8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(m => m[1]));
}

/** Unmerged files (relative to `dir`) whose content still has conflict markers. */
function filesWithConflictMarkers(dir: string): string[] {
    const out = gitExec(dir, 'diff --name-only --diff-filter=U --relative -z');
    if (out.startsWith('Error:')) return [];
    return out.split('\0').filter(Boolean).filter(file => {
        const abs = path.join(dir, file);
        return fs.existsSync(abs) && fs.statSync(abs).isFile() && CONFLICT_MARKER_RE.test(fs.readFileSync(abs, 'utf-8'));
    });
}

interface StagedEntry { dstMode: string; status: string; path: string }

/** What the next commit would record: `git diff --cached --raw -z` (paths relative to `dir`). */
function stagedEntries(dir: string): StagedEntry[] | string {
    const out = gitExec(dir, 'diff --cached --raw --no-renames --relative -z');
    if (out.startsWith('Error:')) return out;
    const fields = out.split('\0');
    const entries: StagedEntry[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const m = /^:\d{6} (\d{6}) \S+ \S+ ([A-Z])\d*$/.exec(fields[i]);
        if (m) entries.push({ dstMode: m[1], status: m[2], path: fields[i + 1] });
    }
    return entries;
}

export interface StagedChanges {
    /** Paths the next commit records, relative to the staged directory. */
    staged: string[];
    /** Nested repositories (gitlinks `.gitmodules` does not declare) that were not staged. */
    droppedGitlinks: string[];
    /** Conflicted files that still contain conflict markers — left unstaged, so the merge stays open. */
    unresolvedConflicts: string[];
    /** Set when staging failed; nothing should be committed. */
    error?: string;
}

/**
 * Stage every change under `dir` except the pipeline directories (`git add -A`
 * with `:(exclude)` pathspecs), then unstage, with an ERROR, any nested
 * repository (`160000` gitlink) that `.gitmodules` does not declare: a new one
 * leaves the index, a committed one keeps its committed entry. Fails closed:
 * when a gitlink cannot be unstaged, `error` is set.
 */
export function stageWorkspaceChanges(dir: string): StagedChanges {
    const result: StagedChanges = { staged: [], droppedGitlinks: [], unresolvedConflicts: [] };
    try {
        result.unresolvedConflicts = filesWithConflictMarkers(dir);
        const excludes = [
            ...PIPELINE_DIRS.map(d => `:(exclude)${d}`),
            ...result.unresolvedConflicts.map(f => `:(exclude,literal)${f}`),
        ];
        const add = gitExec(dir, `add -A -- . ${excludes.map(quoteArg).join(' ')}`);
        if (add.startsWith('Error:')) return { ...result, error: add };
        const entries = stagedEntries(dir);
        if (typeof entries === 'string') return { ...result, error: entries };

        const repoRoot = findGitRoot(dir);
        const declared = declaredSubmodules(repoRoot);
        const gitlinks = entries.filter(e => e.dstMode === GITLINK_MODE
            && !declared.has(toPosix(path.relative(repoRoot, path.resolve(dir, e.path)))));
        if (gitlinks.length > 0) {
            const literal = (list: StagedEntry[]) => list.map(e => quoteArg(`:(literal)${e.path}`)).join(' ');
            const added = gitlinks.filter(e => e.status === 'A');
            const committed = gitlinks.filter(e => e.status !== 'A');
            const failed = [
                added.length > 0 ? gitExec(dir, `rm --cached -r -f -- ${literal(added)}`) : '',
                committed.length > 0 ? gitExec(dir, `reset -q -- ${literal(committed)}`) : '',
            ].find(out => out.startsWith('Error:'));
            const paths = gitlinks.map(e => e.path);
            if (failed) return { ...result, error: `cannot unstage nested repositories ${paths.join(', ')}: ${failed}` };
            log.error(`Refusing to commit ${paths.length} nested git repositor${paths.length === 1 ? 'y' : 'ies'} `
                + `(gitlink not declared in .gitmodules): ${paths.join(', ')} — not staged. `
                + 'A pipeline worktree, or a `git init` / `ng new` inside the repository?');
            result.droppedGitlinks = paths;
        }
        result.staged = entries.filter(e => e.status !== 'U' && !result.droppedGitlinks.includes(e.path)).map(e => e.path);
        return result;
    } catch (err: any) {
        return { ...result, error: err.message };
    }
}

// ─── Repair (Plan 30-04 step 4) ─────────────────────────────────────────────

/**
 * The worktree directories an earlier run committed by mistake: any index entry
 * (a gitlink or a file) under `.worktrees/` or `.worktrees-failed/`. Nothing
 * else is touched — a user's own nested repository is not a pipeline artifact.
 */
export function findPipelineArtifacts(gitRoot: string): { paths: string[]; error?: string } {
    const out = gitExec(gitRoot, 'ls-files -z');
    if (out.startsWith('Error:')) return { paths: [], error: out };
    const files = out.split('\0').filter(Boolean);
    return { paths: WORKTREE_DIRS.filter(d => files.some(f => f === d || f.startsWith(`${d}/`))) };
}

export interface ArtifactRepair {
    /** Paths removed from the index (the working tree is not touched). */
    removed: string[];
    /** The repair commit, or null when nothing was committed. */
    commit: string | null;
    error?: string;
}

/**
 * Remove pipeline artifacts from the index of the checked-out branch of the
 * repository containing `dir`, and commit `chore: remove pipeline worktree
 * artifacts`. The caller pushes the branch. Skipped (with `error`) when other
 * changes are already staged, so the repair commit never carries unrelated work.
 */
export function removePipelineArtifacts(dir: string): ArtifactRepair {
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(dir);
    } catch (err: any) {
        return { removed: [], commit: null, error: err.message };
    }
    const found = findPipelineArtifacts(gitRoot);
    if (found.error) return { removed: [], commit: null, error: found.error };
    if (found.paths.length === 0) return { removed: [], commit: null };
    const staged = gitExec(gitRoot, 'diff --cached --name-only');
    if (staged !== '') {
        return { removed: [], commit: null, error: staged.startsWith('Error:') ? staged : `other changes are staged — not removing ${found.paths.join(', ')}` };
    }
    const rm = gitExec(gitRoot, `rm --cached -r -f -- ${found.paths.map(p => quoteArg(`:(literal)${p}`)).join(' ')}`);
    if (rm.startsWith('Error:')) return { removed: [], commit: null, error: rm };
    const commit = gitExec(gitRoot, `commit -m "${REPAIR_COMMIT_SUBJECT}"`);
    if (commit.startsWith('Error:')) {
        gitExec(gitRoot, 'reset -q');
        return { removed: [], commit: null, error: commit };
    }
    const sha = gitExec(gitRoot, 'rev-parse HEAD');
    log.warn(`Removed pipeline artifacts an earlier run committed: ${found.paths.join(', ')} `
        + `(commit ${sha.slice(0, 8)} "${REPAIR_COMMIT_SUBJECT}")`);
    return { removed: found.paths, commit: sha.startsWith('Error:') ? null : sha };
}
