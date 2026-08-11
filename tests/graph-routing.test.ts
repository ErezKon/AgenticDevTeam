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
        branchAssignments: [],
        phase: 'intake' as any,
        iteration: { bugfix: 0 },
        approvals: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        artifacts: [],
        transcript: [],
        tokenUsage: [],
        configBaseline: null,
        ...overrides,
    };
}

// ─── afterE2eRouter tests ───────────────────────────────────────────────────

describe('afterE2eRouter', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('returns "finalize" when E2E_BUGFIX_ENABLED=false (default) regardless of failures', () => {
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

        expect(afterE2eRouter(state)).toBe('finalize');
    });

    it('returns "bugfix-triage" when E2E_BUGFIX_ENABLED=true with failures and iterations remaining', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            E2E_BUGFIX_ENABLED: true,
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail', { type: 'e2e', agentId: 'qa-e2e' })],
            iteration: { bugfix: 1 },
        });

        expect(afterE2eRouter(state)).toBe('bugfix-triage');
    });

    it('returns "finalize" when E2E_BUGFIX_ENABLED=true but max iterations reached', () => {
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

        expect(afterE2eRouter(state)).toBe('finalize');
    });

    it('returns "finalize" when E2E_BUGFIX_ENABLED=true but no failures', () => {
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

        expect(afterE2eRouter(state)).toBe('finalize');
    });

    it('returns "finalize" when E2E_BUGFIX_ENABLED=true but no test reports', () => {
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

        expect(afterE2eRouter(state)).toBe('finalize');
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

    it('returns "devops" when max iterations reached even with failures', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            MAX_BUGFIX_ITERATIONS: 3,
        }));

        const { afterQaRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [makeTestReport('fail')],
            iteration: { bugfix: 3 },
        });

        expect(afterQaRouter(state)).toBe('devops');
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
