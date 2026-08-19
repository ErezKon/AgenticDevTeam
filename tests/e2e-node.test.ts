/**
 * E2E Node — unit tests for e2eStatus handling.
 * Sub-Plan 11 Work Item 3.
 */

// Disable AC coverage for these tests
process.env.MIN_AC_COVERAGE_PCT = '0';

import {
    evaluateAcceptance,
} from '../src/conductor/acceptance-gate';
import type { ProjectStateType } from '../src/conductor/state';
import type { GateReport } from '../src/conductor/quality-gates';

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

function makeMinimalState(overrides: Partial<ProjectStateType> = {}): ProjectStateType {
    return {
        input: { systemName: 'test', requirementsText: 'Build test', mode: 'autonomous' as const, runType: 'greenfield' as const },
        workspacePath: '/tmp/test', outputPath: '/tmp/out', systemBranch: 'project/test',
        gitContext: null, codebaseAnalysis: null,
        architecture: { style: 'monolith', components: [], dataFlow: '', integrations: [], nonFunctional: [], mermaidDiagram: '' },
        epics: [], techStack: [], dbDesign: null, userStories: [], tasks: [],
        assignments: [], completedAssignmentIds: [], fileChanges: [],
        testPlan: null, testReports: [], bugs: [], fixedBugIds: [],
        devopsPlan: null, runningContainers: [],
        pullRequests: [],
        phase: 'e2e' as any, iteration: { bugfix: 0 },
        approvals: [], pendingRerun: null, phaseFeedback: {}, cancelled: false,
        artifacts: [], transcript: [], tokenUsage: [],
        acceptance: null, latestGateReport: null,
        unrecoverable: null, verificationErrors: [], dispatchRounds: [],
        attemptedBugIds: [], bugAttempts: {},
        planViolations: [],
        repoContract: null, completionEvidence: [], salvageBranches: [],
        phantomFileChanges: [], qaClaimDiscrepancies: [],
        e2eStatus: 'not-run' as const, e2eSkipReason: null, e2eEvidence: null,
        invariantViolations: [],
        _isContinuation: false,
        _resumePhase: null,
        _stopReason: null,
        ...overrides,
    };
}

function makePassingGateReport(): GateReport {
    return {
        passed: true, inconclusive: false,
        roots: [{ dir: '/tmp/test', relDir: '', stack: 'node', isWorkspaceMember: false }],
        results: [
            { relDir: '.', step: 'build', mode: 'real' as any, command: 'npm run build', skipped: false, passed: true, output: 'ok', durationMs: 1000, inconclusive: false },
            { relDir: '.', step: 'test', mode: 'real' as any, command: 'npm test', skipped: false, passed: true, output: 'ok', durationMs: 1000, inconclusive: false },
        ],
    } as any;
}

describe('E2E acceptance criterion via e2eStatus', () => {
    it('no services, no web root => E2E passes (not applicable)', () => {
        const state = makeMinimalState({
            e2eStatus: 'skipped-no-services',
            latestGateReport: { ...makePassingGateReport(), roots: [] },
        });
        const report = evaluateAcceptance(state);
        const e2eCrit = report.criteria.find(c => c.id === 'E2E');
        expect(e2eCrit?.passed).toBe(true);
    });

    it('no services BUT web root exists => E2E fails', () => {
        const state = makeMinimalState({
            e2eStatus: 'skipped-no-services',
            latestGateReport: makePassingGateReport(),
        });
        const report = evaluateAcceptance(state);
        const e2eCrit = report.criteria.find(c => c.id === 'E2E');
        expect(e2eCrit?.passed).toBe(false);
    });

    it('MCP throws Connection closed => e2eStatus error, E2E-INFRA-FAILED bug, stderr captured', () => {
        const state = makeMinimalState({
            e2eStatus: 'error',
            e2eSkipReason: 'Failed to connect to stdio server "playwright": McpError: MCP error -32000: Connection closed',
        });
        const report = evaluateAcceptance(state);
        const e2eCrit = report.criteria.find(c => c.id === 'E2E');
        expect(e2eCrit?.inconclusive).toBe(true);
        expect(e2eCrit?.passed).toBe(false);
    });

    it('e2eStatus passed => E2E criterion passes', () => {
        const state = makeMinimalState({
            e2eStatus: 'passed',
            testReports: [{ type: 'e2e', source: 'executed', status: 'pass', framework: 'playwright', agentId: 'qa-e2e', total: 5, passed: 5, failed: 0, skipped: 0, failures: [], cases: [], iterationIndex: 0, runnerError: false }] as any[],
        });
        const report = evaluateAcceptance(state);
        const e2eCrit = report.criteria.find(c => c.id === 'E2E');
        expect(e2eCrit?.passed).toBe(true);
    });

    it('e2eStatus failed => E2E criterion fails', () => {
        const state = makeMinimalState({
            e2eStatus: 'failed',
            testReports: [{ type: 'e2e', source: 'executed', status: 'fail', framework: 'playwright', agentId: 'qa-e2e', total: 5, passed: 2, failed: 3, skipped: 0, failures: [], cases: [], iterationIndex: 0, runnerError: false }] as any[],
        });
        const report = evaluateAcceptance(state);
        const e2eCrit = report.criteria.find(c => c.id === 'E2E');
        expect(e2eCrit?.passed).toBe(false);
    });

    it('afterE2eRouter with failing unit report and passing e2e => does NOT route to bugfix', () => {
        // This test verifies afterE2eRouter doesn't misfire on unit test failures
        const { afterE2eRouter } = require('../src/conductor/graph');
        const state = makeMinimalState({
            testReports: [
                { type: 'unit', source: 'executed', status: 'fail', framework: 'jest', agentId: 'qa-unit', total: 10, passed: 8, failed: 2, skipped: 0, failures: [], cases: [], iterationIndex: 0, runnerError: false },
                { type: 'e2e', source: 'executed', status: 'pass', framework: 'playwright', agentId: 'qa-e2e', total: 5, passed: 5, failed: 0, skipped: 0, failures: [], cases: [], iterationIndex: 0, runnerError: false },
            ] as any[],
        });
        const route = afterE2eRouter(state);
        expect(route).toBe('acceptance-gate');
    });
});
