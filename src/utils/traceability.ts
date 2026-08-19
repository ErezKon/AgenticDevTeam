/**
 * Requirements traceability matrix and acceptance-criteria coverage.
 *
 * Chains epics -> stories -> acceptance criteria -> tasks -> assignments ->
 * PRs -> tests into one matrix so "did we build and verify what was asked?"
 * is answerable.
 *
 * Sub-Plan 10 rewrite:
 *  - Graded AcStatus (6 states) replaces the old 4-state enum
 *  - CoverageTotals carries verifiedPct, implementedPct, deliveryScore
 *  - Coverage derived from executed tests only (source === 'executed')
 *  - hasMerged requires status === 'merged' (not 'approved')
 *  - No in-place mutation of story.acceptanceCriteria
 *  - TraceRow.taskIds from assignment.taskIds
 *  - orphanedTasks, unassignedTasks, blockedDeliveries
 *  - Bugfix sentinel (US-BUGFIX) excluded from orphan detection
 *  - acIndexes from assignments used for per-AC coverage
 *  - Gap-first ordering, Top Gaps, Claimed vs Executed sections
 */
import type { ProjectStateType } from '../conductor/state';
import { mdTable } from './markdown-table';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AcStatus =
    | 'verified'              // merged + a passing tagged test (source: 'executed')
    | 'tested-failing'        // merged + a tagged test that FAILS
    | 'implemented-untested'  // merged, no tagged test
    | 'planned-only'          // assigned, PR not merged
    | 'blocked'               // assigned, PR blocked/conflicted/open after run
    | 'missing';              // no assignment at all

export interface CoverageTotals {
    criteria: number;
    verified: number;
    testedFailing: number;
    implemented: number;
    plannedOnly: number;
    blocked: number;
    missing: number;
    /** verified / criteria — the strict bar. */
    verifiedPct: number;
    /** (verified + implemented) / criteria — "the code exists". */
    implementedPct: number;
    /** Weighted delivery score: verified 1.0, implemented 0.5, testedFailing 0.25, others 0. */
    deliveryScore: number;
}

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
    /** Test source breakdown for the Claimed vs Executed column. */
    executedTests: { name: string; status: 'pass' | 'fail' | 'skip' }[];
    claimedTests: { name: string; status: 'pass' | 'fail' | 'skip' }[];
    plannedTests: string[];
    testStatus: 'pass' | 'fail' | 'none';
    status: AcStatus;
}

export interface ClaimedVsExecuted {
    agentId: string;
    claimedTotal: number;
    claimedPassed: number;
    claimedFailed: number;
    executedTotal: number;
    executedPassed: number;
    executedFailed: number;
}

export interface TraceabilityReport {
    rows: TraceRow[];
    totals: CoverageTotals;
    /** Stories the Team Leader never assigned — silent scope loss. */
    orphanedStories: string[];
    /** Assignments whose storyId matches no user story — invented work. */
    orphanedAssignments: string[];
    /** Tasks whose storyId matches no user story — vanished silently. */
    orphanedTasks: string[];
    /** Tasks not referenced in any assignment's taskIds. */
    unassignedTasks: string[];
    /** Branches that are blocked/conflicted, with PR info. */
    blockedDeliveries: { branchName: string; prNumber: number; status: string; reason: string }[];
    /** Discrepancies between agent-claimed and runner-executed results. */
    claimedVsExecuted: ClaimedVsExecuted[];
}

// ─── Bugfix sentinel ────────────────────────────────────────────────────────
const BUGFIX_STORY_ID = 'US-BUGFIX';

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

    // All task IDs in the system (for unassignedTasks detection)
    const allTaskIds = new Set((state.tasks ?? []).map(t => t.id));
    const taskIdsInAssignments = new Set<string>();

    // Index assignments by storyId AND additionalStoryIds
    const assignmentsByStory = new Map<string, typeof state.assignments>();
    for (const a of state.assignments ?? []) {
        assignedStoryIds.add(a.storyId);
        const list = assignmentsByStory.get(a.storyId) ?? [];
        list.push(a);
        assignmentsByStory.set(a.storyId, list);
        // Also index by additionalStoryIds (Sub-Plan 04)
        for (const sid of a.additionalStoryIds ?? []) {
            assignedStoryIds.add(sid);
            const addList = assignmentsByStory.get(sid) ?? [];
            addList.push(a);
            assignmentsByStory.set(sid, addList);
        }
        // Track taskIds referenced in assignments
        for (const tid of a.taskIds ?? []) {
            taskIdsInAssignments.add(tid);
        }
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
    interface TestRef {
        testName: string;
        storyId: string;
        acIndex: number;
        status: 'pass' | 'fail' | 'skip' | 'planned';
        source: 'executed' | 'claimed' | 'quality-gates' | 'planned';
    }

    const testRefs: TestRef[] = [];

    // Determine latest iteration index for filtering
    const allReports = state.testReports ?? [];
    const maxIteration = allReports.length > 0
        ? Math.max(...allReports.map(r => (r as any).iterationIndex ?? 0))
        : 0;

    // From test plan items (planned — informational only, never produces 'verified')
    const plan = state.testPlan;
    if (plan) {
        for (const item of [...(plan.unit ?? []), ...(plan.integration ?? [])]) {
            if (item.storyId) {
                testRefs.push({
                    testName: item.target ?? item.description,
                    storyId: item.storyId,
                    acIndex: item.acIndex ?? -1,
                    status: 'planned',
                    source: 'planned',
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
                    source: 'planned',
                });
            }
        }
    }

    // From test report cases — only latest iteration
    for (const report of allReports) {
        const iterIdx = (report as any).iterationIndex ?? 0;
        if (iterIdx < maxIteration) continue; // skip stale iterations
        const reportSource: 'executed' | 'claimed' | 'quality-gates' =
            (report as any).source ?? 'claimed';
        for (const c of report.cases ?? []) {
            if (c.storyId) {
                testRefs.push({
                    testName: c.testName,
                    storyId: c.storyId,
                    acIndex: c.acIndex ?? -1,
                    status: c.status,
                    source: reportSource,
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

        // T6 fix: do NOT mutate story.acceptanceCriteria — use a local copy
        const criteria = (story.acceptanceCriteria?.length ?? 0) > 0
            ? story.acceptanceCriteria!
            : ['(no acceptance criteria defined)'];

        for (let acIdx = 0; acIdx < criteria.length; acIdx++) {
            const acText = criteria[acIdx];

            // Tasks for this story (from task.storyId)
            const storyTaskIds = tasksByStory.get(story.id) ?? [];
            // Also include taskIds from assignments (Sub-Plan 04) — T7 fix
            const assignmentTaskIds = (assignmentsByStory.get(story.id) ?? []).flatMap(a => a.taskIds ?? []);
            const allRowTaskIds = [...new Set([...storyTaskIds, ...assignmentTaskIds])];

            // Assignments for this story
            const storyAssignments = assignmentsByStory.get(story.id) ?? [];

            // Check if this specific AC is covered by any assignment's acIndexes
            // An assignment with acIndexes: [0] on a 3-criteria story means only AC#0 is covered
            let acAssignments = storyAssignments;
            const hasAnyAcIndexes = storyAssignments.some(a => (a.acIndexes ?? []).length > 0);
            if (hasAnyAcIndexes) {
                acAssignments = storyAssignments.filter(a => {
                    const acIdxs = a.acIndexes ?? [];
                    // No acIndexes means "all criteria" (backward compat)
                    return acIdxs.length === 0 || acIdxs.includes(acIdx);
                });
            }

            const assignmentIds = acAssignments.map(a => a.id);

            // PRs for these assignments
            const prSet = new Map<number, typeof state.pullRequests[number]>();
            const branchSet = new Set<string>();
            for (const a of acAssignments) {
                for (const pr of prsByAssignment.get(a.id) ?? []) {
                    prSet.set(pr.prNumber, pr);
                    branchSet.add(pr.branchName);
                }
                if (a.branchName) branchSet.add(a.branchName);
            }
            const prNumbers = [...prSet.keys()];
            const prStatuses = [...prSet.values()].map(pr => pr.status);
            const branchNames = [...branchSet];

            // T3 fix: hasMerged requires status === 'merged' only (not 'approved')
            const hasMerged = prStatuses.some(s => s === 'merged');
            const isBlocked = prStatuses.some(s => s === 'blocked' || s === 'open');

            // Tests covering this specific criterion or the whole story (-1)
            const specificTests = testsByStoryAc.get(`${story.id}:${acIdx}`) ?? [];
            const wholeStoryTests = testsByStoryAc.get(`${story.id}:-1`) ?? [];
            const allTests = [...specificTests, ...wholeStoryTests];

            const testNames = allTests.map(t => t.testName);

            // Separate by source for reporting
            const executedTests = allTests
                .filter(t => t.source === 'executed')
                .map(t => ({ name: t.testName, status: t.status as 'pass' | 'fail' | 'skip' }));
            const claimedTests = allTests
                .filter(t => t.source === 'claimed')
                .map(t => ({ name: t.testName, status: t.status as 'pass' | 'fail' | 'skip' }));
            const plannedTests = allTests
                .filter(t => t.source === 'planned')
                .map(t => t.testName);

            // T2 fix: determine test status from EXECUTED reports only
            const execNonPlanned = allTests.filter(t => t.source === 'executed');
            let testStatus: 'pass' | 'fail' | 'none' = 'none';
            if (execNonPlanned.some(t => t.status === 'pass')) {
                testStatus = 'pass';
            } else if (execNonPlanned.some(t => t.status === 'fail')) {
                testStatus = 'fail';
            }

            // Derive status — 6-state model
            let status: AcStatus;
            if (assignmentIds.length === 0) {
                status = 'missing';
            } else if (isBlocked && !hasMerged) {
                status = 'blocked';
            } else if (!hasMerged) {
                status = 'planned-only';
            } else if (testStatus === 'pass') {
                status = 'verified';
            } else if (testStatus === 'fail') {
                status = 'tested-failing';
            } else {
                status = 'implemented-untested';
            }

            rows.push({
                epicId: story.epicId,
                storyId: story.id,
                acIndex: acIdx,
                acText,
                taskIds: allRowTaskIds,
                assignmentIds,
                branchNames,
                prNumbers,
                prStatuses,
                testNames,
                executedTests,
                claimedTests,
                plannedTests,
                testStatus,
                status,
            });
        }
    }

    // Orphaned stories: stories with no assignments (exclude bugfix sentinel)
    const orphanedStories = [...storyIds].filter(id =>
        !assignedStoryIds.has(id) && id !== BUGFIX_STORY_ID,
    );

    // Orphaned assignments: assignments whose storyId matches no user story
    // Exclude bugfix sentinel assignments
    const orphanedAssignments: string[] = [];
    for (const a of state.assignments ?? []) {
        if (!storyIds.has(a.storyId) && a.storyId !== BUGFIX_STORY_ID) {
            orphanedAssignments.push(a.id);
        }
    }

    // Orphaned tasks: tasks whose storyId matches no user story (P14)
    const orphanedTasks: string[] = [];
    for (const t of state.tasks ?? []) {
        if (t.storyId && !storyIds.has(t.storyId)) {
            orphanedTasks.push(t.id);
        }
    }

    // Unassigned tasks: tasks not referenced in any assignment's taskIds
    const unassignedTasks: string[] = [];
    for (const tid of allTaskIds) {
        if (!taskIdsInAssignments.has(tid)) {
            unassignedTasks.push(tid);
        }
    }

    // Blocked deliveries: PRs that are blocked/open with details
    const blockedDeliveries: TraceabilityReport['blockedDeliveries'] = [];
    for (const pr of state.pullRequests ?? []) {
        if (pr.status === 'blocked' || pr.status === 'open') {
            blockedDeliveries.push({
                branchName: pr.branchName,
                prNumber: pr.prNumber,
                status: pr.status,
                reason: pr.status === 'blocked' ? 'Merge conflicts or review blocked'
                    : 'PR still open at end of run',
            });
        }
    }

    // Claimed vs executed: compare agent self-reports against runner data
    const claimedVsExecuted: ClaimedVsExecuted[] = [];
    const claimedReports = allReports.filter(r => (r as any).source === 'claimed');
    const executedReports = allReports.filter(r => (r as any).source === 'executed');
    if (claimedReports.length > 0 || executedReports.length > 0) {
        const execTotals = executedReports.reduce((acc, r) => ({
            total: acc.total + r.total,
            passed: acc.passed + r.passed,
            failed: acc.failed + r.failed,
        }), { total: 0, passed: 0, failed: 0 });
        const claimedTotals = claimedReports.reduce((acc, r) => ({
            total: acc.total + r.total,
            passed: acc.passed + r.passed,
            failed: acc.failed + r.failed,
        }), { total: 0, passed: 0, failed: 0 });

        if (claimedTotals.total > 0 || execTotals.total > 0) {
            claimedVsExecuted.push({
                agentId: claimedReports[0]?.agentId ?? executedReports[0]?.agentId ?? 'unknown',
                claimedTotal: claimedTotals.total,
                claimedPassed: claimedTotals.passed,
                claimedFailed: claimedTotals.failed,
                executedTotal: execTotals.total,
                executedPassed: execTotals.passed,
                executedFailed: execTotals.failed,
            });
        }
    }

    // Compute totals — graded model
    const criteria = rows.length;
    const verified = rows.filter(r => r.status === 'verified').length;
    const testedFailing = rows.filter(r => r.status === 'tested-failing').length;
    const implemented = rows.filter(r => r.status === 'implemented-untested').length;
    const plannedOnly = rows.filter(r => r.status === 'planned-only').length;
    const blocked = rows.filter(r => r.status === 'blocked').length;
    const missing = rows.filter(r => r.status === 'missing').length;

    const verifiedPct = criteria > 0 ? verified / criteria : 0;
    const implementedPct = criteria > 0 ? (verified + implemented) / criteria : 0;
    const deliveryScore = criteria > 0
        ? (verified * 1.0 + implemented * 0.5 + testedFailing * 0.25) / criteria
        : 0;

    return {
        rows,
        totals: {
            criteria, verified, testedFailing, implemented,
            plannedOnly, blocked, missing,
            verifiedPct, implementedPct, deliveryScore,
        },
        orphanedStories,
        orphanedAssignments,
        orphanedTasks,
        unassignedTasks,
        blockedDeliveries,
        claimedVsExecuted,
    };
}

// ─── Markdown Renderer ──────────────────────────────────────────────────────

/** Status icon for display. */
function statusIcon(status: AcStatus): string {
    switch (status) {
        case 'verified': return 'verified';
        case 'tested-failing': return 'FAILING';
        case 'implemented-untested': return 'implemented-untested';
        case 'planned-only': return 'planned-only';
        case 'blocked': return 'BLOCKED';
        case 'missing': return 'MISSING';
    }
}

/** Markdown rendering: summary, coverage table, gap sections, orphan sections. */
export function renderTraceabilityMarkdown(report: TraceabilityReport): string {
    const { totals, rows, orphanedStories, orphanedAssignments, orphanedTasks,
        unassignedTasks, blockedDeliveries, claimedVsExecuted } = report;
    const lines: string[] = [];

    // Summary
    lines.push('## Requirements Traceability Summary');
    lines.push('');
    lines.push(mdTable(
        ['Metric', 'Value'],
        [
            ['Total acceptance criteria', totals.criteria],
            ['Verified (merged + executed test passed)', totals.verified],
            ['Tested but failing', totals.testedFailing],
            ['Implemented but untested', totals.implemented],
            ['Planned only (no merged PR)', totals.plannedOnly],
            ['Blocked', totals.blocked],
            ['Missing (no assignment)', totals.missing],
            ['Verified %', `${(totals.verifiedPct * 100).toFixed(1)}%`],
            ['Implemented %', `${(totals.implementedPct * 100).toFixed(1)}%`],
            ['Delivery score', totals.deliveryScore.toFixed(2)],
        ],
    ));
    lines.push('');

    // Top Gaps (gap-first ordering: missing, tested-failing, blocked, implemented-untested)
    const gaps = rows.filter(r =>
        r.status === 'missing' || r.status === 'tested-failing'
        || r.status === 'blocked' || r.status === 'implemented-untested',
    );
    // Sort: missing first, then tested-failing, then blocked, then implemented-untested
    const gapOrder: Record<AcStatus, number> = {
        'missing': 0, 'tested-failing': 1, 'blocked': 2,
        'implemented-untested': 3, 'planned-only': 4, 'verified': 5,
    };
    gaps.sort((a, b) => gapOrder[a.status] - gapOrder[b.status]);

    if (gaps.length > 0) {
        lines.push('## Top Gaps');
        lines.push('');
        const topGaps = gaps.slice(0, 15);
        const gapRows: (string | number)[][] = topGaps.map(row => {
            const assignCol = row.assignmentIds.length > 0
                ? row.assignmentIds[0]
                : `Story ${row.storyId}`;
            return [row.storyId, row.acIndex, row.acText.slice(0, 80), statusIcon(row.status), assignCol];
        });
        if (gaps.length > 15) {
            gapRows.push(['...', '...', `(${gaps.length - 15} more gaps)`, '...', '...']);
        }
        lines.push(mdTable(['Story', 'AC#', 'Criterion', 'Status', 'Assignment/Module'], gapRows));
        lines.push('');
    }

    // Coverage table — gap-first ordering
    const sortedRows = [...rows].sort((a, b) => gapOrder[a.status] - gapOrder[b.status]);

    lines.push('## Traceability Matrix');
    lines.push('');
    const matrixRows: (string | number)[][] = sortedRows.map(row => {
        const prCol = row.prNumbers.length > 0
            ? row.prNumbers.map((n, i) => `#${n} (${row.prStatuses[i]})`).join(', ')
            : '--';
        // Distinguish executed vs planned in test column
        const execCount = row.executedTests.length;
        const plannedCount = row.plannedTests.length;
        const claimedCount = row.claimedTests.length;
        const testParts: string[] = [];
        if (execCount > 0) testParts.push(`${execCount} exec [${row.testStatus}]`);
        if (claimedCount > 0) testParts.push(`${claimedCount} claimed`);
        if (plannedCount > 0) testParts.push(`${plannedCount} planned`);
        const testCol = testParts.length > 0 ? testParts.join(', ') : '--';
        return [row.epicId, row.storyId, row.acIndex, row.acText, statusIcon(row.status), prCol, testCol];
    });
    lines.push(mdTable(['Epic', 'Story', 'AC#', 'Acceptance Criterion', 'Status', 'PRs', 'Tests'], matrixRows));
    lines.push('');

    // Blocked deliveries
    if (blockedDeliveries.length > 0) {
        lines.push('## Blocked Deliveries');
        lines.push('');
        lines.push(mdTable(
            ['Branch', 'PR', 'Status', 'Reason'],
            blockedDeliveries.map(bd => [bd.branchName, `#${bd.prNumber}`, bd.status, bd.reason]),
        ));
        lines.push('');
    }

    // Claimed vs Executed
    if (claimedVsExecuted.length > 0) {
        lines.push('## Claimed vs Executed');
        lines.push('');
        lines.push(mdTable(
            ['Agent', 'Claimed Total', 'Claimed Passed', 'Claimed Failed', 'Executed Total', 'Executed Passed', 'Executed Failed'],
            claimedVsExecuted.map(cve => [cve.agentId, cve.claimedTotal, cve.claimedPassed, cve.claimedFailed, cve.executedTotal, cve.executedPassed, cve.executedFailed]),
        ));
        lines.push('');
    }

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

    // Orphaned tasks
    if (orphanedTasks.length > 0) {
        lines.push('## Orphaned Tasks (storyId matches no user story -- vanished silently)');
        lines.push('');
        for (const id of orphanedTasks) {
            lines.push(`- ${id}`);
        }
        lines.push('');
    }

    // Unassigned tasks
    if (unassignedTasks.length > 0) {
        lines.push('## Unassigned Tasks (not referenced in any assignment)');
        lines.push('');
        for (const id of unassignedTasks) {
            lines.push(`- ${id}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
