/**
 * Acceptance Gate — the single place that answers "is this product acceptable?"
 *
 * Plan 19 Sub-Plan 03: truthful run status. Evaluates hard evidence from
 * Sub-Plans 01 (ProductVerifyReport, honest GateReport) and 02 (TamperFinding)
 * to determine whether the generated product meets acceptance criteria.
 *
 * Also detects when a run is unrecoverable — no further pipeline work can
 * plausibly change the outcome — so the pipeline can halt early instead of
 * burning another hour and $50 on a dead run.
 */
import { getLogger } from '../utils/logger';
import {
    ACCEPT_MIN_TESTS,
    ACCEPT_REQUIRE_SMOKE,
    ACCEPT_REQUIRE_E2E,
    MIN_AC_COVERAGE_PCT,
    MIN_AC_IMPLEMENTED_PCT,
    UNRECOVERABLE_ZERO_ROUNDS,
} from '../config';
import { buildTraceabilityReport, type CoverageTotals } from '../utils/traceability';
import type { ProjectStateType } from './state';
import type { GateReport } from './quality-gates';
import type { TamperFinding } from './gate-integrity';

const log = getLogger('[AcceptanceGate]', 214);

// ─── Types ──────────────────────────────────────────────────────────────────

export type AcceptanceStatus = 'accepted' | 'partial' | 'rejected' | 'inconclusive';

export interface AcceptanceCriterionResult {
    /** Criterion identifier. */
    id: string;
    label: string;
    required: boolean;
    passed: boolean;
    inconclusive: boolean;
    /** One-line detail, quotable in a report. */
    detail: string;
}

export interface AcceptanceReport {
    status: AcceptanceStatus;
    criteria: AcceptanceCriterionResult[];
    /** Ordered, human-readable list of what must be fixed. Goes in the manifest and the final log. */
    blockers: string[];
    /** True when no further pipeline work can plausibly change the outcome. */
    unrecoverable: boolean;
    unrecoverableReason?: string;
}

export interface DispatchRound {
    fileChanges: number;
    /** **Merged** PRs only. `PR-SKIPPED-*` placeholders (status `closed`, prNumber 0)
     *  are recorded for every no-commit branch and must never count as progress. */
    prs: number;
    completed: number;
}

// ─── Evaluate Acceptance ────────────────────────────────────────────────────

/**
 * Evaluate whether the generated product meets acceptance criteria.
 *
 * Uses the latest gate report, product verification, tamper findings,
 * traceability data, and test reports to produce a truthful assessment.
 */
export function evaluateAcceptance(state: ProjectStateType): AcceptanceReport {
    const criteria: AcceptanceCriterionResult[] = [];

    // ── Use latestGateReport (replace reducer) if available ──────────────
    const gateReport: GateReport | null = state.latestGateReport ?? null;

    // ── BUILD ────────────────────────────────────────────────────────────
    {
        let passed = false;
        let inconclusive = true;
        let detail = 'No gate report available';
        if (gateReport) {
            const buildResults = gateReport.results.filter(
                r => r.step === 'build' && r.mode !== 'absent' && !r.skipped,
            );
            if (buildResults.length > 0) {
                inconclusive = false;
                passed = buildResults.every(r => r.passed);
                if (!passed) {
                    const failed = buildResults.filter(r => !r.passed);
                    detail = `\`npm run build\` failed in \`${failed[0].relDir || '.'}\`: ${failed[0].output.slice(0, 200)}`;
                } else {
                    detail = `Build passed in ${buildResults.length} root(s)`;
                }
            } else {
                detail = 'No build step executed (absent or skipped)';
            }
        }
        criteria.push({ id: 'BUILD', label: 'Build passes', required: true, passed, inconclusive, detail });
    }

    // ── ARTIFACTS ────────────────────────────────────────────────────────
    {
        let passed = false;
        let inconclusive = true;
        let detail = 'No product verification report available';
        const pvr = gateReport?.productVerify ?? null;
        if (pvr) {
            inconclusive = false;
            const passedChecks = pvr.artifacts.filter(a => a.passed);
            passed = pvr.artifacts.length > 0 && pvr.artifacts.every(a => a.passed);
            if (!passed) {
                const failed = pvr.artifacts.filter(a => !a.passed);
                if (failed.length > 0) {
                    detail = `Artifact check failed: ${failed[0].reason}`;
                } else {
                    detail = 'No build artifacts found';
                }
            } else {
                detail = `${passedChecks.length} artifact check(s) passed`;
            }
        }
        criteria.push({ id: 'ARTIFACTS', label: 'Build artifacts exist', required: true, passed, inconclusive, detail });
    }

    // ── RESOLVE ──────────────────────────────────────────────────────────
    {
        let passed = false;
        let inconclusive = true;
        let detail = 'No product verification report available';
        const pvr = gateReport?.productVerify ?? null;
        if (pvr) {
            inconclusive = false;
            passed = pvr.resolveIssues.length === 0;
            if (!passed) {
                const first = pvr.resolveIssues[0];
                detail = `${pvr.resolveIssues.length} unresolved reference(s) — ${first.file}:${first.line} imports '${first.specifier}' (${first.reason})`;
            } else {
                detail = 'All imports and references resolve';
            }
        }
        criteria.push({ id: 'RESOLVE', label: 'Imports resolve', required: true, passed, inconclusive, detail });
    }

    // ── TESTS ────────────────────────────────────────────────────────────
    {
        let passed = false;
        let inconclusive = true;
        let detail = 'No test reports available';
        if (gateReport) {
            const testResults = gateReport.results.filter(
                r => r.step === 'test' && r.mode !== 'absent' && !r.skipped,
            );
            // Also check for real QA test reports
            const realTestReports = (state.testReports ?? []).filter(
                r => r.type === 'unit' || r.type === 'integration',
            );
            const totalExecuted = realTestReports.reduce((sum, r) => sum + r.total, 0);
            if (testResults.length > 0 || totalExecuted > 0) {
                inconclusive = false;
                const failedGates = testResults.filter(r => !r.passed);
                const failedReports = realTestReports.filter(r => r.status === 'fail');
                passed = failedGates.length === 0
                    && failedReports.length === 0
                    && totalExecuted >= ACCEPT_MIN_TESTS;
                if (failedGates.length > 0) {
                    detail = `Test gate failed: ${failedGates[0].output.slice(0, 200)}`;
                } else if (failedReports.length > 0) {
                    detail = `${failedReports.reduce((sum, r) => sum + r.failed, 0)} test(s) failed`;
                } else if (totalExecuted < ACCEPT_MIN_TESTS) {
                    detail = `Only ${totalExecuted} test(s) executed, minimum is ${ACCEPT_MIN_TESTS}`;
                } else {
                    detail = `${totalExecuted} test(s) passed`;
                }
            } else {
                detail = 'No test runner executed; 0 tests found';
            }
        }
        criteria.push({ id: 'TESTS', label: 'Tests pass', required: true, passed, inconclusive, detail });
    }

    // ── SMOKE ────────────────────────────────────────────────────────────
    {
        let passed = false;
        let inconclusive = true;
        let detail = 'No smoke test result available';
        const pvr = gateReport?.productVerify ?? null;
        if (pvr?.smoke) {
            if (!pvr.smoke.ran && pvr.smoke.skippedReason === 'no web root detected') {
                // Not a web product — smoke is not applicable
                passed = true;
                inconclusive = false;
                detail = 'Skipped (no web root detected)';
            } else if (pvr.smoke.ran) {
                inconclusive = false;
                passed = pvr.smoke.passed;
                if (!passed) {
                    detail = `Smoke test failed: ${pvr.smoke.reason}`;
                } else {
                    detail = `Smoke test passed (HTTP ${pvr.smoke.httpStatus}, ${pvr.smoke.bodyBytes} bytes)`;
                }
            }
        }
        criteria.push({
            id: 'SMOKE',
            label: 'Smoke test',
            required: ACCEPT_REQUIRE_SMOKE,
            passed,
            inconclusive,
            detail,
        });
    }

    // ── INTEGRITY ────────────────────────────────────────────────────────
    {
        let passed = true;
        let inconclusive = false;
        let detail = 'No tampering detected';
        // Check configBaseline for tamper findings
        // TamperFindings are surfaced as bugs with id prefix 'TAMPER-'
        const tamperBugs = (state.bugs ?? []).filter(b => b.id.startsWith('TAMPER-'));
        const criticalTamperBugs = tamperBugs.filter(b => b.severity === 'critical');
        if (criticalTamperBugs.length > 0) {
            passed = false;
            detail = `${criticalTamperBugs.length} critical tamper finding(s): ${criticalTamperBugs[0].title}`;
        } else if (tamperBugs.length > 0) {
            detail = `${tamperBugs.length} non-critical tamper finding(s)`;
        }
        criteria.push({ id: 'INTEGRITY', label: 'Gate integrity', required: true, passed, inconclusive, detail });
    }

    // ── SCOPE (Sub-Plan 04) ────────────────────────────────────────────
    // Check that every user story has at least one assignment whose branch
    // merged. Uses additionalStoryIds when present.
    {
        let passed = true;
        let inconclusive = false;
        let detail = 'All stories have assignments';
        const stories = state.userStories ?? [];
        const assignments = state.assignments ?? [];
        const mergedPrs = (state.pullRequests ?? []).filter(pr => pr.status === 'merged');
        const mergedBranches = new Set(mergedPrs.map(pr => pr.branchName));

        if (stories.length === 0) {
            inconclusive = true;
            detail = 'No user stories to evaluate';
        } else {
            // Check which stories have at least one assignment with a merged PR
            const storyIdsWithMerge = new Set<string>();
            for (const a of assignments) {
                // Check if any merged PR matches this assignment's branch
                const ba = (state.branchAssignments ?? []).find(
                    b => b.assignmentIds.includes(a.id) && mergedBranches.has(b.branchName),
                );
                if (ba) {
                    if (a.storyId) storyIdsWithMerge.add(a.storyId);
                    // Also mark additionalStoryIds as covered (Sub-Plan 04)
                    for (const sid of a.additionalStoryIds ?? []) {
                        storyIdsWithMerge.add(sid);
                    }
                }
            }
            const orphanedStories = stories.filter(s => !storyIdsWithMerge.has(s.id));
            if (orphanedStories.length > 0) {
                passed = false;
                detail = `${orphanedStories.length} of ${stories.length} user stories have no merged assignment (${orphanedStories.slice(0, 5).map(s => s.id).join(', ')}${orphanedStories.length > 5 ? '...' : ''})`;
            }

            // Also surface plan violations from the TL phase
            const planViolations = state.planViolations ?? [];
            const criticalViolations = planViolations.filter(v => v.severity === 'critical');
            if (criticalViolations.length > 0 && passed) {
                // Don't fail the gate (development may have proceeded) but annotate
                detail += ` (warning: ${criticalViolations.length} planning violation(s) were detected after TL phase)`;
            }
        }
        criteria.push({ id: 'SCOPE', label: 'Story coverage', required: true, passed, inconclusive, detail });
    }

    // ── AC_COVERAGE (Sub-Plan 10) ──────────────────────────────────────
    {
        const required = MIN_AC_COVERAGE_PCT > 0;
        let passed = !required;
        let inconclusive = false;
        let detail = 'AC coverage gate disabled (MIN_AC_COVERAGE_PCT=0)';

        if (required) {
            try {
                const traceReport = buildTraceabilityReport(state);
                const t = traceReport.totals;
                const vPct = t.verifiedPct * 100;
                const iPct = t.implementedPct * 100;

                const verifiedOk = vPct >= MIN_AC_COVERAGE_PCT;
                const implementedOk = MIN_AC_IMPLEMENTED_PCT <= 0 || iPct >= MIN_AC_IMPLEMENTED_PCT;
                passed = verifiedOk && implementedOk;

                if (!passed) {
                    const parts: string[] = [];
                    if (!verifiedOk) parts.push(`verified ${vPct.toFixed(0)}% < ${MIN_AC_COVERAGE_PCT}%`);
                    if (!implementedOk) parts.push(`implemented ${iPct.toFixed(0)}% < ${MIN_AC_IMPLEMENTED_PCT}%`);
                    detail = `AC coverage below threshold: ${parts.join(', ')} (${t.missing} missing, ${t.testedFailing} failing)`;
                } else {
                    detail = `AC coverage: verified ${vPct.toFixed(0)}%, implemented ${iPct.toFixed(0)}%, delivery score ${t.deliveryScore.toFixed(2)}`;
                }
            } catch (err: any) {
                inconclusive = true;
                detail = `AC coverage gate crashed: ${err.message}`;
            }
        }

        criteria.push({ id: 'AC_COVERAGE', label: 'AC coverage', required, passed, inconclusive, detail });
    }

    // ── DEPLOY ───────────────────────────────────────────────────────────
    {
        let passed = false;
        let inconclusive = true;
        let detail = 'No deployment data available';
        if (state.devopsPlan) {
            inconclusive = false;
            if (state.devopsPlan.buildStatus === 'success') {
                passed = true;
                detail = 'Deployment build succeeded';
            } else if (state.devopsPlan.buildStatus === 'pending') {
                // Not yet built — treat as non-blocking
                passed = true;
                detail = 'Deployment build pending';
            } else {
                detail = `Deployment build status: ${state.devopsPlan.buildStatus}`;
            }
        }
        criteria.push({ id: 'DEPLOY', label: 'Deployment', required: false, passed, inconclusive, detail });
    }

    // ── E2E (Sub-Plan 11: uses e2eStatus state channel) ────────────────
    {
        const e2eStatus = state.e2eStatus ?? 'not-run';
        let passed = false;
        let inconclusive = false;
        let detail = 'E2E not run';

        // Determine whether a web root exists to know if skipping is acceptable
        const hasWebRoot = (state.latestGateReport?.roots ?? []).some(
            r => r.stack === 'node' || r.stack === 'python',
        );

        switch (e2eStatus) {
            case 'passed':
                passed = true;
                detail = 'E2E tests passed';
                // Augment with report counts if available
                { const e2eReports = (state.testReports ?? []).filter(r => r.type === 'e2e');
                  if (e2eReports.length > 0) {
                      detail = `${e2eReports.reduce((s, r) => s + r.passed, 0)} E2E test(s) passed`;
                  }
                }
                break;
            case 'failed':
                passed = false;
                detail = `E2E tests failed`;
                { const e2eReports = (state.testReports ?? []).filter(r => r.type === 'e2e' && r.status === 'fail');
                  if (e2eReports.length > 0) {
                      detail = `${e2eReports.reduce((s, r) => s + r.failed, 0)} E2E test(s) failed`;
                  }
                }
                break;
            case 'skipped-no-services':
                // If no web root, skipping is acceptable (not a web project)
                passed = !hasWebRoot;
                detail = hasWebRoot
                    ? 'E2E skipped (no services) but web root exists — we could have tested and did not'
                    : 'E2E skipped (no services, no web root — not applicable)';
                break;
            case 'skipped-disabled':
                passed = true;
                detail = 'E2E disabled by configuration';
                break;
            case 'error':
                passed = false;
                inconclusive = true;
                detail = `E2E infrastructure error: ${state.e2eSkipReason ?? 'unknown'}`;
                break;
            case 'not-run':
            default:
                inconclusive = true;
                detail = 'E2E has not run';
                break;
        }

        criteria.push({ id: 'E2E', label: 'E2E tests', required: ACCEPT_REQUIRE_E2E, passed, inconclusive, detail });
    }

    // ── Check for verification errors that make criteria inconclusive ────
    const verificationErrors = state.verificationErrors ?? [];
    for (const ve of verificationErrors) {
        const criterion = criteria.find(c =>
            (ve.stage === 'quality-gates' && (c.id === 'BUILD' || c.id === 'TESTS'))
            || (ve.stage === 'security-gates' && c.id === 'INTEGRITY')
            || (ve.stage === 'ac-coverage' && c.id === 'AC_COVERAGE')
            || (ve.stage === 'qa-lead' && c.id === 'TESTS')
            || (ve.stage === 'qa-unit' && c.id === 'TESTS')
            || (ve.stage === 'devops' && c.id === 'DEPLOY')
            || (ve.stage === 'e2e' && c.id === 'E2E'),
        );
        if (criterion && !criterion.passed) {
            criterion.inconclusive = true;
            criterion.detail = `Verification crashed: ${ve.message}`;
        }
    }

    // ── Derive status ───────────────────────────────────────────────────
    const requiredCriteria = criteria.filter(c => c.required);
    const optionalCriteria = criteria.filter(c => !c.required);

    const anyRequiredFailed = requiredCriteria.some(c => !c.passed && !c.inconclusive);
    const anyRequiredInconclusive = requiredCriteria.some(c => c.inconclusive && !c.passed);
    const anyOptionalFailed = optionalCriteria.some(c => !c.passed && !c.inconclusive);

    let status: AcceptanceStatus;
    if (anyRequiredFailed) {
        status = 'rejected';
    } else if (anyRequiredInconclusive) {
        status = 'inconclusive';
    } else if (anyOptionalFailed) {
        status = 'partial';
    } else {
        status = 'accepted';
    }

    // ── Build blockers list ─────────────────────────────────────────────
    const blockers: string[] = [];
    for (const c of criteria) {
        if (!c.passed && !c.inconclusive) {
            blockers.push(`${c.id}: ${c.detail}`);
        }
    }
    for (const c of criteria) {
        if (c.inconclusive && !c.passed) {
            blockers.push(`${c.id} (inconclusive): ${c.detail}`);
        }
    }

    // ── Unrecoverability ────────────────────────────────────────────────
    const { unrecoverable, reason } = detectUnrecoverable(state);

    const report: AcceptanceReport = {
        status,
        criteria,
        blockers,
        unrecoverable,
        unrecoverableReason: reason,
    };

    return report;
}

// ─── Unrecoverability Detection ─────────────────────────────────────────────

/**
 * A run is unrecoverable when no remaining pipeline work can plausibly
 * change the outcome. Detecting this early prevents the 20-37 minute
 * zero-output dispatch rounds observed in both post-mortem runs.
 */
export function detectUnrecoverable(
    state: ProjectStateType,
): { unrecoverable: boolean; reason?: string } {
    // 1. Zero-progress dispatch: N consecutive rounds with 0 file changes AND 0 merged PRs
    const rounds = state.dispatchRounds ?? [];
    if (rounds.length >= UNRECOVERABLE_ZERO_ROUNDS) {
        const tail = rounds.slice(-UNRECOVERABLE_ZERO_ROUNDS);
        const allZero = tail.every(r => r.fileChanges === 0 && r.prs === 0);
        if (allZero) {
            return {
                unrecoverable: true,
                reason: `${UNRECOVERABLE_ZERO_ROUNDS} consecutive dispatch rounds produced no file changes and no merged PRs`,
            };
        }
    }

    // 2. Permanently blocked branch — PR open with merge conflicts and re-dispatch failed >= 2 times
    // Match on error strings until Sub-Plan 06 adds proper error classification
    const openPrs = (state.pullRequests ?? []).filter(pr => pr.status === 'open');
    const conflictErrors = (state.transcript ?? []).filter(t =>
        t.message.includes('merge conflicts') || t.message.includes('A pull request already exists'),
    );
    if (openPrs.length > 0 && conflictErrors.length >= 2) {
        return {
            unrecoverable: true,
            reason: `Branch ${openPrs[0].branchName} has unresolved merge conflicts and re-dispatch has failed ${conflictErrors.length} times`,
        };
    }

    // 3. Sourceless workspace after development — nothing to test, deploy, or verify
    // Check if past the development phase
    const pastDev = ['qa', 'bugfix-triage', 'devops', 'e2e', 'acceptance-gate', 'finalize'].includes(state.phase);
    if (pastDev && state.fileChanges.length === 0 && (state.pullRequests ?? []).filter(pr => pr.status === 'merged').length === 0) {
        return {
            unrecoverable: true,
            reason: 'Workspace appears sourceless after development — no file changes and no merged PRs',
        };
    }

    // 4. Scaffold never landed — no stack root would be detected
    // (checked at the development node level via looksSourceless — this is the state-level check)

    // 5. All required acceptance criteria failed twice with identical blocker set
    // This is checked by comparing bugAttempts — a bug attempted >= 2 times and still present
    const bugAttempts = state.bugAttempts ?? {};
    const multiAttemptBugs = Object.entries(bugAttempts).filter(([, count]) => count >= 2);
    if (multiAttemptBugs.length > 0) {
        // Check if these bugs are still open (not fixed)
        const fixedSet = new Set(state.fixedBugIds ?? []);
        const stillOpen = multiAttemptBugs.filter(([id]) => !fixedSet.has(id));
        const acceptanceBugs = stillOpen.filter(([id]) => id.startsWith('ACCEPT-') || id.startsWith('GATE-'));
        if (acceptanceBugs.length >= 3) {
            return {
                unrecoverable: true,
                reason: `${acceptanceBugs.length} acceptance/gate bugs have been attempted ${acceptanceBugs[0][1]}+ times and remain unresolved: ${acceptanceBugs.slice(0, 3).map(([id]) => id).join(', ')}`,
            };
        }
    }

    return { unrecoverable: false };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Small shared helper: check if the run should halt early due to
 * unrecoverability under `RUN_FAIL_POLICY='halt'`. Returns a partial state
 * update that skips the node, or null if the node should proceed normally.
 */
export function haltIfUnrecoverable(
    state: ProjectStateType,
    nodeLog: ReturnType<typeof getLogger>,
    failPolicy: string,
): Partial<ProjectStateType> | null {
    if (failPolicy !== 'halt') return null;
    if (!state.unrecoverable?.flag) return null;

    nodeLog.warn(`Run is unrecoverable (${state.unrecoverable.reason}) and RUN_FAIL_POLICY=halt — skipping to finalize`);
    return {};
}

/**
 * Convert acceptance blockers into Bug objects with stable ids for the
 * bugfix loop. Each blocker gets an `ACCEPT-<criterionId>` id.
 */
export function acceptanceBlockersToBugs(report: AcceptanceReport): Array<{
    id: string;
    title: string;
    severity: 'critical' | 'major';
    stepsToReproduce: string;
    expectedBehavior: string;
    actualBehavior: string;
    suspectedArea: string;
    reportedBy: string;
}> {
    return report.criteria
        .filter(c => !c.passed && !c.inconclusive && c.required)
        .map(c => ({
            id: `ACCEPT-${c.id}`,
            title: `Acceptance criterion failed: ${c.label}`,
            severity: 'critical' as const,
            stepsToReproduce: `Run the acceptance gate — criterion ${c.id} fails`,
            expectedBehavior: `${c.label} should pass`,
            actualBehavior: c.detail,
            suspectedArea: c.id === 'BUILD' ? 'package.json / source code'
                : c.id === 'RESOLVE' ? 'import/require statements'
                : c.id === 'TESTS' ? 'test files and runner'
                : c.id === 'ARTIFACTS' ? 'build output directory'
                : c.id === 'SMOKE' ? 'web application entry point'
                : c.id === 'INTEGRITY' ? 'gate configuration files'
                : c.id === 'DEPLOY' ? 'Dockerfile / docker-compose.yml'
                : c.id === 'E2E' ? 'E2E test setup / Playwright MCP'
                : 'general',
            reportedBy: 'acceptance-gate',
        }));
}

/**
 * Render an acceptance report as a Markdown document for the artifacts directory.
 */
export function acceptanceReportToMarkdown(report: AcceptanceReport): string {
    const lines: string[] = [
        `# Acceptance Report`,
        ``,
        `**Status:** ${report.status.toUpperCase()}`,
    ];
    if (report.unrecoverable) {
        lines.push(`**Unrecoverable:** ${report.unrecoverableReason}`);
    }
    lines.push('');
    lines.push('## Criteria');
    lines.push('');
    lines.push('| Criterion | Required | Passed | Detail |');
    lines.push('|-----------|----------|--------|--------|');
    for (const c of report.criteria) {
        const passIcon = c.inconclusive ? '?' : c.passed ? 'Yes' : 'No';
        lines.push(`| ${c.id} — ${c.label} | ${c.required ? 'Yes' : 'No'} | ${passIcon} | ${c.detail} |`);
    }
    if (report.blockers.length > 0) {
        lines.push('');
        lines.push('## Blockers');
        lines.push('');
        for (const b of report.blockers) {
            lines.push(`- ${b}`);
        }
    }
    return lines.join('\n');
}
