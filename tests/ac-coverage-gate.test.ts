/**
 * Plan 30-03 step 7 — the AC coverage gate reports only real gaps.
 *
 * In the claudeopus5 run it produced 25 bugs per round: "implemented-untested"
 * for criteria the broken runner never measured, and one "PR blocked/conflicted"
 * bug per criterion of the blocked PR.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    MIN_AC_COVERAGE_PCT: 70,
    MIN_AC_IMPLEMENTED_PCT: 90,
    MIN_AC_COVERAGE_MAX_BUGS: 25,
}));

import { evaluateAcCoverageGate } from '../src/conductor/ac-coverage-gate';
import { buildTraceabilityReport } from '../src/utils/traceability';
import { makeState } from './helpers/state-factory';
import type { ExecutedTestReport } from '../src/conductor/test-runners/executed-report';
import type { Assignment, PullRequest, TestReport, UserStory } from '../src/agents/_shared/base-schemas';

const story = (id: string, criteria: number): UserStory => ({
    id, epicId: 'EPIC-1', asA: 'player', iWant: id, soThat: 'fun',
    acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `${id} criterion ${i}`),
});

const assignment = (id: string, storyId: string, branchName: string): Assignment => ({
    id, storyId, additionalStoryIds: [], taskIds: ['TASK-1'], acIndexes: [], devAgentId: 'junior-angular', rank: 'junior',
    priority: 'high', complexity: 'moderate', estimate: '2h', description: id, dependsOn: [], branchName,
    reviewerAgentIds: [], taskType: 'feature', moduleIds: [],
});

const pr = (prNumber: number, branchName: string, assignmentIds: string[], status: PullRequest['status'], blockers?: string[]): PullRequest => ({
    id: prNumber ? `PR-${prNumber}` : `PR-DEFERRED-${branchName}`, prNumber, prUrl: '', title: 't', description: 'd',
    branchName, authorAgentId: 'junior-angular', reviewerAgentIds: [], reviews: [], status, assignmentIds, taskType: 'feature',
    ...(blockers ? { blockers } : {}),
});

/** The runner's report as it reaches traceability (`state.testReports`). */
const executedTestReport = (cases: TestReport['cases']): TestReport => ({
    type: 'unit', framework: 'jest', total: cases.length, passed: cases.length, failed: 0, skipped: 0, status: 'pass',
    source: 'executed', iterationIndex: 0, runnerError: false, failures: [], agentId: 'test-runner', cases,
});

/** The runner's own result (`runTests`), which tells the gate whether coverage was measurable. */
const run = (overrides: Partial<ExecutedTestReport> = {}): ExecutedTestReport => ({
    framework: 'jest', root: '', command: 'npm test', total: 1, passed: 1, failed: 0, skipped: 0, cases: [],
    exitCode: 0, runnerError: false, untracedTests: 0, untracedTestNames: [], ...overrides,
});

const BLOCKERS = ['Quality gates not passed (1 failures)', 'Quorum not met: 0/1 approvals (0 abstention(s))'];

/**
 * US-001: merged, AC#0 has a passing tagged test, AC#1 none (implemented-untested).
 * US-002: PR #2 blocked with recorded blockers. US-003: deferred (planned-only).
 * US-004: PR #4 blocked, two criteria, no recorded blockers.
 */
const trace = buildTraceabilityReport(makeState({
    userStories: [story('US-001', 2), story('US-002', 1), story('US-003', 1), story('US-004', 2)],
    assignments: [
        assignment('ASSIGN-001', 'US-001', 'app/feature/us-001'),
        assignment('ASSIGN-002', 'US-002', 'app/feature/us-002'),
        assignment('ASSIGN-003', 'US-003', 'app/feature/us-003'),
        assignment('ASSIGN-004', 'US-004', 'app/feature/us-004'),
    ],
    pullRequests: [
        pr(1, 'app/feature/us-001', ['ASSIGN-001'], 'merged'),
        pr(2, 'app/feature/us-002', ['ASSIGN-002'], 'blocked', BLOCKERS),
        pr(0, 'app/feature/us-003', [], 'deferred'),
        pr(4, 'app/feature/us-004', ['ASSIGN-004'], 'blocked'),
    ],
    testReports: [executedTestReport([{ testName: '[US-001#0] renders the maze', storyId: 'US-001', acIndex: 0, status: 'pass' }])],
}));

describe('evaluateAcCoverageGate', () => {
    it('produces one bug per blocked PR with its real blockers, and none for planned-only work', () => {
        const gate = evaluateAcCoverageGate(trace, [run()], 1);

        expect(gate.status).toBe('fail');
        expect(gate.testReport).toMatchObject({ framework: 'ac-coverage', source: 'quality-gates', status: 'fail', total: 6, passed: 1, iterationIndex: 1 });
        expect(gate.bugs.map(b => b.id)).toEqual(['PR-BLOCKED-app/feature/us-002', 'PR-BLOCKED-app/feature/us-004', 'AC-US-001-1']);
        expect(gate.bugs[0].actualBehavior).toBe(`Blocked: ${BLOCKERS.join('; ')}`);
        expect(gate.bugs[1].actualBehavior).toBe('Blocked: PR blocked (no blockers recorded)');
        expect(gate.summary).toMatch(/^AC coverage gate FAILED: verified 17%, implemented 33%.* — 3 bug\(s\) for 4 gap\(s\)$/);
    });

    it('is inconclusive, with no bugs, when a test runner failed', () => {
        const gate = evaluateAcCoverageGate(trace, [run(), run({ root: 'web', runnerError: true, total: 0, exitCode: 1 })], 0);

        expect(gate.status).toBe('inconclusive');
        expect(gate.testReport.status).toBe('inconclusive');
        expect(gate.bugs).toEqual([]);
        expect(gate.summary).toContain('a test runner failed');
    });

    it('is inconclusive, with no bugs, when the runner could not name its cases', () => {
        const gate = evaluateAcCoverageGate(trace, [run({ framework: 'karma', total: 134, caseNames: 'unavailable' })], 0);

        expect(gate.status).toBe('inconclusive');
        expect(gate.bugs).toEqual([]);
        expect(gate.summary).toContain('test case names are unavailable');
    });

    it('passes when the criteria are verified', () => {
        const verified = buildTraceabilityReport(makeState({
            userStories: [story('US-001', 1)],
            assignments: [assignment('ASSIGN-001', 'US-001', 'app/feature/us-001')],
            pullRequests: [pr(1, 'app/feature/us-001', ['ASSIGN-001'], 'merged')],
            testReports: [executedTestReport([{ testName: '[US-001#0] renders the maze', storyId: 'US-001', acIndex: 0, status: 'pass' }])],
        }));
        const gate = evaluateAcCoverageGate(verified, [run()], 0);

        expect(gate.status).toBe('pass');
        expect(gate.testReport.status).toBe('pass');
        expect(gate.bugs).toEqual([]);
    });
});
