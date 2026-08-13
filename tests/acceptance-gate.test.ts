/**
 * Acceptance Gate — unit tests for evaluateAcceptance, detectUnrecoverable,
 * acceptanceBlockersToBugs, and acceptanceReportToMarkdown.
 *
 * Plan 19 Sub-Plan 03: tests that the acceptance gate correctly determines
 * product status from state evidence.
 *
 * Sub-Plan 10 raised MIN_AC_COVERAGE_PCT default to 70. These tests focus on
 * the other criteria, so we disable AC coverage here. The ac-coverage criterion
 * is exercised in traceability.test.ts and inline below.
 */

// Must be set before config.ts is loaded (top-level const).
process.env.MIN_AC_COVERAGE_PCT = '0';

import {
    evaluateAcceptance,
    detectUnrecoverable,
    acceptanceBlockersToBugs,
    acceptanceReportToMarkdown,
} from '../src/conductor/acceptance-gate';
import type { ProjectStateType } from '../src/conductor/state';
import type { GateReport } from '../src/conductor/quality-gates';

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
        phase: 'acceptance' as any,
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
        ...overrides,
    };
}

function makeGateResult(step: string, passed: boolean, output = 'ok'): any {
    return { relDir: '.', step, mode: 'real', command: `npm run ${step}`, skipped: false, passed, output, durationMs: 1000, inconclusive: false };
}

function makeGateReport(overrides: Partial<GateReport> = {}): GateReport {
    return {
        passed: true,
        inconclusive: false,
        stacks: ['node'],
        roots: [{ dir: '.', relDir: '.', stack: 'node' as const, isWorkspaceMember: true }],
        results: [
            makeGateResult('build', true),
            makeGateResult('test', true, '5 passed'),
        ],
        productVerify: {
            artifacts: [{ root: '.', expectedDirs: ['dist'], foundDir: 'dist', fileCount: 10, totalBytes: 50000, hasEntryHtml: true, hasEntryJs: true, passed: true, reason: 'ok' }],
            resolveIssues: [],
            smoke: { ran: true, url: 'http://localhost:3000', httpStatus: 200, bodyBytes: 500, rendered: true, consoleErrors: [], passed: true, reason: 'ok' },
            passed: true,
            summary: 'All checks passed',
        },
        ...overrides,
    };
}

// ─── evaluateAcceptance tests ───────────────────────────────────────────────

describe('evaluateAcceptance', () => {
    it('returns "accepted" when all criteria pass', () => {
        const state = makeMinimalState({
            latestGateReport: makeGateReport(),
            testReports: [{ type: 'unit', framework: 'jest', total: 5, passed: 5, failed: 0, skipped: 0, status: 'pass' as const, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa-unit' }],
            userStories: [{ id: 'US-1', epicId: 'E-1', asA: 'user', iWant: 'calc', soThat: 'math', acceptanceCriteria: ['AC-1'] }],
            assignments: [{ id: 'A-1', storyId: 'US-1', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [], devAgentId: 'dev-1', rank: 'senior' as const, priority: 'high' as const, complexity: 'moderate' as const, estimate: '2h', description: 'impl', dependsOn: [], taskType: 'feature' as const, moduleIds: [] }],
            pullRequests: [{ id: 'PR-1', prNumber: 1, prUrl: '', title: '', description: '', branchName: 'feature/us1', authorAgentId: 'dev-1', reviewerAgentIds: [], reviews: [], status: 'merged' as any, assignmentIds: ['A-1'], taskType: 'feature' as any }],
            branchAssignments: [{ branchName: 'feature/us1', assignmentIds: ['A-1'], agentIds: ['dev-1'], isShared: false }],
        });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('accepted');
        // Optional inconclusive criteria (E2E, DEPLOY) are not blockers for 'accepted'
        expect(report.criteria.filter(c => c.required && !c.passed).length).toBe(0);
        expect(report.unrecoverable).toBe(false);
    });

    it('returns "rejected" when build fails', () => {
        const state = makeMinimalState({
            latestGateReport: makeGateReport({
                passed: false,
                results: [
                    makeGateResult('build', false, 'Error: Cannot find module'),
                    makeGateResult('test', true, '5 passed'),
                ],
            }),
            testReports: [{ type: 'unit', framework: 'jest', total: 5, passed: 5, failed: 0, skipped: 0, status: 'pass' as const, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa-unit' }],
        });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('rejected');
        expect(report.blockers.length).toBeGreaterThan(0);
        expect(report.blockers.some(b => b.includes('BUILD'))).toBe(true);
    });

    it('returns "rejected" when tests fail', () => {
        const state = makeMinimalState({
            latestGateReport: makeGateReport({
                passed: false,
                results: [
                    makeGateResult('build', true),
                    makeGateResult('test', false, '3 failed'),
                ],
            }),
            testReports: [{ type: 'unit', framework: 'jest', total: 5, passed: 2, failed: 3, skipped: 0, status: 'fail' as const, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [{ testName: 'test-1', error: 'assertion failed' }], agentId: 'qa-unit' }],
        });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('rejected');
        expect(report.blockers.some(b => b.includes('TESTS'))).toBe(true);
    });

    it('returns "inconclusive" when no gate report available', () => {
        const state = makeMinimalState({
            latestGateReport: null,
        });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('inconclusive');
    });

    it('returns "rejected" when unresolved references exist', () => {
        const state = makeMinimalState({
            latestGateReport: makeGateReport({
                productVerify: {
                    artifacts: [{ root: '.', expectedDirs: ['dist'], foundDir: 'dist', fileCount: 10, totalBytes: 50000, hasEntryHtml: true, hasEntryJs: true, passed: true, reason: 'ok' }],
                    resolveIssues: [{ file: 'src/App.tsx', line: 5, specifier: './Missing', kind: 'import' as const, reason: 'missing-file' as const }],
                    smoke: null,
                    passed: false,
                    summary: '1 unresolved reference',
                },
            }),
            testReports: [{ type: 'unit', framework: 'jest', total: 5, passed: 5, failed: 0, skipped: 0, status: 'pass' as const, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa-unit' }],
        });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('rejected');
        expect(report.blockers.some(b => b.includes('RESOLVE'))).toBe(true);
    });

    it('marks criteria inconclusive when verification errors exist', () => {
        const state = makeMinimalState({
            latestGateReport: null,
            verificationErrors: [{ stage: 'quality-gates', message: 'process crashed' }],
        });

        const report = evaluateAcceptance(state);
        const buildCriterion = report.criteria.find(c => c.id === 'BUILD');
        expect(buildCriterion?.inconclusive).toBe(true);
    });

    it('detects tamper findings as integrity failures', () => {
        const state = makeMinimalState({
            latestGateReport: makeGateReport(),
            testReports: [{ type: 'unit', framework: 'jest', total: 5, passed: 5, failed: 0, skipped: 0, status: 'pass' as const, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa-unit' }],
            bugs: [
                { id: 'TAMPER-jest-config', title: 'Tampered jest config', severity: 'critical', stepsToReproduce: '', expectedBehavior: '', actualBehavior: '', suspectedArea: '', reportedBy: 'gate-integrity' },
            ] as any,
        });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('rejected');
        expect(report.blockers.some(b => b.includes('INTEGRITY'))).toBe(true);
    });

    it('optional criteria failing yields "partial" status', () => {
        const state = makeMinimalState({
            latestGateReport: makeGateReport(),
            testReports: [{ type: 'unit', framework: 'jest', total: 5, passed: 5, failed: 0, skipped: 0, status: 'pass' as const, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa-unit' }],
            // E2E failures (optional criterion) — Sub-Plan 11: e2eStatus drives the criterion
            e2eStatus: 'failed' as const,
            userStories: [{ id: 'US-1', epicId: 'E-1', asA: 'user', iWant: 'calc', soThat: 'math', acceptanceCriteria: ['AC-1'] }],
            assignments: [{ id: 'A-1', storyId: 'US-1', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [], devAgentId: 'dev-1', rank: 'senior' as const, priority: 'high' as const, complexity: 'moderate' as const, estimate: '2h', description: 'impl', dependsOn: [], taskType: 'feature' as const, moduleIds: [] }],
            pullRequests: [{ id: 'PR-1', prNumber: 1, prUrl: '', title: '', description: '', branchName: 'feature/us1', authorAgentId: 'dev-1', reviewerAgentIds: [], reviews: [], status: 'merged' as any, assignmentIds: ['A-1'], taskType: 'feature' as any }],
            branchAssignments: [{ branchName: 'feature/us1', assignmentIds: ['A-1'], agentIds: ['dev-1'], isShared: false }],
        });

        // Manually add failing E2E reports
        state.testReports.push({ type: 'e2e' as any, framework: 'playwright', total: 3, passed: 1, failed: 2, skipped: 0, status: 'fail' as any, source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [{ testName: 'e2e-1', error: 'timeout' }], agentId: 'qa-e2e' });

        const report = evaluateAcceptance(state);
        expect(report.status).toBe('partial');
    });
});

// ─── detectUnrecoverable tests ──────────────────────────────────────────────

describe('detectUnrecoverable', () => {
    it('returns false for a normal state', () => {
        const state = makeMinimalState({ phase: 'intake' as any });
        const { unrecoverable } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(false);
    });

    it('detects zero-progress dispatch rounds', () => {
        const state = makeMinimalState({
            phase: 'intake' as any,
            dispatchRounds: [
                { fileChanges: 0, prs: 0, completed: 0 },
                { fileChanges: 0, prs: 0, completed: 0 },
            ],
        });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('consecutive dispatch rounds');
    });

    it('does not trigger on a single zero-progress round', () => {
        const state = makeMinimalState({
            phase: 'intake' as any,
            dispatchRounds: [
                { fileChanges: 0, prs: 0, completed: 0 },
            ],
        });
        const { unrecoverable } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(false);
    });

    it('detects sourceless workspace after development', () => {
        const state = makeMinimalState({
            phase: 'qa' as any,
            fileChanges: [],
            pullRequests: [],
        });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('sourceless');
    });

    it('detects repeated acceptance bug failures', () => {
        // Provide fileChanges to avoid the "sourceless" heuristic kicking in first
        const state = makeMinimalState({
            phase: 'qa' as any,
            fileChanges: [{ path: 'src/app.ts', action: 'modified' as const, summary: 'mod', storyId: 'US-1', agentId: 'dev-1' }],
            pullRequests: [{ id: 'PR-1', prNumber: 1, prUrl: '', title: '', description: '', branchName: 'feature/x', authorAgentId: 'dev-1', reviewerAgentIds: [], reviews: [], status: 'merged' as any, assignmentIds: ['A-1'], taskType: 'feature' as any }],
            bugAttempts: {
                'ACCEPT-BUILD': 2,
                'ACCEPT-TESTS': 2,
                'ACCEPT-RESOLVE': 2,
            },
            fixedBugIds: [],
        });
        const { unrecoverable, reason } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(true);
        expect(reason).toContain('acceptance/gate bugs');
    });

    it('does not trigger when attempted bugs are fixed', () => {
        const state = makeMinimalState({
            phase: 'qa' as any,
            fileChanges: [{ path: 'src/app.ts', action: 'modified' as const, summary: 'mod', storyId: 'US-1', agentId: 'dev-1' }],
            pullRequests: [{ id: 'PR-1', prNumber: 1, prUrl: '', title: '', description: '', branchName: 'feature/x', authorAgentId: 'dev-1', reviewerAgentIds: [], reviews: [], status: 'merged' as any, assignmentIds: ['A-1'], taskType: 'feature' as any }],
            bugAttempts: {
                'ACCEPT-BUILD': 2,
                'ACCEPT-TESTS': 2,
                'ACCEPT-RESOLVE': 2,
            },
            fixedBugIds: ['ACCEPT-BUILD', 'ACCEPT-TESTS', 'ACCEPT-RESOLVE'],
        });
        const { unrecoverable } = detectUnrecoverable(state);
        expect(unrecoverable).toBe(false);
    });
});

// ─── acceptanceBlockersToBugs tests ─────────────────────────────────────────

describe('acceptanceBlockersToBugs', () => {
    it('converts failed required criteria to bugs', () => {
        const report = {
            status: 'rejected' as const,
            criteria: [
                { id: 'BUILD', label: 'Build passes', required: true, passed: false, inconclusive: false, detail: 'build failed' },
                { id: 'TESTS', label: 'Tests pass', required: true, passed: true, inconclusive: false, detail: 'ok' },
            ],
            blockers: ['BUILD: build failed'],
            unrecoverable: false,
        };

        const bugs = acceptanceBlockersToBugs(report);
        expect(bugs).toHaveLength(1);
        expect(bugs[0].id).toBe('ACCEPT-BUILD');
        expect(bugs[0].severity).toBe('critical');
    });

    it('skips inconclusive criteria', () => {
        const report = {
            status: 'inconclusive' as const,
            criteria: [
                { id: 'BUILD', label: 'Build passes', required: true, passed: false, inconclusive: true, detail: 'verification crashed' },
            ],
            blockers: ['BUILD (inconclusive): verification crashed'],
            unrecoverable: false,
        };

        const bugs = acceptanceBlockersToBugs(report);
        expect(bugs).toHaveLength(0);
    });

    it('skips optional criteria', () => {
        const report = {
            status: 'partial' as const,
            criteria: [
                { id: 'E2E', label: 'E2E tests', required: false, passed: false, inconclusive: false, detail: '2 failed' },
            ],
            blockers: ['E2E: 2 failed'],
            unrecoverable: false,
        };

        const bugs = acceptanceBlockersToBugs(report);
        expect(bugs).toHaveLength(0);
    });
});

// ─── acceptanceReportToMarkdown tests ───────────────────────────────────────

describe('acceptanceReportToMarkdown', () => {
    it('generates valid markdown', () => {
        const report = {
            status: 'rejected' as const,
            criteria: [
                { id: 'BUILD', label: 'Build passes', required: true, passed: false, inconclusive: false, detail: 'build failed' },
                { id: 'TESTS', label: 'Tests pass', required: true, passed: true, inconclusive: false, detail: '5 passed' },
            ],
            blockers: ['BUILD: build failed'],
            unrecoverable: false,
        };

        const md = acceptanceReportToMarkdown(report);
        expect(md).toContain('# Acceptance Report');
        expect(md).toContain('REJECTED');
        expect(md).toContain('BUILD');
        expect(md).toContain('## Blockers');
    });

    it('includes unrecoverable reason when present', () => {
        const report = {
            status: 'rejected' as const,
            criteria: [],
            blockers: [],
            unrecoverable: true,
            unrecoverableReason: 'zero progress',
        };

        const md = acceptanceReportToMarkdown(report);
        expect(md).toContain('Unrecoverable');
        expect(md).toContain('zero progress');
    });
});
