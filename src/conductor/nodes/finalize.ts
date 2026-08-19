/**
 * Finalize node — terminal phase that tears down containers, computes
 * final status, writes comprehensive summary artifacts, state snapshots,
 * run manifests, ledger entries, and run reports.
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { writeArtifact } from '../../agents/_shared/artifact';
import { writeOutputFile } from '../../utils/artifact-writer';
import { gitExec, findGitRoot } from '../../utils/git-exec';
import { tokenTracker } from '../../utils/token-tracker';
import { estimateCost } from '../../utils/cost';
import { MODEL_PRICING } from '../../config';
import { getThrottleStats, logThrottleStats } from '../../utils/llm-throttle';
import { getValidationStats, logValidationStats } from '../../utils/structured-output';
import { getContextStats } from '../context-builder';
import { getCumulativeCompactionStats } from '../../agents/_shared/history-compactor';
import { getTruncationStats } from '../../tools/_shared/truncate';
import { emitRunEvent, getAllEvents } from '../../utils/event-bus';
import { getBudgetStatus } from '../../utils/run-budget';
import { teardownDeployment } from '../devops-verify';
import { evaluateAcceptance, acceptanceReportToMarkdown, acceptanceBlockersToBugs } from '../acceptance-gate';
import { buildTraceabilityReport, renderTraceabilityMarkdown } from '../../utils/traceability';
import { writeStateSnapshot, writeRunManifest, countPRsByStatus, extractPhaseTimeline, renderPhaseTimeline } from '../../utils/run-snapshot';
import { appendLedger } from '../../utils/run-ledger';
import { checkInvariants } from '../run-invariants';
import { generateRunReport } from '../../utils/ledger-report';
import { generateRunDiagnosis } from '../../utils/run-diagnosis';
import { generateTokenReport } from '../../utils/token-report';
import { mdTable } from '../../utils/markdown-table';
import {
    RUN_FAIL_POLICY, DEVOPS_TEARDOWN, TRACEABILITY_JSON,
} from '../../config';
import { msg } from './_guards';
import type { ProjectStateType } from '../state';
import type { PhaseName } from '../../agents/_shared/base-schemas';
import type { DispatchRound } from '../gate-types';

const finalLog = getLogger('[Finalize]', 46);

export async function finalizeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'finalize' });
    finalLog.info('Finalizing run...');

    // ── Tear down containers started by deployment verification
    if (DEVOPS_TEARDOWN && state.runningContainers && state.runningContainers.length > 0) {
        try {
            await teardownDeployment(state.workspacePath, state.runningContainers);
            finalLog.info(`Tore down ${state.runningContainers.length} container(s)`);
        } catch (err: any) {
            finalLog.warn(`Container teardown failed: ${err.message}`);
        }
    }

    // ── Terminal status — the acceptance gate drives this (Plan 19 Sub-Plan 03)
    const acceptance = state.acceptance ?? evaluateAcceptance(state);
    type ManifestStatus = 'completed' | 'failed' | 'crashed' | 'cancelled' | 'partial' | 'inconclusive' | 'budget-exhausted';
    // Plan 25: use 'budget-exhausted' status when the run was stopped due to budget/provider failure
    const hasBudgetStop = state._stopReason?.startsWith('budget-exhausted') || state._stopReason?.startsWith('provider-');
    const finalStatus: ManifestStatus =
        hasBudgetStop                         ? 'budget-exhausted'
      : state.cancelled                      ? 'cancelled'
      : RUN_FAIL_POLICY === 'legacy'         ? 'completed'
      : acceptance.status === 'accepted'     ? 'completed'
      : acceptance.status === 'partial'      ? 'partial'
      : acceptance.status === 'inconclusive' ? 'inconclusive'
      :                                        'failed';
    tokenTracker.setRunStatus(finalStatus as any);
    if (hasBudgetStop) finalLog.warn(`Run stopped: ${state._stopReason} — state saved for continue-run.`);
    if (state.cancelled && !hasBudgetStop) finalLog.warn('Run was cancelled by HITL deny.');
    if (finalStatus === 'failed') finalLog.error(`Run FAILED — ${acceptance.blockers.length} blocker(s)`);
    if (finalStatus === 'partial') finalLog.warn(`Run PARTIAL — all required criteria passed but optional criteria failed`);
    if (finalStatus === 'inconclusive') finalLog.warn(`Run INCONCLUSIVE — some verifications could not execute`);

    // ── Token usage summary
    const usageSummary = tokenTracker.getRunSummary();
    const usageSnapshot = tokenTracker.getSnapshot();

    // Plan 25-04 §13: Wrap report-building in try/catch so that
    // writeStateSnapshot + writeRunManifest always execute in finally.
    let traceReport: ReturnType<typeof buildTraceabilityReport> | null = null;
    let filesDelivered = 0;
    let phantomFileChanges = 0;
    let prCounts = countPRsByStatus(state.pullRequests ?? []);
    const branchesSalvaged = (state.salvageBranches ?? []).length;
    const branchesNotAttempted = 0;
    const branchesDeferred = (state.dispatchRounds ?? []).filter((r: DispatchRound) => r.prs === 0 && r.fileChanges === 0).length;
    let allEvents = getAllEvents();
    let phaseTimeline = extractPhaseTimeline(allEvents);
    const budget = getBudgetStatus();

    try {

    // ── Count files actually on disk vs phantom file-change claims
    try {
        let gitRoot: string;
        try { gitRoot = findGitRoot(state.workspacePath); } catch { gitRoot = state.workspacePath; }
        const lsOut = gitExec(gitRoot, 'ls-files');
        if (!lsOut.startsWith('Error:')) {
            const onDisk = new Set(lsOut.split('\n').filter(Boolean));
            filesDelivered = onDisk.size;
            const claimedPaths = new Set(state.fileChanges.map(fc => fc.path));
            for (const p of claimedPaths) {
                if (!onDisk.has(p)) phantomFileChanges++;
            }
        }
    } catch { /* best-effort */ }

    const summary = [
        `System: ${state.input.systemName}`,
        `Status: ${finalStatus.toUpperCase()}`,
        `Architecture: ${state.architecture?.style} with ${state.architecture?.components?.length ?? 0} components`,
        `Stories: ${state.userStories.length}, Tasks: ${state.tasks.length}`,
        `Assignments: ${state.assignments.length}`,
        `Files delivered: ${filesDelivered}`,
        `Phantom file changes: ${phantomFileChanges}`,
        `Test reports: ${state.testReports.length}`,
        `Bugs: ${state.bugs.length}`,
        `Artifacts: ${state.artifacts.length}`,
        ``,
        `── Token Usage ──`,
        `Total LLM calls: ${usageSummary.totalCalls}`,
        `Total input tokens: ${usageSummary.totalInputTokens.toLocaleString()}`,
        `Total output tokens: ${usageSummary.totalOutputTokens.toLocaleString()}`,
        `Total tokens: ${usageSummary.totalTokens.toLocaleString()}`,
        `Estimated cost: see Token Usage Report for per-model breakdown`,
        ``,
        `── LLM Throttle ──`,
    ];
    const throttle = getThrottleStats();
    summary.push(
        `Requests: ${throttle.total}, rate-limited: ${throttle.rateLimited}, total cooldown: ${(throttle.cooldownMsTotal / 1000).toFixed(0)}s`,
    );
    summary.push('');
    summary.push(`── Output Validation ──`);
    const valStats = getValidationStats();
    summary.push(
        `Validated: ${valStats.validated}, repaired: ${valStats.repaired}, failed: ${valStats.failed}`,
    );
    summary.push('');
    summary.push(`── Context ──`);
    const ctxStats = getContextStats();
    const ctxPhases = Object.entries(ctxStats);
    if (ctxPhases.length > 0) {
        const totalCtx = ctxPhases.reduce((sum, [, chars]) => sum + chars, 0);
        summary.push(`Total context chars sent: ${totalCtx.toLocaleString()}`);
        for (const [phase, chars] of ctxPhases) {
            summary.push(`  ${phase}: ${chars.toLocaleString()} chars`);
        }
        summary.push(`Compact mode: enabled`);
    } else {
        summary.push('No context stats recorded');
    }
    summary.push('');
    summary.push(`── History Compaction ──`);
    const compaction = getCumulativeCompactionStats();
    if (compaction.invocations > 0) {
        summary.push(`Compaction invocations: ${compaction.invocations}`);
        summary.push(`Original chars: ${compaction.totalOriginalChars.toLocaleString()}`);
        summary.push(`Compacted chars: ${compaction.totalCompactedChars.toLocaleString()}`);
        summary.push(`Saved: ${compaction.savedChars.toLocaleString()} chars (${compaction.savedPct}%)`);
        summary.push(`Tool results stubbed: ${compaction.totalToolResultsStubbed}, write args stubbed: ${compaction.totalWriteArgsStubbed}`);
    } else {
        summary.push('No compaction events recorded');
    }
    const truncation = getTruncationStats();
    if (truncation.truncated > 0) {
        summary.push(`Tool results truncated: ${truncation.truncated}, chars removed: ${truncation.charsRemoved.toLocaleString()}`);
    }
    summary.push('');
    summary.push(`── Invocation Efficiency ──`);
    const invocationRows = tokenTracker.getInvocationSummaries();
    if (invocationRows.length > 0) {
        for (const r of invocationRows) {
            summary.push(
                `  ${r.agentId}: ${r.invocations} inv, ${r.avgCallsPerInvocation} calls/inv, ` +
                `avg ${r.avgInputPerCall} in/call, growth ${r.growthFactor}x` +
                (r.respawns > 0 ? `, ${r.respawns} respawns` : ''),
            );
        }
    } else {
        summary.push('No invocation data recorded');
    }
    summary.push('');
    summary.push(`── Budget ──`);
    summary.push(
        `Tokens: ${budget.usedTokens.toLocaleString()} / ${budget.maxTokens === 0 ? 'unlimited' : budget.maxTokens.toLocaleString()}`,
    );
    summary.push(
        `Estimated cost: $${budget.estCostUsd.toFixed(4)} / ${budget.maxCostUsd === 0 ? 'unlimited' : '$' + budget.maxCostUsd.toFixed(2)}`,
    );
    summary.push(
        `Wall clock: ${(budget.elapsedMs / 1000).toFixed(0)}s / ${budget.maxWallMs === 0 ? 'unlimited' : (budget.maxWallMs / 1000).toFixed(0) + 's'}`,
    );
    summary.push(
        `Final level: ${budget.level}, binding: ${budget.binding}, utilisation: ${(budget.utilisation * 100).toFixed(1)}%`,
    );

    // ── Requirements traceability (Sub-Plan 10)
    try {
        traceReport = buildTraceabilityReport(state);
        const t = traceReport.totals;
        summary.push('');
        summary.push(`── AC Coverage ──`);
        summary.push(
            `AC coverage: ${t.verified}/${t.criteria} verified (${(t.verifiedPct * 100).toFixed(0)}%), ` +
            `implemented ${(t.implementedPct * 100).toFixed(0)}%, delivery score ${t.deliveryScore.toFixed(2)}`,
        );
        summary.push(
            `  ${t.testedFailing} tested-failing, ${t.implemented} implemented-untested, ` +
            `${t.blocked} blocked, ${t.plannedOnly} planned-only, ${t.missing} missing`,
        );
        if (traceReport.orphanedStories.length > 0) {
            summary.push(`Orphaned stories: ${traceReport.orphanedStories.join(', ')}`);
        }
        if (traceReport.orphanedAssignments.length > 0) {
            summary.push(`Orphaned assignments: ${traceReport.orphanedAssignments.join(', ')}`);
        }
        if (traceReport.orphanedTasks.length > 0) {
            summary.push(`Orphaned tasks: ${traceReport.orphanedTasks.join(', ')}`);
        }
        if (traceReport.unassignedTasks.length > 0) {
            summary.push(`Unassigned tasks: ${traceReport.unassignedTasks.join(', ')}`);
        }
    } catch (traceErr: any) {
        finalLog.warn(`Traceability report failed (non-fatal): ${traceErr.message}`);
    }

    // Plan 25-04 §8: Add acceptance blockers and phase timeline BEFORE
    // building summaryText, so they appear in the summary artifact.

    // ── Acceptance blockers
    if (acceptance.blockers.length > 0) {
        summary.push('');
        summary.push(`── Acceptance Blockers ──`);
        for (const b of acceptance.blockers) {
            summary.push(`  - ${b}`);
        }
    }

    // ── PR & branch counters (Sub-Plan G1/G2)
    prCounts = countPRsByStatus(state.pullRequests ?? []);

    // ── Phase timeline (Sub-Plan G4)
    allEvents = getAllEvents();
    phaseTimeline = extractPhaseTimeline(allEvents);
    const timelineText = renderPhaseTimeline(phaseTimeline);
    if (timelineText) {
        summary.push('');
        summary.push(timelineText);
    }

    const summaryText = summary.join('\n');

    finalLog.info(`\n${summaryText}`);
    logThrottleStats();
    logValidationStats();

    // Write final summary artifact
    writeArtifact({
        agentId: 'conductor',
        colorCode: 46,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Run Summary',
        content: summaryText,
    });

    // ── Token usage report artifact
    let totalEstimatedCost = 0;
    for (const a of usageSummary.byAgent) {
        totalEstimatedCost += estimateCost(a.model, a.inputTokens, a.outputTokens);
    }

    const usageReportLines: string[] = [
        `# Token Usage Report`,
        ``,
        `**Run:** ${state.input.systemName}`,
        `**Date:** ${new Date().toISOString()}`,
        ``,
        `## Totals`,
        ``,
        mdTable(
            ['Metric', 'Value'],
            [
                ['Total LLM Calls', usageSummary.totalCalls],
                ['Input Tokens', usageSummary.totalInputTokens.toLocaleString()],
                ['Output Tokens', usageSummary.totalOutputTokens.toLocaleString()],
                ['**Total Tokens**', `**${usageSummary.totalTokens.toLocaleString()}**`],
                ['**Estimated Cost**', `**$${totalEstimatedCost.toFixed(4)}**`],
            ],
        ),
        ``,
        `## By Agent`,
        ``,
        mdTable(
            ['Agent', 'Model', 'Calls', 'Input', 'Output', 'Total', 'Est. Cost'],
            usageSummary.byAgent.map(a => {
                const cost = estimateCost(a.model, a.inputTokens, a.outputTokens);
                return [a.agentId, a.model, a.callCount, a.inputTokens.toLocaleString(), a.outputTokens.toLocaleString(), a.totalTokens.toLocaleString(), `$${cost.toFixed(4)}`];
            }),
            ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
        ),
        ``,
        `## By Phase`,
        ``,
        mdTable(
            ['Phase', 'Calls', 'Input', 'Output', 'Total'],
            usageSummary.byPhase.map(p => [p.phase, p.callCount, p.inputTokens.toLocaleString(), p.outputTokens.toLocaleString(), p.totalTokens.toLocaleString()]),
            ['left', 'right', 'right', 'right', 'right'],
        ),
        ``,
        `## By Model`,
        ``,
        mdTable(
            ['Model', 'Calls', 'Input', 'Output', 'Total', 'Est. Cost'],
            usageSummary.byModel.map(m => {
                const cost = estimateCost(m.model, m.inputTokens, m.outputTokens);
                return [m.model, m.callCount, m.inputTokens.toLocaleString(), m.outputTokens.toLocaleString(), m.totalTokens.toLocaleString(), `$${cost.toFixed(4)}`];
            }),
            ['left', 'right', 'right', 'right', 'right', 'right'],
        ),
        ``,
        `## Pricing Rates`,
        ``,
        mdTable(
            ['Model', 'Input ($/1K tokens)', 'Output ($/1K tokens)'],
            Object.entries(MODEL_PRICING).map(([model, pricing]: [string, any]) => [model, `$${pricing.inputPer1k.toFixed(4)}`, `$${pricing.outputPer1k.toFixed(4)}`]),
            ['left', 'right', 'right'],
        ),
    ];

    writeArtifact({
        agentId: 'conductor',
        colorCode: 220,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Token Usage Report',
        content: usageReportLines.join('\n'),
    });

    // ── Requirements traceability artifact (Sub-Plan 10)
    if (traceReport) {
        const traceMd = renderTraceabilityMarkdown(traceReport);
        writeArtifact({
            agentId: 'conductor',
            colorCode: 183,
            workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'Requirements Traceability Matrix',
            content: traceMd,
        });
        // Write to outputs/<run>/traceability.md
        const tracePath = writeOutputFile(state.outputPath, 'traceability.md', traceMd);
        if (tracePath) {
            finalLog.info(`Traceability matrix: ${tracePath}`);
        }
        // Write machine-readable outputs/<run>/traceability.json
        if (TRACEABILITY_JSON) {
            const traceJsonPath = writeOutputFile(state.outputPath, 'traceability.json', JSON.stringify(traceReport, null, 2));
            if (traceJsonPath) {
                finalLog.info(`Traceability JSON: ${traceJsonPath}`);
            }
        }
    }

    // ── HTML token usage report + raw JSON
    const { jsonPath, htmlPath } = generateTokenReport(
        usageSnapshot,
        state.outputPath,
        state.input.systemName,
        finalStatus,
    );
    finalLog.info(`Token usage JSON: ${jsonPath}`);
    finalLog.info(`Token usage HTML report: ${htmlPath}`);

    } catch (reportErr: any) {
        // Plan 25-04 §13: report generation crashed — log but continue
        finalLog.error(`Report generation failed (state will still be saved): ${reportErr.message}`);
    }

    // ── Write state snapshot and run manifest (guaranteed via §13)
    writeStateSnapshot(state.outputPath, state);
    const latestGR = state.latestGateReport;
    writeRunManifest(state.outputPath, state, finalStatus, {
        traceability: traceReport ? {
            criteria: traceReport.totals.criteria,
            verified: traceReport.totals.verified,
            implemented: traceReport.totals.implemented,
            missing: traceReport.totals.missing,
            coveragePct: traceReport.totals.verifiedPct,
            verifiedPct: traceReport.totals.verifiedPct,
            implementedPct: traceReport.totals.implementedPct,
            deliveryScore: traceReport.totals.deliveryScore,
            testedFailing: traceReport.totals.testedFailing,
            blocked: traceReport.totals.blocked,
            orphanedStories: traceReport.orphanedStories,
            orphanedAssignments: traceReport.orphanedAssignments,
            orphanedTasks: traceReport.orphanedTasks,
        } : undefined,
        acceptance: {
            status: acceptance.status,
            blockers: acceptance.blockers,
            criteria: acceptance.criteria.map(c => ({
                id: c.id,
                required: c.required,
                passed: c.passed,
                inconclusive: c.inconclusive,
                detail: c.detail,
            })),
            unrecoverable: acceptance.unrecoverable,
            unrecoverableReason: acceptance.unrecoverableReason,
        },
        verification: {
            gateReportPassed: latestGR?.passed,
            gateReportInconclusive: latestGR?.inconclusive,
            productVerifyPassed: latestGR?.productVerify?.passed,
            unresolvedReferences: latestGR?.productVerify?.resolveIssues.length,
            integrityFindings: (state.pullRequests ?? []).reduce((sum, pr) => sum + (pr.integrityFindings?.length ?? 0), 0),
        },
        phantomFileChanges,
        filesDelivered,
        prCounts,
        branchesSalvaged,
        branchesDeferred,
        branchesNotAttempted,
        phaseTimeline,
    });

    // ── Ledger: acceptance entry
    appendLedger({
        kind: 'acceptance',
        status: acceptance.status,
        blockers: acceptance.blockers,
        unrecoverable: acceptance.unrecoverable,
    });

    // ── Run invariants
    let invariantViolations: Array<{ id: string; phase: string; detail: string }> = [];
    try {
        invariantViolations = checkInvariants(state, 'finalize');
    } catch (err: any) {
        finalLog.warn(`Invariant check threw: ${err.message}`);
    }

    // ── Coverage ledger entry
    if (traceReport) {
        appendLedger({
            kind: 'coverage',
            verifiedPct: traceReport.totals.verifiedPct,
            implementedPct: traceReport.totals.implementedPct,
            deliveryScore: traceReport.totals.deliveryScore,
            missing: traceReport.totals.missing,
            blocked: traceReport.totals.blocked,
        });
    }

    // ── Plan funnel ledger entry
    {
        const assignedStoryIds = new Set<string>();
        for (const a of state.assignments) {
            assignedStoryIds.add(a.storyId);
            if ('additionalStoryIds' in a && Array.isArray((a as any).additionalStoryIds)) {
                for (const sid of (a as any).additionalStoryIds) assignedStoryIds.add(sid);
            }
        }
        const assignedTaskIds = new Set<string>();
        for (const a of state.assignments) {
            if ('taskIds' in a && Array.isArray((a as any).taskIds)) {
                for (const tid of (a as any).taskIds) assignedTaskIds.add(tid);
            }
        }
        const totalAc = state.userStories.reduce((sum, s) => sum + (s.acceptanceCriteria?.length ?? 0), 0);
        appendLedger({
            kind: 'plan-funnel',
            epics: state.epics.length,
            stories: state.userStories.length,
            criteria: totalAc,
            tasks: state.tasks.length,
            assignments: state.assignments.length,
            unassignedStories: state.userStories.map(s => s.id).filter(id => !assignedStoryIds.has(id)),
            unassignedTasks: state.tasks.map(t => t.id).filter(id => !assignedTaskIds.has(id)),
        });
    }

    // ── Generate run report from ledger
    appendLedger({ kind: 'phase', phase: 'finalize', event: 'end' });
    try {
        const reportPath = generateRunReport(state.outputPath, state.input.systemName);
        finalLog.info(`Run report: ${reportPath}`);
    } catch (err: any) {
        finalLog.warn(`Failed to generate run report: ${err.message}`);
    }

    // ── Run diagnosis (Sub-Plan G3)
    try {
        const logFilePath = fs.existsSync(path.join(state.outputPath, 'run.log'))
            ? path.join(state.outputPath, 'run.log')
            : undefined;
        const diagPath = generateRunDiagnosis(
            state.outputPath,
            usageSummary,
            budget,
            allEvents,
            logFilePath,
        );
        finalLog.info(`Run diagnosis: ${diagPath}`);
    } catch (err: any) {
        finalLog.warn(`Failed to generate run diagnosis: ${err.message}`);
    }

    // Status-aware final log line
    const statusLine = finalStatus === 'completed'
        ? `Run finished: COMPLETED — product accepted.`
        : finalStatus === 'failed'
        ? `Run finished: FAILED — ${acceptance.blockers.length} blocker(s). See outputs/<run>/run-manifest.json → acceptance.blockers`
        : finalStatus === 'partial'
        ? `Run finished: PARTIAL — required criteria passed, ${acceptance.criteria.filter(c => !c.required && !c.passed).length} optional criteria failed.`
        : finalStatus === 'inconclusive'
        ? `Run finished: INCONCLUSIVE — some verifications could not execute.`
        : `Run finished: ${finalStatus.toUpperCase()}`;

    emitRunEvent('phase:end', { phase: 'finalize', totalTokens: usageSummary.totalTokens, totalCalls: usageSummary.totalCalls, status: finalStatus });
    return {
        phase: 'finalize' as PhaseName,
        tokenUsage: usageSnapshot,
        transcript: [msg('conductor', 'finalize', statusLine)],
        invariantViolations,
    };
}
