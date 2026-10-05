/**
 * Plan 30-02 steps 7–8:
 *  - Merge guard: the head GitHub would merge must be the local HEAD (local
 *    GitHub stand-in, real bare repo). A push that never landed means the PR
 *    still points at an older commit — the merge is blocked as "remote head stale".
 *  - Completion evidence: declared module ids are resolved through the repo
 *    contract (they used to be checked as file paths, so the check was always 0/N);
 *    an id the contract does not know makes the check "n/a".
 *  - settleCompletion: merged work without evidence goes back to pending with an
 *    INCOMPLETE bug until ASSIGNMENT_MAX_ATTEMPTS merges, then it is accepted.
 */
jest.mock('../src/utils/logger');

import * as fs from 'fs';
import * as path from 'path';
import { git, createTestRepo } from './helpers/git';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { createLocalGitHub } from '../src/utils/github-local';
import { checkPrHeadCurrent } from '../src/conductor/pr/pr-github';
import { computeCompletionEvidence } from '../src/conductor/pr/merge-decision';
import { settleCompletion, type CompletionEvidence } from '../src/conductor/assignment-policy';
import type { Assignment, PullRequest, RepoContract } from '../src/agents/_shared/base-schemas';
import type { GateReport } from '../src/conductor/quality-gates';

jest.setTimeout(30_000);

const NO_POLL = { attempts: 1, delayMs: 0 };

describe('merge guard — checkPrHeadCurrent (Plan 30-02)', () => {
    let root: string;
    let origin: string;
    let work: string;

    beforeEach(() => {
        root = makeTempDir('merge-guard-');
        origin = path.join(root, 'origin.git');
        work = path.join(root, 'work');
        git(root, `init --bare "${origin}"`);
        git(root, `clone "${origin}" "${work}"`);
        git(work, 'checkout -b main');
        fs.writeFileSync(path.join(work, 'README.md'), '# app\n');
        git(work, 'add -A');
        git(work, 'commit -m "init"');
        git(work, 'push origin HEAD:refs/heads/main');
        git(work, 'checkout -b feature/x');
        fs.writeFileSync(path.join(work, 'x.ts'), 'export const x = 1;\n');
        git(work, 'add -A');
        git(work, 'commit -m "x"');
        git(work, 'push origin HEAD:refs/heads/feature/x');
    });

    afterEach(() => cleanupDir(root));

    async function openPr() {
        const gh = createLocalGitHub(origin);
        const { data } = await gh.pulls.create({ owner: 'o', repo: 'r', title: 'X', body: 'b', head: 'feature/x', base: 'main' });
        return { gh, prNumber: data.number };
    }

    it('the local stand-in reports the PR head ref and sha', async () => {
        const { gh, prNumber } = await openPr();
        const { data } = await gh.pulls.get({ owner: 'o', repo: 'r', pull_number: prNumber });
        expect(data.head).toEqual({ ref: 'feature/x', sha: git(work, 'rev-parse HEAD') });
    });

    it('allows the merge when the PR head is the local HEAD', async () => {
        const { gh, prNumber } = await openPr();
        expect(await checkPrHeadCurrent(gh, 'o', 'r', prNumber, git(work, 'rev-parse HEAD'), NO_POLL)).toBeNull();
    });

    it('blocks with "remote head stale" when local commits never reached the PR', async () => {
        const { gh, prNumber } = await openPr();
        fs.writeFileSync(path.join(work, 'y.ts'), 'export const y = 2;\n');
        git(work, 'add -A');
        git(work, 'commit -m "review fix — push rejected"');

        const blocker = await checkPrHeadCurrent(gh, 'o', 'r', prNumber, git(work, 'rev-parse HEAD'), NO_POLL);

        expect(blocker).toContain('remote head stale');
        expect(blocker).toContain(git(origin, 'rev-parse refs/heads/feature/x').slice(0, 8));
    });

    it('fails closed when the PR head cannot be read', async () => {
        const { gh } = await openPr();
        const blocker = await checkPrHeadCurrent(gh, 'o', 'r', 9999, git(work, 'rev-parse HEAD'), { attempts: 2, delayMs: 0 });
        expect(blocker).toContain('remote head stale');
        expect(blocker).toContain('unavailable');
    });
});

describe('completion evidence — module ids resolved through the repo contract (Plan 30-02)', () => {
    const contract = {
        modules: [
            { id: 'MOD-STORAGE', path: 'src/storage.ts' },
            { id: 'MOD-AUDIO', path: 'src/audio.ts' },
        ],
    } as unknown as RepoContract;
    const passed = { passed: true } as GateReport;

    function assignment(id: string, moduleIds: string[]): Assignment {
        return {
            id, storyId: 'US-027', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
            devAgentId: 'junior-angular', rank: 'junior', priority: 'high', complexity: 'moderate', estimate: '2h',
            description: id, dependsOn: [], taskType: 'feature', moduleIds,
        };
    }

    it('checks declared modules at their contract paths, and reports unknown ids as n/a', () => {
        const { dir, cleanup } = createTestRepo('evidence-');
        try {
            git(dir, 'checkout -b feature/storage');
            fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'src/storage.ts'), 'export const storage = 1;\n');
            fs.writeFileSync(path.join(dir, 'docs/notes.md'), '# notes\n');
            git(dir, 'add -A');
            git(dir, 'commit -m "storage"');

            const evidence = computeCompletionEvidence(dir, 'main', [
                assignment('A-1', ['MOD-STORAGE', 'MOD-AUDIO']),
                assignment('A-2', ['MOD-STORAGE', 'MOD-UNKNOWN']),
                assignment('A-3', []),
            ], passed, contract);

            expect(evidence[0]).toMatchObject({ assignmentId: 'A-1', filesChanged: 1, declaredModulesPresent: 1, declaredModulesTotal: 2, gatePassed: true, merged: true });
            expect(evidence[0].unresolvedModuleIds).toBeUndefined();
            expect(evidence[1]).toMatchObject({ assignmentId: 'A-2', declaredModulesPresent: 0, declaredModulesTotal: 0, unresolvedModuleIds: ['MOD-UNKNOWN'] });
            expect(evidence[2]).toMatchObject({ assignmentId: 'A-3', declaredModulesPresent: 0, declaredModulesTotal: 0 });
        } finally {
            cleanup();
        }
    });
});

describe('settleCompletion — Sub-Plan 06 §6 wired into developmentNode (Plan 30-02)', () => {
    const evidence = (assignmentId: string, overrides: Partial<CompletionEvidence> = {}): CompletionEvidence => ({
        assignmentId, filesChanged: 3, declaredModulesPresent: 0, declaredModulesTotal: 0, gatePassed: true, merged: true, ...overrides,
    });
    const merged = (assignmentIds: string[], n: number): PullRequest => ({
        id: `PR-${n}`, prNumber: n, prUrl: '', title: 't', description: 'd', branchName: `b-${n}`, authorAgentId: 'junior-angular',
        reviewerAgentIds: [], reviews: [], status: 'merged', assignmentIds, taskType: 'feature',
    });

    it('keeps merged work without evidence pending, with an INCOMPLETE bug', () => {
        const res = settleCompletion(['A1', 'A2'], [evidence('A1'), evidence('A2', { filesChanged: 0 })], [merged(['A1', 'A2'], 1)], 3);
        expect(res.completed).toEqual(['A1']);
        expect(res.reopened.map(e => e.assignmentId)).toEqual(['A2']);
        expect(res.bugs.map(b => b.id)).toEqual(['INCOMPLETE-A2']);
    });

    it('accepts it once it has merged ASSIGNMENT_MAX_ATTEMPTS times, so the loop stays bounded', () => {
        const prs = [merged(['A2'], 1), merged(['A2'], 2), merged(['A2'], 3)];
        const res = settleCompletion(['A2'], [evidence('A2', { gatePassed: false })], prs, 3);
        expect(res.completed).toEqual(['A2']);
        expect(res.bugs).toEqual([]);
    });

    it('ignores evidence for assignments the merged PRs did not claim', () => {
        const res = settleCompletion(['A1'], [evidence('A1'), evidence('A9', { filesChanged: 0 })], [merged(['A1'], 1)], 3);
        expect(res.completed).toEqual(['A1']);
        expect(res.bugs).toEqual([]);
    });
});
