/**
 * Tests for run-invariants.ts — Sub-Plan 12.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    RUN_INVARIANTS_MODE: 'warn',
    RUN_LEDGER_ENABLED: false,
    EVENT_BUFFER_SIZE: 100,
    EVENT_PRIORITY_BUFFER_SIZE: 50,
}));

jest.mock('../src/utils/run-ledger', () => ({
    appendLedger: jest.fn(),
}));

import { checkInvariants, getInvariantIds } from '../src/conductor/run-invariants';
import type { ProjectStateType } from '../src/conductor/state';

function makeMinimalState(overrides: Partial<ProjectStateType> = {}): ProjectStateType {
    return {
        input: { systemName: 'test-project', requirementsText: 'Build a calculator', mode: 'autonomous' as const, runType: 'greenfield' as const },
        workspacePath: '/tmp/test-workspace',
        outputPath: '/tmp/test-output',
        systemBranch: 'project/test-project',
        gitContext: null,
        codebaseAnalysis: null,
        architecture: null,
        epics: [],
        techStack: [],
        dbDesign: null,
        userStories: [],
        tasks: [],
        assignments: [],
        completedAssignmentIds: [],
        fileChanges: [],
        testPlan: null,
        testReports: [],
        bugs: [],
        fixedBugIds: [],
        devopsPlan: null,
        runningContainers: [],
        pullRequests: [],
        branchAssignments: [],
        phase: 'finalize' as any,
        iteration: { bugfix: 0 },
        approvals: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        artifacts: [],
        transcript: [],
        tokenUsage: [],
        configBaseline: null,
        acceptance: null,
        latestGateReport: null,
        unrecoverable: null,
        verificationErrors: [],
        dispatchRounds: [],
        attemptedBugIds: [],
        bugAttempts: {},
        outputIntegrity: [],
        planViolations: [],
        repoContract: null,
        completionEvidence: [],
        salvageBranches: [],
        phantomFileChanges: [],
        qaClaimDiscrepancies: [],
        e2eStatus: 'not-run' as const,
        e2eSkipReason: null,
        e2eEvidence: null,
        invariantViolations: [],
        _isContinuation: false,
        _resumePhase: null,
        _stopReason: null,
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('getInvariantIds', () => {
    it('returns all 10 invariant IDs', () => {
        const ids = getInvariantIds();
        expect(ids).toContain('INV-PLAN-COVERAGE');
        expect(ids).toContain('INV-NO-EMPTY-ASSIGNMENTS');
        expect(ids).toContain('INV-WORKSPACE-HAS-SOURCE');
        expect(ids).toContain('INV-NO-PHANTOMS');
        expect(ids).toContain('INV-TESTREPORT-EXISTS');
        expect(ids).toContain('INV-GATE-RAN');
        expect(ids).toContain('INV-NO-CRITICAL-INTEGRITY');
        expect(ids).toContain('INV-E2E-STATUS-SET');
        expect(ids).toContain('INV-STATUS-MATCHES-ACCEPTANCE');
        expect(ids).toContain('INV-NO-MERGED-EMPTY-PR');
        expect(ids.length).toBe(10);
    });
});

describe('checkInvariants', () => {
    it('returns empty for a clean state after team-leader', () => {
        const state = makeMinimalState({
            userStories: [{ id: 'US-001', title: 'Story 1', description: '', epicId: 'EPIC-001', acceptanceCriteria: ['AC1'] }] as any[],
            assignments: [{ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'feature/us-001', description: '', taskType: 'feature', agentId: 'senior-frontend', taskIds: ['TASK-001'], additionalStoryIds: [], acIndexes: [0], moduleIds: [] }] as any[],
        });
        const violations = checkInvariants(state, 'team-leader');
        expect(violations).toHaveLength(0);
    });

    it('detects orphaned stories after team-leader (INV-PLAN-COVERAGE)', () => {
        const state = makeMinimalState({
            userStories: [
                { id: 'US-001', title: 'Story 1', description: '', epicId: 'E1', acceptanceCriteria: ['AC1'] },
                { id: 'US-002', title: 'Story 2', description: '', epicId: 'E1', acceptanceCriteria: ['AC1'] },
                { id: 'US-003', title: 'Story 3', description: '', epicId: 'E1', acceptanceCriteria: ['AC1'] },
            ] as any[],
            assignments: [{ id: 'ASSIGN-001', storyId: 'US-001', branchName: 'f/1', description: '', taskType: 'feature', agentId: 'sr', taskIds: ['T1'], additionalStoryIds: [], acIndexes: [0], moduleIds: [] }] as any[],
        });
        const violations = checkInvariants(state, 'team-leader');
        expect(violations.length).toBeGreaterThanOrEqual(1);
        const planCov = violations.find(v => v.id === 'INV-PLAN-COVERAGE');
        expect(planCov).toBeDefined();
        expect(planCov!.detail).toContain('2 stories have no assignment');
    });

    it('detects empty assignments after team-leader (INV-NO-EMPTY-ASSIGNMENTS)', () => {
        const state = makeMinimalState({
            userStories: [{ id: 'US-001', title: 'Story 1', description: '', epicId: 'E1', acceptanceCriteria: ['AC1'] }] as any[],
            assignments: [],
        });
        const violations = checkInvariants(state, 'team-leader');
        const emptyAssign = violations.find(v => v.id === 'INV-NO-EMPTY-ASSIGNMENTS');
        expect(emptyAssign).toBeDefined();
    });

    it('detects phantom file changes after development (INV-NO-PHANTOMS)', () => {
        const state = makeMinimalState({
            phantomFileChanges: [{ path: 'src/App.tsx', action: 'created', summary: 'phantom' }] as any[],
        });
        const violations = checkInvariants(state, 'development');
        const phantoms = violations.find(v => v.id === 'INV-NO-PHANTOMS');
        expect(phantoms).toBeDefined();
        expect(phantoms!.detail).toContain('1 phantom file change(s)');
    });

    it('detects missing test reports after qa (INV-TESTREPORT-EXISTS)', () => {
        const state = makeMinimalState({
            testReports: [{ type: 'unit', framework: 'jest', total: 0, passed: 0, failed: 0, skipped: 0, status: 'pass', source: 'claimed', iterationIndex: 0, runnerError: false, failures: [], agentId: 'qa', cases: [] }] as any[],
        });
        const violations = checkInvariants(state, 'qa');
        const noTests = violations.find(v => v.id === 'INV-TESTREPORT-EXISTS');
        expect(noTests).toBeDefined();
    });

    it('detects e2eStatus not-run after e2e (INV-E2E-STATUS-SET)', () => {
        const state = makeMinimalState({ e2eStatus: 'not-run' });
        const violations = checkInvariants(state, 'e2e');
        const e2e = violations.find(v => v.id === 'INV-E2E-STATUS-SET');
        expect(e2e).toBeDefined();
    });

    it('returns empty for phases with no relevant invariants', () => {
        const state = makeMinimalState();
        const violations = checkInvariants(state, 'architect');
        expect(violations).toHaveLength(0);
    });

    it('detects no gate report after qa (INV-GATE-RAN)', () => {
        const state = makeMinimalState({ latestGateReport: null });
        const violations = checkInvariants(state, 'qa');
        const gateRan = violations.find(v => v.id === 'INV-GATE-RAN');
        expect(gateRan).toBeDefined();
    });
});
