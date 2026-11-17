/**
 * Plan 30-02 steps 1–2 — executed vs deferred assignments.
 *
 * When the branch budget runs out before every assignment has run, the PR
 * workflow pushes the executed work and returns status `deferred` without
 * running gates, opening a PR or reviewing; `assignmentIds` lists only the
 * executed assignments (ASSIGN-027 was "completed" without ever running in the
 * claudeopus5 run). Also covers the deferred-status consumers: the run-manifest
 * counter and the traceability report.
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/utils/logger', () => ({ getLogger: () => mockLog, setRunLogPath: jest.fn(), logToolAction: jest.fn() }));
jest.mock('../src/utils/github-local', () => ({
    ...jest.requireActual('../src/utils/github-local'),
    GITHUB_MODE: 'local',
}));
jest.mock('../src/agents/developers/dev-agent.builder', () => ({
    buildDevAgent: jest.fn(),
    buildStrongFixerAgent: jest.fn(),
}));
jest.mock('../src/conductor/pr/agent-invoke', () => ({
    ...jest.requireActual('../src/conductor/pr/agent-invoke'),
    invokeDevAgent: jest.fn(),
}));
jest.mock('../src/conductor/pr/assignment-runner', () => ({
    ...jest.requireActual('../src/conductor/pr/assignment-runner'),
    makeBranchBudget: jest.fn(),
}));
jest.mock('../src/conductor/pr/gates', () => ({
    ...jest.requireActual('../src/conductor/pr/gates'),
    captureBaseline: jest.fn(),
    runGatesWithRepair: jest.fn(),
}));
jest.mock('../src/conductor/pr/pr-github', () => ({
    ...jest.requireActual('../src/conductor/pr/pr-github'),
    getOctokit: jest.fn(),
    createOrReusePR: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { git } from './helpers/git';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { makeState } from './helpers/state-factory';
import { executePRWorkflow } from '../src/conductor/pr/orchestrator';
import { buildDevAgent } from '../src/agents/developers/dev-agent.builder';
import { invokeDevAgent } from '../src/conductor/pr/agent-invoke';
import { makeBranchBudget } from '../src/conductor/pr/assignment-runner';
import { captureBaseline, runGatesWithRepair } from '../src/conductor/pr/gates';
import { createOrReusePR } from '../src/conductor/pr/pr-github';
import { durableCommitSubject } from '../src/conductor/pr/commit';
import { countPRsByStatus } from '../src/utils/run-snapshot';
import { buildTraceabilityReport } from '../src/utils/traceability';
import type { Assignment, PullRequest, UserStory } from '../src/agents/_shared/base-schemas';

jest.setTimeout(30_000);

const SYSTEM = 'project/app';
const BRANCH = 'app/feature/us-019-screen-flow';

function assignment(id: string): Assignment {
    return {
        id, storyId: 'US-019', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
        devAgentId: 'junior-angular', rank: 'junior', priority: 'high', complexity: 'moderate', estimate: '2h',
        description: `Implement ${id}`, dependsOn: [], branchName: BRANCH, reviewerAgentIds: ['senior-frontend'],
        taskType: 'feature', moduleIds: [],
    };
}

function pr(status: PullRequest['status'], assignmentIds: string[], prNumber = 0, branchName = BRANCH): PullRequest {
    return {
        id: prNumber ? `PR-${prNumber}` : `PR-DEFERRED-${branchName}`, prNumber, prUrl: '', title: 't', description: 'd',
        branchName, authorAgentId: 'junior-angular', reviewerAgentIds: [], reviews: [], status, assignmentIds, taskType: 'feature',
    };
}

describe('executePRWorkflow — branch budget runs out (Plan 30-02)', () => {
    let root: string;
    let origin: string;
    let repo: string;

    beforeEach(() => {
        for (const fn of Object.values(mockLog)) fn.mockClear();
        root = makeTempDir('pr-deferred-');
        origin = path.join(root, 'origin.git');
        repo = path.join(root, 'repo');
        git(root, `init --bare "${origin}"`);
        git(root, `clone "${origin}" "${repo}"`);
        git(repo, `checkout -b ${SYSTEM}`);
        fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
        git(repo, 'add -A');
        git(repo, 'commit -m "init"');
        git(repo, `push origin HEAD:refs/heads/${SYSTEM}`);

        (buildDevAgent as jest.Mock).mockReset().mockImplementation(() => ({
            getToolUsage: () => ({ reads: 4, writes: 2, shell: 1, turns: 5 }),
        }));
        // The agent writes its file into the worktree, as a real dev agent would.
        (invokeDevAgent as jest.Mock).mockReset().mockImplementation(
            async (_agent: unknown, _message: string, _thread: string, agentId: string, _model: string, _build: unknown, ctx: { worktreeDir: string }) => {
                fs.writeFileSync(path.join(ctx.worktreeDir, 'screen-flow.ts'), 'export const flow = 1;\n');
                return {
                    output: { fileChanges: [{ path: 'screen-flow.ts', action: 'created', summary: 'flow', storyId: 'US-019', agentId }] },
                    tokenUsage: null,
                    budgetCapped: false,
                };
            });
        // The budget allows the first assignment and runs out before the second.
        let checks = 0;
        (makeBranchBudget as jest.Mock).mockReset().mockImplementation(
            () => (checkpoint: string) => (++checks > 1 ? `wall time 1500s >= cap 1320s at ${checkpoint}` : null));
        (captureBaseline as jest.Mock).mockReset().mockReturnValue(null);
        (runGatesWithRepair as jest.Mock).mockReset();
        (createOrReusePR as jest.Mock).mockReset();
    });

    afterEach(() => cleanupDir(root));

    it('pushes the executed work, skips gates/PR/review, and claims only executed assignments', async () => {
        const result = await executePRWorkflow({
            branchName: BRANCH, baseBranch: SYSTEM,
            assignments: [assignment('ASSIGN-013'), assignment('ASSIGN-014'), assignment('ASSIGN-015')],
            reviewerAgentIds: ['senior-frontend'], taskType: 'feature',
            workspacePath: repo, apiKey: 'key', contextPrompt: 'context', projectSlug: 'app', gitContext: null,
        });

        expect(result.pullRequest.status).toBe('deferred');
        expect(result.pullRequest.prNumber).toBe(0);
        expect(result.pullRequest.assignmentIds).toEqual(['ASSIGN-013']);
        expect(result.deferredAssignmentIds).toEqual(['ASSIGN-014', 'ASSIGN-015']);
        expect(invokeDevAgent).toHaveBeenCalledTimes(1);
        expect(runGatesWithRepair).not.toHaveBeenCalled();
        expect(createOrReusePR).not.toHaveBeenCalled();
        // The executed assignment's durable commit is on the remote — the next round resumes from it.
        expect(git(origin, `log --format=%s refs/heads/${BRANCH}`)).toContain(durableCommitSubject('junior-angular', 'ASSIGN-013'));
        expect(result.transcript.some(t => t.message.includes('1 of 3 assignment(s) executed') && t.message.includes('2 deferred'))).toBe(true);
    });
});

describe('deferred-status consumers (Plan 30-02)', () => {
    it('the run manifest counts branches whose latest record is deferred', () => {
        const counts = countPRsByStatus([
            pr('deferred', ['A1']),                                       // round 1: deferred …
            pr('merged', ['A1', 'A2'], 7),                                // … round 2: resumed and merged
            pr('deferred', ['B1'], 0, 'app/feature/b'),                   // still deferred
        ]);
        expect(counts.branchesDeferred).toBe(1);
        expect(counts.prsMerged).toBe(1);
    });

    it('traceability lists a deferred branch as undelivered but keeps its criteria planned-only', () => {
        const story: UserStory = { id: 'US-019', epicId: 'EPIC-1', asA: 'player', iWant: 'screens', soThat: 'flow', acceptanceCriteria: ['title screen'] };
        const report = buildTraceabilityReport(makeState({
            userStories: [story],
            assignments: [assignment('ASSIGN-013'), assignment('ASSIGN-014')],
            pullRequests: [pr('deferred', ['ASSIGN-013'])],
        }));

        expect(report.blockedDeliveries).toEqual([expect.objectContaining({
            branchName: BRANCH, status: 'deferred', reason: expect.stringContaining('resumes next round'),
        })]);
        expect(report.rows.map(r => r.status)).toEqual(['planned-only']);
    });
});
