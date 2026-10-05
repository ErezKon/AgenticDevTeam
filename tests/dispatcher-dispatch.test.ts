/**
 * Dispatcher execution (Plan 30-01) with the PR workflow mocked:
 * branch DAG order, DISPATCH_HALT_POLICY reactions, stop reasons, and the
 * workspace sync after a scaffold merge (never a feature-branch checkout).
 */
jest.mock('../src/utils/logger');
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    SEQUENTIAL_DISPATCH: true,
    INTER_BATCH_DELAY_MS: 0,
    DISPATCH_HALT_POLICY: 'dependents',
}));
jest.mock('../src/conductor/pr-workflow', () => ({ executePRWorkflow: jest.fn() }));
jest.mock('../src/conductor/workspace-sync', () => ({ syncWorkspaceToBranch: jest.fn() }));
jest.mock('../src/utils/run-budget', () => ({
    getEffectiveLimits: () => ({ allowNewBranchWorkflows: true }),
    getBudgetStatus: () => ({ maxWallMs: 0, elapsedMs: 0 }),
}));
jest.mock('../src/utils/git-exec', () => ({
    ...jest.requireActual('../src/utils/git-exec'),
    findGitRoot: () => '/repo',
}));

import { executePRWorkflow } from '../src/conductor/pr-workflow';
import type { PRWorkflowInput, PRWorkflowResult } from '../src/conductor/pr-workflow';
import { syncWorkspaceToBranch } from '../src/conductor/workspace-sync';
import { dispatchDevelopers } from '../src/agents/developers/dispatcher';
import { getRecentEvents, _resetEventBus } from '../src/utils/event-bus';
import type { Assignment, PullRequest } from '../src/agents/_shared/base-schemas';

const config = jest.requireMock<{ DISPATCH_HALT_POLICY: string }>('../src/config');
const workflow = executePRWorkflow as jest.MockedFunction<typeof executePRWorkflow>;
const sync = syncWorkspaceToBranch as jest.MockedFunction<typeof syncWorkspaceToBranch>;

const SYSTEM = 'project/app';
const SCAFFOLD = 'app/chore/scaffold';
const A = 'app/feature/a';
const B = 'app/feature/b';
const C = 'app/feature/c';

function assignment(id: string, branchName: string, dependsOn: string[] = []): Assignment {
    return {
        id, storyId: `US-${id}`, additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
        devAgentId: 'senior-frontend', rank: 'senior', priority: 'high', complexity: 'moderate', estimate: '2h',
        description: `Implement ${id}`, dependsOn, branchName, reviewerAgentIds: ['principal-frontend'],
        taskType: 'feature', moduleIds: [],
    };
}

function result(input: PRWorkflowInput, status: PullRequest['status']): PRWorkflowResult {
    return {
        pullRequest: {
            id: `PR-${input.branchName}`, prNumber: 1, prUrl: '', title: input.branchName, description: '',
            branchName: input.branchName, authorAgentId: input.assignments[0].devAgentId, reviewerAgentIds: [],
            reviews: [], status, assignmentIds: input.assignments.map(a => a.id), taskType: input.taskType,
        },
        fileChanges: [], artifacts: [], transcript: [], tokenUsage: [],
    };
}

/** Outcome per branch for the next dispatch; unlisted branches merge. */
let outcomes: Record<string, PullRequest['status']> = {};

const run = (assignments: Assignment[], abandoned: string[] = []) => dispatchDevelopers(
    'key', assignments, '/repo/app', 'context', SYSTEM, 'app', null, [], [], [], false, undefined, [], null, abandoned,
);
const dispatched = () => workflow.mock.calls.map(([input]) => input.branchName);
const events = (type: string) => getRecentEvents().filter(e => e.type === type).map(e => e.payload);

// scaffold ← a ← b ;  scaffold ← c   (listed out of order on purpose)
const PLAN = [
    assignment('B1', B, ['A1']),
    assignment('A1', A),
    assignment('C1', C),
    assignment('S1', SCAFFOLD),
];

beforeEach(() => {
    outcomes = {};
    workflow.mockReset();
    workflow.mockImplementation(async input => result(input, outcomes[input.branchName] ?? 'merged'));
    sync.mockReset();
    sync.mockResolvedValue({ ok: true, headSha: 'abc123', details: 'fast-forward', strategy: 'fast-forward' });
    _resetEventBus();
    config.DISPATCH_HALT_POLICY = 'dependents';
});

afterAll(() => {
    config.DISPATCH_HALT_POLICY = 'dependents';
});

describe('dispatchDevelopers (Plan 30-01)', () => {
    it('dispatches branches in dependency order and syncs the system branch after the scaffold merge', async () => {
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A, C, B]);
        expect(sync).toHaveBeenCalledTimes(1);
        expect(sync).toHaveBeenCalledWith('/repo', SYSTEM, null);
        expect(res.stopReason).toBeNull();
        expect(res.completedAssignmentIds.sort()).toEqual(['A1', 'B1', 'C1', 'S1']);
        expect(events('dispatch:plan')).toEqual([expect.objectContaining({ order: [SCAFFOLD, A, C, B] })]);
    });

    it('cuts every branch from the system branch and passes the planned dependencies', async () => {
        await run(PLAN);

        const inputs = workflow.mock.calls.map(([input]) => input);
        expect(inputs.every(i => i.baseBranch === SYSTEM)).toBe(true);
        const bInput = inputs.find(i => i.branchName === B)!;
        expect(bInput.assignments[0].dependsOn).toEqual(['A1', 'S1']);
    });

    it('dependents: a failed branch skips only the branches that depend on it', async () => {
        outcomes[A] = 'blocked';
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A, C]);
        expect(res.stopReason).toBeNull();
        expect(events('dispatch:skipped-dependents')).toEqual([
            expect.objectContaining({ branchName: A, dependents: [B] }),
        ]);
        expect(events('dispatch:halted')).toEqual([]);
        expect(res.transcript.some(t => t.message.includes('skipping 1 dependent branch(es)'))).toBe(true);
    });

    it('dependents: a failed scaffold still blocks everything, and nothing is synced', async () => {
        outcomes[SCAFFOLD] = 'blocked';
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD]);
        expect(sync).not.toHaveBeenCalled();
        expect(events('dispatch:skipped-dependents')).toEqual([
            expect.objectContaining({ branchName: SCAFFOLD, dependents: [A, C, B] }),
        ]);
        expect(res.stopReason).toBeNull();
    });

    it('strict: any failure halts the rest and is reported as halt-policy, not PR creation', async () => {
        config.DISPATCH_HALT_POLICY = 'strict';
        outcomes[A] = 'blocked';
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A]);
        expect(res.stopReason).toBe('halt-policy');
        expect(events('dispatch:halted')).toEqual([expect.objectContaining({ branchName: A, policy: 'strict' })]);
        const last = res.transcript[res.transcript.length - 1].message;
        expect(last).toContain('Dispatch stopped early [halt-policy]');
        expect(last).toContain(`2 branch(es) not dispatched: ${C}, ${B}`);
        expect(last).not.toContain('PR creation failed');
    });

    it('pr-creation-failed stops dispatch with its own reason', async () => {
        outcomes[A] = 'pr-creation-failed';
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A]);
        expect(res.stopReason).toBe('pr-creation-failed');
        expect(events('dispatch:halted')).toEqual([]);
    });

    it('off: a failed scaffold does not stop dispatch; later branches are cut from its tip', async () => {
        config.DISPATCH_HALT_POLICY = 'off';
        outcomes[SCAFFOLD] = 'blocked';
        await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A, C, B]);
        expect(workflow.mock.calls.slice(1).every(([input]) => input.baseBranch === SCAFFOLD)).toBe(true);
        expect(sync).not.toHaveBeenCalled();
    });

    it('a crashed branch workflow counts as a failure for the halt policy', async () => {
        workflow.mockImplementation(async input => {
            if (input.branchName === A) throw new Error('worktree add failed');
            return result(input, 'merged');
        });
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A, C]);
        expect(events('dispatch:skipped-dependents')).toEqual([expect.objectContaining({ branchName: A, dependents: [B] })]);
        expect(res.transcript.some(t => t.message.includes('worktree add failed'))).toBe(true);
    });

    it('deferred (Plan 30-02): the branch is not merged, its dependents wait, and unstarted assignments are reported', async () => {
        workflow.mockImplementation(async input => (input.branchName === A
            ? { ...result(input, 'deferred'), deferredAssignmentIds: ['A2'] }
            : result(input, 'merged')));
        const res = await run([...PLAN, assignment('A2', A)]);

        expect(dispatched()).toEqual([SCAFFOLD, A, C]);
        expect(events('dispatch:skipped-dependents')).toEqual([expect.objectContaining({ branchName: A, dependents: [B] })]);
        expect(res.completedAssignmentIds).not.toContain('A1');
        expect(res.deferredAssignmentIds).toEqual(['A2']);
        expect(res.stopReason).toBeNull();
    });

    it('abandoned (Plan 30-05): neither the branch nor the branches waiting for it are dispatched', async () => {
        const res = await run(PLAN, [A]);

        expect(dispatched()).toEqual([SCAFFOLD, C]);
        expect(events('dispatch:skipped-dependents')).toEqual([expect.objectContaining({ branchName: A, reason: 'is abandoned', dependents: [B] })]);
        expect(res.transcript.some(t => t.message.includes(`Branch "${A}" is abandoned`))).toBe(true);
        expect(res.completedAssignmentIds.sort()).toEqual(['C1', 'S1']);
        expect(res.stopReason).toBeNull();
    });

    it('a fatal provider failure is reported through stopReason alone (Plan 30-05)', async () => {
        workflow.mockImplementation(async input => {
            if (input.branchName === A) throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
            return result(input, 'merged');
        });
        const res = await run(PLAN);

        expect(dispatched()).toEqual([SCAFFOLD, A]);
        expect(res.stopReason).toBe('provider-auth');
        expect(res).not.toHaveProperty('providerFailureKind');
    });

    it('records a failed workspace sync in the transcript instead of claiming success', async () => {
        sync.mockResolvedValue({ ok: false, headSha: '', details: 'fetch failed (exit 128)', strategy: 'failed' });
        const res = await run(PLAN);

        expect(res.transcript.some(t => t.message.includes('FAILED: fetch failed (exit 128)'))).toBe(true);
        expect(dispatched()).toEqual([SCAFFOLD, A, C, B]);
    });
});
