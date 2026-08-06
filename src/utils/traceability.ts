/**
 * Requirements traceability matrix and acceptance-criteria coverage.
 *
 * Chains epics -> stories -> acceptance criteria -> tasks -> assignments ->
 * PRs -> tests into one matrix so "did we build and verify what was asked?"
 * is answerable.  Previously (PART A10) test plan items carried no story or
 * criterion reference, so a story dropped by the Team Leader was undetectable.
 */
import type { ProjectStateType } from '../conductor/state';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TraceRow {
    epicId: string;
    storyId: string;
    acIndex: number;
    acText: string;
    taskIds: string[];
    assignmentIds: string[];
    branchNames: string[];
    prNumbers: number[];
    prStatuses: string[];
    testNames: string[];
    testStatus: 'pass' | 'fail' | 'none';
    status: 'verified' | 'implemented-untested' | 'planned-only' | 'missing';
}

export interface TraceabilityReport {
    rows: TraceRow[];
    totals: {
        criteria: number;
        verified: number;
        implemented: number;
        missing: number;
        coveragePct: number;
    };
    /** Stories the Team Leader never assigned -- silent scope loss. */
    orphanedStories: string[];
    /** Assignments whose storyId matches no user story -- invented work. */
    orphanedAssignments: string[];
}

// ─── Report Builder ─────────────────────────────────────────────────────────

/**
 * Chain epics -> stories -> acceptance criteria -> tasks -> assignments ->
 * PRs -> tests into one matrix.
 */
export function buildTraceabilityReport(state: ProjectStateType): TraceabilityReport {
    const rows: TraceRow[] = [];
    const storyIds = new Set<string>();
    const assignedStoryIds = new Set<string>();

    // Index tasks by storyId
    const tasksByStory = new Map<string, string[]>();
    for (const task of state.tasks ?? []) {
        if (task.storyId) {
            const list = tasksByStory.get(task.storyId) ?? [];
            list.push(task.id);
            tasksByStory.set(task.storyId, list);
        }
    }

    // Index assignments by storyId
    const assignmentsByStory = new Map<string, typeof state.assignments>();
    for (const a of state.assignments ?? []) {
        assignedStoryIds.add(a.storyId);
        const list = assignmentsByStory.get(a.storyId) ?? [];
        list.push(a);
        assignmentsByStory.set(a.storyId, list);
    }

    // Index PRs by assignmentId
    const prsByAssignment = new Map<string, typeof state.pullRequests>();
    for (const pr of state.pullRequests ?? []) {
        for (const aId of pr.assignmentIds ?? []) {
            const list = prsByAssignment.get(aId) ?? [];
            list.push(pr);
            prsByAssignment.set(aId, list);
        }
    }

    // Collect test references from test plan items and test report cases.
    // A test "covers" (storyId, acIndex) if it carries those fields.
    // acIndex === -1 means whole-story coverage (every AC of that story).
    interface TestRef { testName: string; storyId: string; acIndex: number; status: 'pass' | 'fail' | 'skip' | 'planned' }

    const testRefs: TestRef[] = [];

    // From test plan items (planned)
    const plan = state.testPlan;
    if (plan) {
        for (const item of [...(plan.unit ?? []), ...(plan.integration ?? [])]) {
            if (item.storyId) {
                testRefs.push({
                    testName: item.target ?? item.description,
                    storyId: item.storyId,
                    acIndex: item.acIndex ?? -1,
                    status: 'planned',
                });
            }
        }
        for (const item of plan.e2e ?? []) {
            if (item.storyId) {
                testRefs.push({
                    testName: item.scenario ?? item.description,
                    storyId: item.storyId,
                    acIndex: item.acIndex ?? -1,
                    status: 'planned',
                });
            }
        }
    }

    // From test report cases (executed)
    for (const report of state.testReports ?? []) {
        for (const c of report.cases ?? []) {
            if (c.storyId) {
                testRefs.push({
                    testName: c.testName,
                    storyId: c.storyId,
                    acIndex: c.acIndex ?? -1,
                    status: c.status,
                });
            }
        }
    }

    // Index test refs by (storyId, acIndex)
    const testsByStoryAc = new Map<string, TestRef[]>();
    for (const ref of testRefs) {
        const key = `${ref.storyId}:${ref.acIndex}`;
        const list = testsByStoryAc.get(key) ?? [];
        list.push(ref);
        testsByStoryAc.set(key, list);
    }

    // Build rows: one per (story, acceptance criterion)
    for (const story of state.userStories ?? []) {
        storyIds.add(story.id);

        const criteria = story.acceptanceCriteria ?? [];
        if (criteria.length === 0) {
            // Story with no AC gets one synthetic row
            criteria.push('(no acceptance criteria defined)');
        }

        for (let acIdx = 0; acIdx < criteria.length; acIdx++) {
            const acText = criteria[acIdx];

            // Tasks for this story
            const taskIds = tasksByStory.get(story.id) ?? [];

            // Assignments for this story
            const storyAssignments = assignmentsByStory.get(story.id) ?? [];
            const assignmentIds = storyAssignments.map(a => a.id);

            // PRs for these assignments
            const prSet = new Map<number, typeof state.pullRequests[number]>();
            const branchSet = new Set<string>();
            for (const a of storyAssignments) {
                for (const pr of prsByAssignment.get(a.id) ?? []) {
                    prSet.set(pr.prNumber, pr);
                    branchSet.add(pr.branchName);
                }
                if (a.branchName) branchSet.add(a.branchName);
            }
            const prNumbers = [...prSet.keys()];
            const prStatuses = [...prSet.values()].map(pr => pr.status);
            const branchNames = [...branchSet];

            // Has any PR been merged/approved?
            const hasMerged = prStatuses.some(s => s === 'merged' || s === 'approved');

            // Tests covering this specific criterion or the whole story (-1)
            const specificTests = testsByStoryAc.get(`${story.id}:${acIdx}`) ?? [];
            const wholeStoryTests = testsByStoryAc.get(`${story.id}:-1`) ?? [];
            const allTests = [...specificTests, ...wholeStoryTests];

            const testNames = allTests.map(t => t.testName);

            // Determine test status: pass if any executed test passed,
            // fail if any executed test failed, none otherwise
            const executedTests = allTests.filter(t => t.status !== 'planned');
            let testStatus: 'pass' | 'fail' | 'none' = 'none';
            if (executedTests.some(t => t.status === 'pass')) {
                testStatus = 'pass';
            } else if (executedTests.some(t => t.status === 'fail')) {
                testStatus = 'fail';
            }

            // Derive status
            let status: TraceRow['status'];
            if (assignmentIds.length === 0) {
                status = 'missing';
            } else if (!hasMerged) {
                status = 'planned-only';
            } else if (testStatus === 'none') {
                status = 'implemented-untested';
            } else if (testStatus === 'pass') {
                status = 'verified';
            } else {
                // tests exist but none passed (all fail/skip)
                status = 'implemented-untested';
            }

            rows.push({
                epicId: story.epicId,
                storyId: story.id,
                acIndex: acIdx,
                acText,
                taskIds,
                assignmentIds,
                branchNames,
                prNumbers,
                prStatuses,
                testNames,
                testStatus,
                status,
            });
        }
    }

    // Orphaned stories: stories with no assignments
    const orphanedStories = [...storyIds].filter(id => !assignedStoryIds.has(id));

    // Orphaned assignments: assignments whose storyId matches no user story
    const orphanedAssignments: string[] = [];
    for (const a of state.assignments ?? []) {
        if (!storyIds.has(a.storyId)) {
            orphanedAssignments.push(a.id);
        }
    }

    // Compute totals
    const criteria = rows.length;
    const verified = rows.filter(r => r.status === 'verified').length;
    const implemented = rows.filter(r => r.status === 'implemented-untested').length;
    const missing = rows.filter(r => r.status === 'missing').length;
    const coveragePct = criteria > 0 ? verified / criteria : 0;

    return {
        rows,
        totals: { criteria, verified, implemented, missing, coveragePct },
        orphanedStories,
        orphanedAssignments,
    };
}

// ─── Markdown Renderer ──────────────────────────────────────────────────────

/** Escape pipe characters in markdown table cells. */
function escPipe(text: string): string {
    return text.replace(/\|/g, '\\|');
}

/** Markdown rendering: summary, coverage table, orphan sections. */
export function renderTraceabilityMarkdown(report: TraceabilityReport): string {
    const { totals, rows, orphanedStories, orphanedAssignments } = report;
    const lines: string[] = [];

    // Summary
    lines.push('## Requirements Traceability Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total acceptance criteria | ${totals.criteria} |`);
    lines.push(`| Verified (merged + test passed) | ${totals.verified} |`);
    lines.push(`| Implemented but untested | ${totals.implemented} |`);
    lines.push(`| Planned only (no merged PR) | ${rows.filter(r => r.status === 'planned-only').length} |`);
    lines.push(`| Missing (no assignment) | ${totals.missing} |`);
    lines.push(`| Coverage | ${(totals.coveragePct * 100).toFixed(1)}% |`);
    lines.push('');

    // Coverage table
    lines.push('## Traceability Matrix');
    lines.push('');
    lines.push('| Epic | Story | AC# | Acceptance Criterion | Status | PRs | Tests |');
    lines.push('|------|-------|-----|----------------------|--------|-----|-------|');
    for (const row of rows) {
        const prCol = row.prNumbers.length > 0
            ? row.prNumbers.map((n, i) => `#${n} (${row.prStatuses[i]})`).join(', ')
            : '--';
        const testCol = row.testNames.length > 0
            ? `${row.testNames.length} [${row.testStatus}]`
            : '--';
        lines.push(`| ${escPipe(row.epicId)} | ${escPipe(row.storyId)} | ${row.acIndex} | ${escPipe(row.acText)} | ${row.status} | ${escPipe(prCol)} | ${escPipe(testCol)} |`);
    }
    lines.push('');

    // Orphaned stories
    if (orphanedStories.length > 0) {
        lines.push('## Orphaned Stories (no assignments -- silent scope loss)');
        lines.push('');
        for (const id of orphanedStories) {
            lines.push(`- ${id}`);
        }
        lines.push('');
    }

    // Orphaned assignments
    if (orphanedAssignments.length > 0) {
        lines.push('## Orphaned Assignments (storyId matches no user story -- invented work)');
        lines.push('');
        for (const id of orphanedAssignments) {
            lines.push(`- ${id}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
