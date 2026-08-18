/**
 * Requirements Traceability — Unit Tests
 *
 * Exercises: buildTraceabilityReport, renderTraceabilityMarkdown (pure, fixture state).
 *
 * Sub-Plan 10: extended with 6-state AcStatus, CoverageTotals (verifiedPct/implementedPct/
 * deliveryScore), executed-only coverage, hasMerged fix, no-mutation regression,
 * orphanedTasks, unassignedTasks, acIndexes coverage, blockedDeliveries.
 */
import {
    buildTraceabilityReport,
    renderTraceabilityMarkdown,
    type TraceabilityReport,
} from '../src/utils/traceability';
import type { ProjectStateType } from '../src/conductor/state';
import type {
    Epic, UserStory, Task, Assignment, PullRequest, TestPlan, TestReport,
} from '../src/agents/_shared/base-schemas';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEpic(id: string, title: string = `Epic ${id}`): Epic {
    return { id, title, description: `Description of ${id}`, components: [] };
}

function makeStory(id: string, epicId: string, ac: string[]): UserStory {
    return {
        id, epicId,
        asA: 'user', iWant: 'something', soThat: 'value',
        acceptanceCriteria: ac,
    };
}

function makeTask(id: string, storyId: string): Task {
    return {
        id, storyId, title: `Task ${id}`,
        description: 'Do work', layer: 'backend', suggestedTech: 'node',
        moduleIds: [],
    };
}

function makeAssignment(id: string, storyId: string, branchName?: string, overrides: Partial<Assignment> = {}): Assignment {
    return {
        id, storyId,
        additionalStoryIds: [],
        taskIds: ['TASK-001'],
        acIndexes: [],
        devAgentId: 'junior-react', rank: 'junior',
        priority: 'medium', complexity: 'moderate',
        estimate: '2h', description: 'Build it',
        dependsOn: [], taskType: 'feature',
        moduleIds: [],
        ...(branchName ? { branchName } : {}),
        ...overrides,
    };
}

function makePR(id: string, prNumber: number, branchName: string, assignmentIds: string[], status: 'open' | 'approved' | 'merged' | 'closed' | 'blocked' | 'escalated_open'): PullRequest {
    return {
        id, prNumber, prUrl: `https://github.com/test/repo/pull/${prNumber}`,
        title: `PR ${id}`, description: 'Changes',
        branchName, authorAgentId: 'junior-react',
        reviewerAgentIds: ['senior-review'],
        reviews: [], status,
        assignmentIds, taskType: 'feature',
    };
}

function makeTestPlan(items: { target: string; storyId?: string; acIndex?: number }[]): TestPlan {
    return {
        scope: 'Full test coverage',
        unit: items.map(i => ({
            target: i.target, description: `Test ${i.target}`,
            framework: 'jest',
            storyId: i.storyId ?? '',
            acIndex: i.acIndex ?? -1,
        })),
        integration: [],
        e2e: [],
        coverageTargets: { unit: 80, integration: 60, e2e: 100 },
    };
}

function makeTestReport(
    cases: { testName: string; storyId?: string; acIndex?: number; status: 'pass' | 'fail' | 'skip' }[],
    overallStatus: 'pass' | 'fail' = 'pass',
    source: 'executed' | 'claimed' | 'quality-gates' = 'executed',
): TestReport {
    return {
        type: 'unit', framework: 'jest',
        total: cases.length, passed: cases.filter(c => c.status === 'pass').length,
        failed: cases.filter(c => c.status === 'fail').length,
        skipped: cases.filter(c => c.status === 'skip').length,
        status: overallStatus,
        source,
        iterationIndex: 0,
        runnerError: false,
        failures: cases.filter(c => c.status === 'fail').map(c => ({
            testName: c.testName, error: 'assertion failed',
        })),
        agentId: 'qa-unit',
        cases: cases.map(c => ({
            testName: c.testName,
            status: c.status,
            storyId: c.storyId ?? '',
            acIndex: c.acIndex ?? -1,
        })),
    };
}

function makeMinimalState(overrides: Partial<ProjectStateType>): ProjectStateType {
    return {
        input: { systemName: 'test', requirementsText: '', mode: 'autonomous' as const, runType: 'greenfield' as const },
        workspacePath: '/tmp/test',
        outputPath: '/tmp/test/output',
        systemBranch: 'project/test',
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
        phase: 'finalize' as any,
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
        ...overrides,
    } as ProjectStateType;
}

// ─── buildTraceabilityReport ─────────────────────────────────────────────────

describe('buildTraceabilityReport', () => {
    it('correctly traces 2 epics, 3 stories (2 AC each), partial coverage', () => {
        const state = makeMinimalState({
            epics: [makeEpic('EPIC-001'), makeEpic('EPIC-002')],
            userStories: [
                makeStory('US-001', 'EPIC-001', ['User can log in', 'User sees dashboard']),
                makeStory('US-002', 'EPIC-001', ['User can create item', 'User can delete item']),
                makeStory('US-003', 'EPIC-002', ['Admin can manage users', 'Admin sees reports']),
            ],
            tasks: [
                makeTask('TASK-001', 'US-001'),
                makeTask('TASK-002', 'US-002'),
            ],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001', 'feat/login'),
                makeAssignment('ASSIGN-002', 'US-002', 'feat/items'),
            ],
            pullRequests: [
                makePR('PR-001', 101, 'feat/login', ['ASSIGN-001'], 'merged'),
                makePR('PR-002', 102, 'feat/items', ['ASSIGN-002'], 'open'),
            ],
            testPlan: makeTestPlan([
                { target: 'login', storyId: 'US-001', acIndex: 0 },
            ]),
            testReports: [
                makeTestReport([
                    { testName: 'login works', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ], 'pass', 'executed'),
            ],
        });

        const report = buildTraceabilityReport(state);

        // US-001/0: verified (merged PR + passing executed test)
        const us001_0 = report.rows.find(r => r.storyId === 'US-001' && r.acIndex === 0);
        expect(us001_0?.status).toBe('verified');
        expect(us001_0?.testStatus).toBe('pass');

        // US-001/1: implemented-untested (merged PR, no test)
        const us001_1 = report.rows.find(r => r.storyId === 'US-001' && r.acIndex === 1);
        expect(us001_1?.status).toBe('implemented-untested');

        // US-002/*: blocked (open PR, not merged)
        const us002_0 = report.rows.find(r => r.storyId === 'US-002' && r.acIndex === 0);
        expect(us002_0?.status).toBe('blocked');

        // US-003/*: missing (no assignment)
        const us003_0 = report.rows.find(r => r.storyId === 'US-003' && r.acIndex === 0);
        expect(us003_0?.status).toBe('missing');

        // Orphaned stories
        expect(report.orphanedStories).toEqual(['US-003']);

        // Totals — graded model
        expect(report.totals.criteria).toBe(6);
        expect(report.totals.verified).toBe(1);
        expect(report.totals.verifiedPct).toBeCloseTo(1 / 6, 5);
        expect(report.totals.implementedPct).toBeCloseTo(2 / 6, 5); // verified + implemented
        expect(report.totals.deliveryScore).toBeCloseTo((1 * 1.0 + 1 * 0.5) / 6, 5);
    });

    it('detects orphaned assignments whose storyId matches no user story', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['Criterion A']),
            ],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001'),
                makeAssignment('ASSIGN-999', 'US-999'),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.orphanedAssignments).toEqual(['ASSIGN-999']);
    });

    it('acIndex -1 marks every criterion of that story as covered', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['Criterion A', 'Criterion B', 'Criterion C']),
            ],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001'),
            ],
            pullRequests: [
                makePR('PR-001', 101, 'feat/all', ['ASSIGN-001'], 'merged'),
            ],
            testReports: [
                makeTestReport([
                    { testName: 'full story test', storyId: 'US-001', acIndex: -1, status: 'pass' },
                ], 'pass', 'executed'),
            ],
        });

        const report = buildTraceabilityReport(state);

        expect(report.rows).toHaveLength(3);
        for (const row of report.rows) {
            expect(row.status).toBe('verified');
            expect(row.testStatus).toBe('pass');
            expect(row.testNames).toContain('full story test');
        }
        expect(report.totals.verified).toBe(3);
        expect(report.totals.verifiedPct).toBe(1);
    });

    it('handles empty state gracefully', () => {
        const state = makeMinimalState({});
        const report = buildTraceabilityReport(state);

        expect(report.rows).toHaveLength(0);
        expect(report.totals.criteria).toBe(0);
        expect(report.totals.verifiedPct).toBe(0);
        expect(report.orphanedStories).toEqual([]);
        expect(report.orphanedAssignments).toEqual([]);
    });

    it('marks all stories as orphaned when no assignments exist', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['AC-A']),
                makeStory('US-002', 'EPIC-001', ['AC-B']),
            ],
            assignments: [],
        });

        const report = buildTraceabilityReport(state);
        expect(report.orphanedStories).toEqual(['US-001', 'US-002']);
        expect(report.totals.missing).toBe(2);
    });

    // ─── T3: approved-but-not-merged is NOT merged ───────────────────────

    it('treats approved-but-not-merged PR as planned-only', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [
                makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'approved'),
            ],
        });

        const report = buildTraceabilityReport(state);
        // Approved but not merged should not be treated as merged
        expect(report.rows[0].status).toBe('planned-only');
    });

    it('handles multiple tests for the same criterion', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'test A', storyId: 'US-001', acIndex: 0, status: 'fail' },
                    { testName: 'test B', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ], 'pass', 'executed'),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.rows[0].status).toBe('verified');
        expect(report.rows[0].testNames).toContain('test A');
        expect(report.rows[0].testNames).toContain('test B');
    });

    // ─── New Sub-Plan 10 tests ───────────────────────────────────────────

    it('tested-failing status when merged + failing executed test', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'test failing', storyId: 'US-001', acIndex: 0, status: 'fail' },
                ], 'fail', 'executed'),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.rows[0].status).toBe('tested-failing');
        expect(report.totals.testedFailing).toBe(1);
        expect(report.totals.deliveryScore).toBeCloseTo(0.25, 5);
    });

    it('blocked status when PR is blocked', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'blocked')],
        });

        const report = buildTraceabilityReport(state);
        expect(report.rows[0].status).toBe('blocked');
        expect(report.totals.blocked).toBe(1);
    });

    it('only executed tests produce verified (claimed tests do not)', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'claimed test', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ], 'pass', 'claimed'),
            ],
        });

        const report = buildTraceabilityReport(state);
        // Claimed tests do not produce verified
        expect(report.rows[0].status).toBe('implemented-untested');
        expect(report.rows[0].claimedTests).toHaveLength(1);
        expect(report.rows[0].executedTests).toHaveLength(0);
    });

    it('acIndexes on assignments: AC not in acIndexes is missing', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-0', 'AC-1', 'AC-2'])],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001', 'feat/x', { acIndexes: [0] }),
            ],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
        });

        const report = buildTraceabilityReport(state);
        // AC#0 is covered by the assignment
        expect(report.rows[0].status).toBe('implemented-untested');
        expect(report.rows[0].assignmentIds).toContain('ASSIGN-001');
        // AC#1 and AC#2 are not in acIndexes → missing
        expect(report.rows[1].status).toBe('missing');
        expect(report.rows[2].status).toBe('missing');
    });

    it('does not mutate story.acceptanceCriteria (T6 regression)', () => {
        const stories = [makeStory('US-001', 'EPIC-001', [])];
        const state = makeMinimalState({
            userStories: stories,
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
        });

        buildTraceabilityReport(state);
        buildTraceabilityReport(state);
        // Should still be empty — not accumulated synthetic ACs
        expect(stories[0].acceptanceCriteria).toHaveLength(0);
    });

    it('excludes bugfix sentinel from orphan detection', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001'),
                makeAssignment('BUGFIX-1-ASSIGN-008', 'US-BUGFIX'),
            ],
        });

        const report = buildTraceabilityReport(state);
        // Bugfix assignment should NOT appear in orphanedAssignments
        expect(report.orphanedAssignments).not.toContain('BUGFIX-1-ASSIGN-008');
    });

    it('detects orphaned and unassigned tasks', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            tasks: [
                makeTask('TASK-001', 'US-001'),
                makeTask('TASK-002', 'US-999'),  // orphaned: storyId matches no story
                makeTask('TASK-003', 'US-001'),   // unassigned: not in any assignment's taskIds
            ],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001', undefined, { taskIds: ['TASK-001'] }),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.orphanedTasks).toContain('TASK-002');
        expect(report.unassignedTasks).toContain('TASK-003');
        expect(report.unassignedTasks).not.toContain('TASK-001');
    });

    it('detects blocked deliveries', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [
                makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'blocked'),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.blockedDeliveries).toHaveLength(1);
        expect(report.blockedDeliveries[0].branchName).toBe('feat/x');
    });

    it('computes claimed vs executed discrepancies', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'claimed test', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ], 'pass', 'claimed'),
                makeTestReport([], 'inconclusive' as any, 'executed'),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.claimedVsExecuted).toHaveLength(1);
        expect(report.claimedVsExecuted[0].claimedTotal).toBe(1);
        expect(report.claimedVsExecuted[0].executedTotal).toBe(0);
    });

    it('uses latest iteration only for test refs', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                // Older iteration: was failing
                {
                    ...makeTestReport([
                        { testName: 'test-a', storyId: 'US-001', acIndex: 0, status: 'fail' },
                    ], 'fail', 'executed'),
                    iterationIndex: 0,
                },
                // Latest iteration: now passing
                {
                    ...makeTestReport([
                        { testName: 'test-a', storyId: 'US-001', acIndex: 0, status: 'pass' },
                    ], 'pass', 'executed'),
                    iterationIndex: 1,
                },
            ],
        });

        const report = buildTraceabilityReport(state);
        // Only the latest iteration (1) should be used
        expect(report.rows[0].status).toBe('verified');
        expect(report.rows[0].testStatus).toBe('pass');
    });
});

// ─── renderTraceabilityMarkdown ──────────────────────────────────────────────

describe('renderTraceabilityMarkdown', () => {
    it('contains summary with 3 coverage numbers and escapes | in AC text', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['User can view | edit profile', 'User saves data']),
            ],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        // Pipe in AC text should be escaped
        expect(md).toContain('User can view \\| edit profile');

        // Should contain the 3 new coverage numbers
        expect(md).toContain('Verified %');
        expect(md).toContain('Implemented %');
        expect(md).toContain('Delivery score');

        // Should contain summary table
        expect(md).toContain('Requirements Traceability Summary');
        expect(md).toContain('Traceability Matrix');
    });

    it('includes orphan sections when orphans exist', () => {
        const report: TraceabilityReport = {
            rows: [],
            totals: {
                criteria: 0, verified: 0, testedFailing: 0, implemented: 0,
                plannedOnly: 0, blocked: 0, missing: 0,
                verifiedPct: 0, implementedPct: 0, deliveryScore: 0,
            },
            orphanedStories: ['US-007', 'US-011'],
            orphanedAssignments: ['ASSIGN-099'],
            orphanedTasks: [],
            unassignedTasks: [],
            blockedDeliveries: [],
            claimedVsExecuted: [],
        };

        const md = renderTraceabilityMarkdown(report);
        expect(md).toContain('Orphaned Stories');
        expect(md).toContain('US-007');
        expect(md).toContain('US-011');
        expect(md).toContain('Orphaned Assignments');
        expect(md).toContain('ASSIGN-099');
    });

    it('omits orphan sections when none exist', () => {
        const report: TraceabilityReport = {
            rows: [],
            totals: {
                criteria: 0, verified: 0, testedFailing: 0, implemented: 0,
                plannedOnly: 0, blocked: 0, missing: 0,
                verifiedPct: 0, implementedPct: 0, deliveryScore: 0,
            },
            orphanedStories: [],
            orphanedAssignments: [],
            orphanedTasks: [],
            unassignedTasks: [],
            blockedDeliveries: [],
            claimedVsExecuted: [],
        };

        const md = renderTraceabilityMarkdown(report);
        expect(md).not.toContain('Orphaned Stories');
        expect(md).not.toContain('Orphaned Assignments');
    });

    it('renders PR numbers and test counts in the table', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 42, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'test-login', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ], 'pass', 'executed'),
            ],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        expect(md).toContain('#42');
        expect(md).toContain('1 exec [pass]');
    });

    it('renders Top Gaps section with gap-first ordering', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['AC-A', 'AC-B']),
                makeStory('US-002', 'EPIC-001', ['AC-C']),
            ],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001'),
            ],
            pullRequests: [
                makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged'),
            ],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        // Missing gaps should be listed in Top Gaps
        expect(md).toContain('Top Gaps');
        expect(md).toContain('MISSING');
    });

    it('renders Blocked Deliveries section', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'blocked')],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        expect(md).toContain('Blocked Deliveries');
        expect(md).toContain('feat/x');
    });

    it('renders Claimed vs Executed section', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'claimed test', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ], 'pass', 'claimed'),
            ],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        expect(md).toContain('Claimed vs Executed');
    });

    it('renders Unassigned Tasks section', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            tasks: [makeTask('TASK-001', 'US-001'), makeTask('TASK-002', 'US-001')],
            assignments: [makeAssignment('ASSIGN-001', 'US-001', undefined, { taskIds: ['TASK-001'] })],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        expect(md).toContain('Unassigned Tasks');
        expect(md).toContain('TASK-002');
    });
});
