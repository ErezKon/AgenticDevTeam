/**
 * Requirements Traceability — Unit Tests
 *
 * Exercises: buildTraceabilityReport, renderTraceabilityMarkdown (pure, fixture state).
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
    };
}

function makeAssignment(id: string, storyId: string, branchName?: string): Assignment {
    return {
        id, storyId,
        devAgentId: 'junior-react', rank: 'junior',
        priority: 'medium', complexity: 'moderate',
        estimate: '2h', description: 'Build it',
        dependsOn: [], taskType: 'feature',
        ...(branchName ? { branchName } : {}),
    };
}

function makePR(id: string, prNumber: number, branchName: string, assignmentIds: string[], status: 'open' | 'approved' | 'merged' | 'closed' | 'escalated_open'): PullRequest {
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
            ...(i.storyId ? { storyId: i.storyId } : {}),
            ...(i.acIndex !== undefined ? { acIndex: i.acIndex } : {}),
        })),
        integration: [],
        e2e: [],
        coverageTargets: { unit: 80, integration: 60, e2e: 100 },
    };
}

function makeTestReport(
    cases: { testName: string; storyId?: string; acIndex?: number; status: 'pass' | 'fail' | 'skip' }[],
    overallStatus: 'pass' | 'fail' = 'pass',
): TestReport {
    return {
        type: 'unit', framework: 'jest',
        total: cases.length, passed: cases.filter(c => c.status === 'pass').length,
        failed: cases.filter(c => c.status === 'fail').length,
        skipped: cases.filter(c => c.status === 'skip').length,
        status: overallStatus,
        failures: cases.filter(c => c.status === 'fail').map(c => ({
            testName: c.testName, error: 'assertion failed',
        })),
        agentId: 'qa-unit',
        cases: cases.map(c => ({
            testName: c.testName,
            status: c.status,
            ...(c.storyId ? { storyId: c.storyId } : {}),
            ...(c.acIndex !== undefined ? { acIndex: c.acIndex } : {}),
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
        ...overrides,
    } as ProjectStateType;
}

// ─── Test 1: Full scenario ───────────────────────────────────────────────────

describe('buildTraceabilityReport', () => {
    it('correctly traces 2 epics, 3 stories (2 AC each), partial coverage', () => {
        // 2 epics, 3 stories (2 AC each), tasks and assignments for stories 1-2 only,
        // one merged PR for story 1, one open PR for story 2,
        // a passing test tagged storyId: 'US-001', acIndex: 0
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
                ]),
            ],
        });

        const report = buildTraceabilityReport(state);

        // US-001/0: verified (merged PR + passing test)
        const us001_0 = report.rows.find(r => r.storyId === 'US-001' && r.acIndex === 0);
        expect(us001_0?.status).toBe('verified');
        expect(us001_0?.testStatus).toBe('pass');

        // US-001/1: implemented-untested (merged PR, no test)
        const us001_1 = report.rows.find(r => r.storyId === 'US-001' && r.acIndex === 1);
        expect(us001_1?.status).toBe('implemented-untested');

        // US-002/*: planned-only (open PR, not merged)
        const us002_0 = report.rows.find(r => r.storyId === 'US-002' && r.acIndex === 0);
        expect(us002_0?.status).toBe('planned-only');
        const us002_1 = report.rows.find(r => r.storyId === 'US-002' && r.acIndex === 1);
        expect(us002_1?.status).toBe('planned-only');

        // US-003/*: missing (no assignment)
        const us003_0 = report.rows.find(r => r.storyId === 'US-003' && r.acIndex === 0);
        expect(us003_0?.status).toBe('missing');
        const us003_1 = report.rows.find(r => r.storyId === 'US-003' && r.acIndex === 1);
        expect(us003_1?.status).toBe('missing');

        // Orphaned stories
        expect(report.orphanedStories).toEqual(['US-003']);

        // Totals
        expect(report.totals.criteria).toBe(6);
        expect(report.totals.verified).toBe(1);
        expect(report.totals.coveragePct).toBeCloseTo(1 / 6, 5);
    });

    // ─── Test 2: Orphaned assignments ────────────────────────────────────

    it('detects orphaned assignments whose storyId matches no user story', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['Criterion A']),
            ],
            assignments: [
                makeAssignment('ASSIGN-001', 'US-001'),
                makeAssignment('ASSIGN-999', 'US-999'),  // orphaned
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.orphanedAssignments).toEqual(['ASSIGN-999']);
    });

    // ─── Test 3: acIndex -1 covers whole story ───────────────────────────

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
                ]),
            ],
        });

        const report = buildTraceabilityReport(state);

        // All 3 criteria should be verified via the acIndex=-1 test
        expect(report.rows).toHaveLength(3);
        for (const row of report.rows) {
            expect(row.status).toBe('verified');
            expect(row.testStatus).toBe('pass');
            expect(row.testNames).toContain('full story test');
        }
        expect(report.totals.verified).toBe(3);
        expect(report.totals.coveragePct).toBe(1);
    });

    // ─── Test 4: Empty state ─────────────────────────────────────────────

    it('handles empty state gracefully', () => {
        const state = makeMinimalState({});
        const report = buildTraceabilityReport(state);

        expect(report.rows).toHaveLength(0);
        expect(report.totals.criteria).toBe(0);
        expect(report.totals.coveragePct).toBe(0);
        expect(report.orphanedStories).toEqual([]);
        expect(report.orphanedAssignments).toEqual([]);
    });

    // ─── Test 5: All stories orphaned ────────────────────────────────────

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

    // ─── Test 6: Approved PR counts as merged ────────────────────────────

    it('treats approved PR status as implemented', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [
                makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'approved'),
            ],
        });

        const report = buildTraceabilityReport(state);
        expect(report.rows[0].status).toBe('implemented-untested');
    });

    // ─── Test 7: Multiple tests for same criterion ───────────────────────

    it('handles multiple tests for the same criterion', () => {
        const state = makeMinimalState({
            userStories: [makeStory('US-001', 'EPIC-001', ['AC-A'])],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
            testReports: [
                makeTestReport([
                    { testName: 'test A', storyId: 'US-001', acIndex: 0, status: 'fail' },
                    { testName: 'test B', storyId: 'US-001', acIndex: 0, status: 'pass' },
                ]),
            ],
        });

        const report = buildTraceabilityReport(state);
        // If any test passes, the criterion is verified
        expect(report.rows[0].status).toBe('verified');
        expect(report.rows[0].testNames).toContain('test A');
        expect(report.rows[0].testNames).toContain('test B');
    });
});

// ─── renderTraceabilityMarkdown ──────────────────────────────────────────────

describe('renderTraceabilityMarkdown', () => {
    it('contains one table row per criterion and escapes | in AC text', () => {
        const state = makeMinimalState({
            userStories: [
                makeStory('US-001', 'EPIC-001', ['User can view | edit profile', 'User saves data']),
            ],
            assignments: [makeAssignment('ASSIGN-001', 'US-001')],
            pullRequests: [makePR('PR-001', 101, 'feat/x', ['ASSIGN-001'], 'merged')],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        // Should have exactly 2 data rows in the traceability matrix table
        // Matrix rows contain storyId like US-001
        const matrixRows = md.split('\n').filter(line =>
            line.startsWith('| ') && line.includes('US-')
        );
        expect(matrixRows).toHaveLength(2);

        // Pipe in AC text should be escaped
        expect(md).toContain('User can view \\| edit profile');

        // Should contain summary table
        expect(md).toContain('Requirements Traceability Summary');
        expect(md).toContain('Traceability Matrix');
    });

    it('includes orphan sections when orphans exist', () => {
        const report: TraceabilityReport = {
            rows: [],
            totals: { criteria: 0, verified: 0, implemented: 0, missing: 0, coveragePct: 0 },
            orphanedStories: ['US-007', 'US-011'],
            orphanedAssignments: ['ASSIGN-099'],
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
            totals: { criteria: 0, verified: 0, implemented: 0, missing: 0, coveragePct: 0 },
            orphanedStories: [],
            orphanedAssignments: [],
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
                ]),
            ],
        });

        const report = buildTraceabilityReport(state);
        const md = renderTraceabilityMarkdown(report);

        expect(md).toContain('#42');
        expect(md).toContain('1 [pass]');
    });
});
