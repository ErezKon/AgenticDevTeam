/**
 * AC coverage gate (Sub-Plan 10), moved out of `qaNode` in Plan 30-03.
 *
 * In the claudeopus5 run this gate produced 25 of QA's 63 false bugs per round:
 * the test runner had failed, so every merged criterion looked
 * "implemented-untested", and each criterion of the blocked PR became its own
 * "PR blocked/conflicted" bug.
 *  - The gate is `inconclusive`, with no bugs, when a test runner failed or could
 *    not name its cases: a criterion without a passing test is then unmeasured,
 *    not untested.
 *  - `planned-only` criteria (work not merged yet) never produce bugs.
 *  - A blocked PR produces one bug carrying its real blockers, not one per criterion.
 */
import { makeGateBug } from './bug-factory';
import { blockedPrBug } from './review-policy';
import { MIN_AC_COVERAGE_PCT, MIN_AC_IMPLEMENTED_PCT, MIN_AC_COVERAGE_MAX_BUGS } from '../config';
import type { TraceabilityReport, TraceRow } from '../utils/traceability';
import type { ExecutedTestReport } from './test-runners/executed-report';
import type { Bug, TestReport } from '../agents/_shared/base-schemas';

export interface AcCoverageGateResult {
    status: 'pass' | 'fail' | 'inconclusive';
    /** The `ac-coverage` signal for `testReports` (`source: 'quality-gates'`). */
    testReport: TestReport;
    bugs: Bug[];
    /** One line for the log and the transcript. */
    summary: string;
}

/** Why the executed runs cannot measure AC coverage, or null when they can. */
function unmeasuredReason(executed: ExecutedTestReport[]): string | null {
    if (executed.some(e => e.runnerError)) return 'a test runner failed';
    if (executed.some(e => e.caseNames === 'unavailable')) return 'test case names are unavailable';
    return null;
}

function acBug(row: TraceRow): Bug {
    return makeGateBug(
        `AC-${row.storyId}-${row.acIndex}`,
        `Acceptance criterion not verified: ${row.storyId} AC#${row.acIndex}`,
        'critical',
        'ac-coverage-gate',
        `Story ${row.storyId}, AC#${row.acIndex}: "${row.acText}"`,
        `A test named "[${row.storyId}#${row.acIndex}] ..." exists, is executed, and passes`,
        `Status "${row.status}" — ${
            row.status === 'missing' ? 'no assignment references this story'
            : row.status === 'tested-failing' ? 'test exists but fails'
            : 'code merged but no tagged test executed'}`,
        row.assignmentIds[0] ? `Assignment ${row.assignmentIds[0]}` : `Story ${row.storyId}`,
    );
}

/**
 * Evaluate AC coverage against `MIN_AC_COVERAGE_PCT` / `MIN_AC_IMPLEMENTED_PCT`.
 * Bugs are gap-first — missing, tested-failing, blocked PRs, implemented-untested —
 * capped at `MIN_AC_COVERAGE_MAX_BUGS`.
 */
export function evaluateAcCoverageGate(
    trace: TraceabilityReport,
    executed: ExecutedTestReport[],
    iterationIndex: number,
): AcCoverageGateResult {
    const t = trace.totals;
    const vPct = t.verifiedPct * 100;
    const iPct = t.implementedPct * 100;
    const reason = unmeasuredReason(executed);
    const coverageOk = vPct >= MIN_AC_COVERAGE_PCT && (MIN_AC_IMPLEMENTED_PCT <= 0 || iPct >= MIN_AC_IMPLEMENTED_PCT);
    const status = reason ? 'inconclusive' : coverageOk ? 'pass' : 'fail';
    const testReport: TestReport = {
        type: 'unit', framework: 'ac-coverage', source: 'quality-gates',
        total: t.criteria, passed: t.verified, failed: t.criteria - t.verified, skipped: 0,
        status, iterationIndex, runnerError: false, failures: [], agentId: 'ac-coverage-gate', cases: [],
    };
    const measured = `verified ${vPct.toFixed(0)}%, implemented ${iPct.toFixed(0)}%, delivery ${t.deliveryScore.toFixed(2)}`;
    if (status === 'inconclusive') {
        return { status, testReport, bugs: [], summary: `AC coverage gate INCONCLUSIVE: ${reason}, so untested criteria are unmeasured (${measured}) — no bugs` };
    }
    if (status === 'pass') {
        return { status, testReport, bugs: [], summary: `AC coverage gate passed: ${measured} (thresholds ${MIN_AC_COVERAGE_PCT}% / ${MIN_AC_IMPLEMENTED_PCT}%)` };
    }

    const rowsWith = (s: TraceRow['status']): TraceRow[] => trace.rows.filter(r => r.status === s);
    const blockedBranches = new Set(rowsWith('blocked').flatMap(r => r.branchNames));
    const prBugs = trace.blockedDeliveries
        .filter(d => d.status !== 'deferred' && blockedBranches.has(d.branchName))
        .map(d => blockedPrBug(d.branchName, d.prNumber, [d.reason]));
    const gaps = trace.rows.filter(r => r.status !== 'verified' && r.status !== 'planned-only').length;
    const bugs = [
        ...rowsWith('missing').map(acBug),
        ...rowsWith('tested-failing').map(acBug),
        ...prBugs,
        ...rowsWith('implemented-untested').map(acBug),
    ].slice(0, MIN_AC_COVERAGE_MAX_BUGS);
    return { status, testReport, bugs, summary: `AC coverage gate FAILED: ${measured} — ${bugs.length} bug(s) for ${gaps} gap(s)` };
}
