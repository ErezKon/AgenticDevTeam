/**
 * Graph Routing — unit tests for the conductor graph shape and routers.
 *
 * Verifies that the graph contains an `e2e` node reached from `devops`,
 * and that the afterE2eRouter returns the correct next node based on
 * E2E_BUGFIX_ENABLED, test failures, and iteration count.
 */
import type { ProjectStateType } from '../src/conductor/state';

// ─── Test report helper ─────────────────────────────────────────────────────

function makeTestReport(status: 'pass' | 'fail', overrides: Record<string, any> = {}) {
    return {
        type: 'unit' as const,
        framework: 'jest',
        total: status === 'pass' ? 5 : 1,
        passed: status === 'pass' ? 5 : 0,
        failed: status === 'pass' ? 0 : 1,
        skipped: 0,
        status,
        source: 'quality-gates' as const,
        iterationIndex: 0,
        runnerError: false,
        cases: [],
        failures: status === 'fail' ? [{ testName: 'test-1', error: 'assertion failed' }] : [],
        agentId: 'qa-unit',
        ...overrides,
    };
}

// ─── Minimal state fixture ──────────────────────────────────────────────────

function makeMinimalState(overrides: Partial<ProjectStateType> = {}): ProjectStateType {
    return {
        input: {
            systemName: 'test-project',
            requirementsText: 'Build a calculator',
            mode: 'autonomous' as const,
            runType: 'greenfield' as const,
        },
        workspacePath: '/tmp/test-workspace',
        outputPath: '/tmp/test-output',
        systemBranch: 'project/test-project',
        gitContext: { token: 'test', owner: 'test', repo: 'test', defaultBranch: 'main' },
        codebaseAnalysis: null,
        architecture: { style: 'monolith', components: [], dataFlow: '', integrations: [], nonFunctional: [], mermaidDiagram: '' },
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
        phase: 'intake' as any,
        iteration: { bugfix: 0 },
        approvals: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        artifacts: [],
        transcript: [],
        tokenUsage: [],
        acceptance: null,
        latestGateReport: null,
        unrecoverable: null,
        verificationErrors: [],
        dispatchRounds: [],
        attemptedBugIds: [],
        bugAttempts: {},
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

// ─── afterE2eRouter tests ───────────────────────────────────────────────────

describe('afterE2eRouter', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('returns "acceptance" when E2E_BUGFIX_ENABLED=false (default) regardless of failures', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            E2E_BUGFIX_ENABLED: false,
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail', { type: 'e2e', agentId: 'qa-e2e' })],
            iteration: { bugfix: 0 },
        });

        expect(afterE2eRouter(state)).toBe('acceptance-gate');
    });

    it('returns "bugfix-triage" when E2E_BUGFIX_ENABLED=true with failures and iterations remaining', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            E2E_BUGFIX_ENABLED: true,
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail', { type: 'e2e', agentId: 'qa-e2e', source: 'executed', iterationIndex: 1 })],
            iteration: { bugfix: 1 },
        });

        expect(afterE2eRouter(state)).toBe('bugfix-triage');
    });

    it('returns "acceptance" when E2E_BUGFIX_ENABLED=true but max iterations reached', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            E2E_BUGFIX_ENABLED: true,
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail', { type: 'e2e', agentId: 'qa-e2e' })],
            iteration: { bugfix: 3 },
        });

        expect(afterE2eRouter(state)).toBe('acceptance-gate');
    });

    it('returns "acceptance-gate" when E2E_BUGFIX_ENABLED=true but no failures', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            E2E_BUGFIX_ENABLED: true,
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('pass')],
            iteration: { bugfix: 0 },
        });

        expect(afterE2eRouter(state)).toBe('acceptance-gate');
    });

    it('returns "acceptance-gate" when E2E_BUGFIX_ENABLED=true but no test reports', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            E2E_BUGFIX_ENABLED: true,
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [],
            iteration: { bugfix: 0 },
        });

        expect(afterE2eRouter(state)).toBe('acceptance-gate');
    });
});

// ─── afterQaRouter tests ────────────────────────────────────────────────────

describe('afterQaRouter', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('returns "bugfix-triage" when tests fail and iterations remain', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail')],
            iteration: { bugfix: 0 },
        });

        expect(afterQaRouter(state)).toBe('bugfix-triage');
    });

    it('returns "devops" when tests pass', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('pass')],
            iteration: { bugfix: 0 },
        });

        expect(afterQaRouter(state)).toBe('devops');
    });

    it('routes to "acceptance-gate" when max iterations reached with failures and RUN_FAIL_POLICY=halt', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
            RUN_FAIL_POLICY: 'halt',
        }));

        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            // Plan 25, 26-04 §5: iterationIndex must match current bugfix iteration
            testReports: [makeTestReport('fail', { iterationIndex: 3 })],
            iteration: { bugfix: 3 },
        });

        expect(afterQaRouter(state)).toBe('acceptance-gate');
    });

    it('routes to "devops" when max iterations reached with failures and RUN_FAIL_POLICY=finalize', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
            RUN_FAIL_POLICY: 'finalize',
        }));

        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            // Plan 25, 26-04 §5: iterationIndex must match current bugfix iteration
            testReports: [makeTestReport('fail', { iterationIndex: 3 })],
            iteration: { bugfix: 3 },
        });

        expect(afterQaRouter(state)).toBe('devops');
    });

    it('routes to "finalize" when unrecoverable and RUN_FAIL_POLICY=halt', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
            RUN_FAIL_POLICY: 'halt',
        }));

        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail')],
            iteration: { bugfix: 0 },
            unrecoverable: { flag: true, reason: 'test' },
        });

        expect(afterQaRouter(state)).toBe('finalize');
    });
});

// ─── afterIntakeRouter tests ────────────────────────────────────────────────

describe('afterIntakeRouter', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('returns "codebase-analyzer" for maintain mode', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
        }));

        const { afterIntakeRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            input: {
                systemName: 'test',
                requirementsText: 'test',
                mode: 'autonomous' as const,
                runType: 'maintain' as const,
            },
        });

        expect(afterIntakeRouter(state)).toBe('codebase-analyzer');
    });

    it('returns "architect" for greenfield mode', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
        }));

        const { afterIntakeRouter } = require('../src/conductor/graph');
        const state = makeMinimalState();

        expect(afterIntakeRouter(state)).toBe('architect');
    });
});

// ─── afterAcceptanceRouter tests ────────────────────────────────────────────

describe('afterAcceptanceRouter', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('returns "finalize" when acceptance status is "accepted"', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterAcceptanceRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            acceptance: {
                status: 'accepted',
                criteria: [],
                blockers: [],
                unrecoverable: false,
            },
            iteration: { bugfix: 0 },
        });

        expect(afterAcceptanceRouter(state)).toBe('finalize');
    });

    it('returns "bugfix-triage" when acceptance status is "rejected" and iterations remain', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterAcceptanceRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            acceptance: {
                status: 'rejected',
                criteria: [],
                blockers: ['BUILD: build failed'],
                unrecoverable: false,
            },
            iteration: { bugfix: 0 },
        });

        expect(afterAcceptanceRouter(state)).toBe('bugfix-triage');
    });

    it('returns "finalize" when acceptance status is "rejected" but unrecoverable', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterAcceptanceRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            acceptance: {
                status: 'rejected',
                criteria: [],
                blockers: ['BUILD: build failed'],
                unrecoverable: true,
                unrecoverableReason: 'zero progress',
            },
            iteration: { bugfix: 0 },
        });

        expect(afterAcceptanceRouter(state)).toBe('finalize');
    });

    it('returns "finalize" when acceptance status is "rejected" and max iterations reached', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterAcceptanceRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            acceptance: {
                status: 'rejected',
                criteria: [],
                blockers: ['BUILD: build failed'],
                unrecoverable: false,
            },
            iteration: { bugfix: 3 },
        });

        expect(afterAcceptanceRouter(state)).toBe('finalize');
    });
});

// ─── Cancelled state routing (merged from hitl-graph.test.ts) ───────────────

describe('cancelled state routing', () => {
    beforeEach(() => jest.resetModules());

    it('afterQaRouter routes to finalize when cancelled', () => {
        jest.doMock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
            E2E_BUGFIX_ENABLED: false,
        }));
        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({ cancelled: true });
        expect(afterQaRouter(state)).toBe('finalize');
    });

    it('afterE2eRouter routes to finalize when cancelled', () => {
        jest.doMock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
            E2E_BUGFIX_ENABLED: true,
        }));
        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({ cancelled: true });
        expect(afterE2eRouter(state)).toBe('finalize');
    });
});

// ─── Graph compilation (merged from hitl-graph.test.ts) ─────────────────────

describe('buildConductorGraph', () => {
    beforeEach(() => jest.resetModules());

    it('compiles with default options (autonomous)', () => {
        const { buildConductorGraph } = require('../src/conductor/graph');
        const graph = buildConductorGraph({ mode: 'autonomous' });
        expect(graph).toBeDefined();
        expect(typeof graph.invoke).toBe('function');
    });

    it('compiles in human mode with interrupt points', () => {
        const { buildConductorGraph } = require('../src/conductor/graph');
        const graph = buildConductorGraph({ mode: 'human' });
        expect(graph).toBeDefined();
    });
});
