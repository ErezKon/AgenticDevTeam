/**
 * QA node — test planning, test execution, quality gates,
 * security gates, and AC coverage verification.
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { createQaLeadAgent, createQaUnitAgent } from '../../agents/qa/qa.agents';
import { writeArtifact } from '../../agents/_shared/artifact';
import { deployConventionsToWorkspace, resolveConventionFiles } from '../../utils/coding-conventions';
import { gitExec, findGitRoot } from '../../utils/git-exec';
import { syncWorkspaceToBranch } from '../workspace-sync';
import { detectStackRoots, runQualityGates, gateReportToTestReport, synthesiseGateBugs } from '../quality-gates';
import { runTests, type ExecutedTestReport, executedToTestReports, compareClaimVsReality, type ClaimDiscrepancy } from '../test-runner';
import { detectTrivialTests } from '../gate-integrity';
import { checkTestSufficiency, sufficiencyViolationsToBugs } from '../test-sufficiency';
import { runSecurityGates, synthesiseSecurityBugs, securityReportToMarkdown } from '../security-gates';
import { runProductVerification } from '../product-verify';
import { buildTraceabilityReport } from '../../utils/traceability';
import { makeGateBug } from '../bug-factory';
import {
    CONTEXT_MAX_CHARS, QA_MODEL, QA_TEST_TIMEOUT_MS,
    TOOL_PIPELINE_RECURSION_LIMIT, SECURITY_GATE_BLOCKING,
    MIN_AC_COVERAGE_PCT, MIN_AC_IMPLEMENTED_PCT, MIN_AC_COVERAGE_MAX_BUGS,
} from '../../config';
import { QaLeadOutputSchema, QaUnitOutputSchema } from '../../agents/qa/schemas/qa-output.schema';
import {
    summariseArchitecture, summariseTechStack, summariseDbDesign,
    summariseCodebaseAnalysis, buildContext, recordContextChars,
} from '../context-builder';
import type { ContextSection } from '../context-builder';
import { storiesForIds } from '../context-builder';
import { emitRunEvent } from '../../utils/event-bus';
import type { TokenCallRecord } from '../../utils/token-tracker';
import { phaseNode, msg } from './_guards';
import { invokeAgent } from './_invoke';
import { commitAndPushArtifacts } from './_git-helpers';
import type { ProjectStateType } from '../state';
import type { PhaseName, TranscriptMessage, Bug, TestReport } from '../../agents/_shared/base-schemas';

const qaLog = getLogger('[QA Lead]', 198);

export const qaNode = phaseNode('qa', qaLog, { haltCheck: true }, async (state, { rerunUpdate }) => {
    qaLog.info('Starting QA phase...');
    const apiKey = await getAccessToken();
    const transcript: TranscriptMessage[] = [];
    const allBugs: Bug[] = [];

    // ── Sync workspace before QA (idempotent — protects HITL resume)
    let qaGitRoot: string;
    try {
        qaGitRoot = findGitRoot(state.workspacePath);
    } catch {
        qaGitRoot = state.workspacePath;
    }
    const qaSyncResult = await syncWorkspaceToBranch(qaGitRoot, state.systemBranch, state.gitContext);
    qaLog.info(`Workspace synced to origin/${state.systemBranch}: ${qaSyncResult.details}`);

    // Deploy only the convention files QA agents need (fixes A11)
    const qaConventionFiles = resolveConventionFiles([], state.techStack);
    deployConventionsToWorkspace(state.workspacePath, qaConventionFiles);

    // 7a. QA Lead — create test plan
    qaLog.info('QA Lead creating test plan...');
    const qaTokenUsage: TokenCallRecord[] = [];
    let leadOutput: any = { testPlan: { unit: [], integration: [], e2e: [] } };
    let leadArtifact: any = null;
    try {
        const qaLeadAgent = createQaLeadAgent(apiKey);
        let leadMsg: string;
        {
            const sections: ContextSection[] = [
                { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
                { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
                { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
                { title: 'User Stories with Acceptance Criteria', body: storiesForIds(state.userStories, state.userStories.map(s => s.id)).text, priority: 1 },
            ];
            leadMsg = buildContext(sections, CONTEXT_MAX_CHARS);
        }
        qaLog.info(`Context [qa-lead]: ${leadMsg.length} chars`);
        recordContextChars('qa', leadMsg.length);
        const r = await invokeAgent(qaLeadAgent, leadMsg, 'qa-lead', 'qa-lead', 'qa', { schema: QaLeadOutputSchema });
        leadOutput = r.output;
        if (r.tokenUsage) qaTokenUsage.push(r.tokenUsage);
        qaLog.info(`Test plan: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`);

        leadArtifact = writeArtifact({
            agentId: 'qa-lead', colorCode: 198, workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'QA Lead — Test Plan',
            content: `## Test Plan\n\n${JSON.stringify(leadOutput.testPlan, null, 2)}`,
        });
        transcript.push(msg('qa-lead', 'qa', `Test plan created: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`));

        // Sub-Plan 10 §6: deterministic check — does the plan cover every AC?
        if (leadOutput.testPlan) {
            const planItems = [
                ...(leadOutput.testPlan.unit ?? []),
                ...(leadOutput.testPlan.integration ?? []),
                ...(leadOutput.testPlan.e2e ?? []),
            ];
            const coveredAcs = new Set<string>();
            for (const item of planItems) {
                if (item.storyId) {
                    if ((item.acIndex ?? -1) === -1) {
                        const story = (state.userStories ?? []).find(s => s.id === item.storyId);
                        if (story) {
                            for (let i = 0; i < (story.acceptanceCriteria?.length ?? 0); i++) {
                                coveredAcs.add(`${item.storyId}:${i}`);
                            }
                        }
                    } else {
                        coveredAcs.add(`${item.storyId}:${item.acIndex}`);
                    }
                }
            }
            const uncoveredAcs: Array<{ storyId: string; acIndex: number; acText: string }> = [];
            for (const story of state.userStories ?? []) {
                for (let i = 0; i < (story.acceptanceCriteria?.length ?? 0); i++) {
                    if (!coveredAcs.has(`${story.id}:${i}`)) {
                        uncoveredAcs.push({ storyId: story.id, acIndex: i, acText: story.acceptanceCriteria![i] });
                    }
                }
            }
            if (uncoveredAcs.length > 0) {
                qaLog.warn(`QA plan missing ${uncoveredAcs.length} AC(s) — recording QA-PLAN-GAP bugs`);
                const planGapBugs: Bug[] = uncoveredAcs.slice(0, 15).map(gap => makeGateBug(
                    `QA-PLAN-GAP-${gap.storyId}-${gap.acIndex}`,
                    `QA plan omits AC: ${gap.storyId} AC#${gap.acIndex}`,
                    'major',
                    'qa-plan-coverage',
                    `Story ${gap.storyId}, AC#${gap.acIndex}: "${gap.acText}"`,
                    `QA test plan should include at least one item for this criterion`,
                    `No test plan item references ${gap.storyId} AC#${gap.acIndex}`,
                    `Story ${gap.storyId}`,
                ));
                allBugs.push(...planGapBugs);
            }
        }
    } catch (err: any) {
        const providerBody = err?.error ? JSON.stringify(err.error) : (err?.response?.data ? JSON.stringify(err.response.data) : '');
        qaLog.error(`QA Lead failed [model=${QA_MODEL}${err?.status ? `, status=${err.status}` : ''}]: ${err.message}${providerBody ? ` | provider: ${providerBody}` : ''}`);
        if (err?.stack) qaLog.error(err.stack);
        transcript.push(msg('qa-lead', 'qa', `QA Lead failed [model=${QA_MODEL}]: ${err.message}`));
    }

    // 7b. QA Unit — write & run unit/integration tests
    qaLog.info('QA Unit writing and running tests...');
    let unitOutput: any = { testReport: null, bugs: [], fileChanges: [] };
    let unitArtifact: any = null;
    const qaUnitErrors: Array<{ stage: string; message: string }> = [];
    const qaLeadFailed = !leadOutput?.testPlan?.unit;
    try {
        const qaUnitAgent = createQaUnitAgent(apiKey, state.workspacePath, qaConventionFiles);
        let unitMsg: string;
        {
            const sections: ContextSection[] = [
                { title: 'Test Plan (unit + integration)', body: JSON.stringify({ unit: leadOutput.testPlan?.unit ?? [], integration: leadOutput.testPlan?.integration ?? [] }, null, 2), priority: 1 },
                { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
                { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            ];
            unitMsg = buildContext(sections, CONTEXT_MAX_CHARS);
        }
        qaLog.info(`Context [qa-unit]: ${unitMsg.length} chars`);
        recordContextChars('qa', unitMsg.length);
        const r = await invokeAgent(qaUnitAgent, unitMsg, 'qa-unit', 'qa-unit', 'qa', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: QaUnitOutputSchema });
        unitOutput = r.output;
        if (r.tokenUsage) qaTokenUsage.push(r.tokenUsage);
        qaLog.info(`Unit tests (agent claim): ${unitOutput.testReport?.passed ?? 0} passed, ${unitOutput.testReport?.failed ?? 0} failed`);
        if (unitOutput.bugs) allBugs.push(...unitOutput.bugs);

        unitArtifact = writeArtifact({
            agentId: 'qa-unit', colorCode: 205, workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'QA Unit — Agent Report (advisory)',
            content: `## Results (agent self-report — advisory only)\n\n${JSON.stringify(unitOutput.testReport, null, 2)}`,
        });
        transcript.push(msg('qa-unit', 'qa', `Unit tests (agent claim): ${unitOutput.testReport?.passed ?? 0}/${unitOutput.testReport?.total ?? 0} passed`));
    } catch (err: any) {
        qaLog.error(`QA Unit failed: ${err.message}`);
        if (err?.stack) qaLog.error(err.stack);
        transcript.push(msg('qa-unit', 'qa', `QA Unit failed: ${err.message}`));
        qaUnitErrors.push({ stage: 'qa-unit', message: err.message });
        // Sub-Plan 09 §6: QA crash synthesises a bug
        allBugs.push(makeGateBug(
            'QA-UNIT-FAILED',
            'QA Unit agent crashed',
            'critical',
            'qa-node',
            `QA Unit agent threw: ${err.message}`,
            'QA should write and run tests successfully',
            `Agent crashed: ${err.message}`,
            'QA agent invocation',
        ));
    }

    // Commit QA-generated files via the shared helper (includes sync + retry)
    const systemSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-chore: QA unit test files`,
        state.gitContext,
        qaLog,
    );

    // ── Sub-Plan 09: Run the real test suite
    const roots = detectStackRoots(state.workspacePath);
    const reportDir = path.join(state.outputPath, 'test-reports');
    fs.mkdirSync(reportDir, { recursive: true });

    const executedReports: ExecutedTestReport[] = [];
    for (const root of roots) {
        try {
            const result = await runTests(root, {
                timeoutMs: QA_TEST_TIMEOUT_MS,
                withCoverage: true,
                reportDir,
            });
            executedReports.push(result);
            qaLog.info(`Test runner [${root.relDir || '.'}]: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (exit ${result.exitCode}${result.runnerError ? ', RUNNER ERROR' : ''})`);
        } catch (runErr: any) {
            qaLog.error(`Test runner error in ${root.relDir || '.'}: ${runErr.message}`);
            qaUnitErrors.push({ stage: 'test-runner', message: `root=${root.relDir || '.'}: ${runErr.message}` });
        }
    }

    // Convert executed reports to TestReport format (source: 'executed')
    const authoritativeReports = executedToTestReports(executedReports);

    // Compare claim vs reality and record discrepancies
    const claimDiscrepancies: ClaimDiscrepancy[] = [];
    if (unitOutput?.testReport) {
        const discs = compareClaimVsReality(unitOutput.testReport, authoritativeReports, qaLog);
        claimDiscrepancies.push(...discs);
    }

    // The authoritative reports drive routing; claimed report is advisory
    const testReports: TestReport[] = [
        ...authoritativeReports,
        ...(unitOutput?.testReport ? [{
            ...unitOutput.testReport,
            source: 'claimed' as const,
            cases: unitOutput.testReport.cases ?? [],
        }] : []),
    ];

    // ── Test sufficiency check
    let trivialTestFiles: string[] = [];
    try {
        const allSourceFiles = roots.flatMap(r => {
            try {
                const out = execSync('git ls-files -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.java" "*.cs"', {
                    cwd: r.dir, encoding: 'utf-8', timeout: 10000,
                }).trim().split('\n').filter(Boolean);
                return out.map(f => path.join(r.dir, f));
            } catch { return []; }
        });
        const testFiles = allSourceFiles.filter(f =>
            /\.(test|spec)\.[jt]sx?$/.test(f) || /test_.*\.py$/.test(f) || /__tests__\//.test(f)
        );
        const productFiles = allSourceFiles.filter(f =>
            !/\.(test|spec)\.[jt]sx?$/.test(f) && !/test_.*\.py$/.test(f) && !/__tests__\//.test(f)
        );
        const trivialFindings = detectTrivialTests(state.workspacePath, testFiles, productFiles);
        trivialTestFiles = trivialFindings.map(f => f.file);
    } catch (trivErr: any) {
        qaLog.warn(`Trivial test detection error (non-fatal): ${trivErr.message}`);
    }

    const sufficiencyViolations = checkTestSufficiency({
        executed: executedReports,
        userStories: state.userStories,
        trivialTestFiles,
        completedStoryIds: state.completedAssignmentIds,
    });
    if (sufficiencyViolations.length > 0) {
        const suffBugs = sufficiencyViolationsToBugs(sufficiencyViolations);
        allBugs.push(...suffBugs);
        qaLog.info(`Test sufficiency: ${sufficiencyViolations.length} violation(s), ${suffBugs.length} bug(s) synthesised`);
        transcript.push(msg('test-sufficiency', 'qa',
            `Test sufficiency: ${sufficiencyViolations.filter(v => v.severity === 'critical').length} critical, ${sufficiencyViolations.filter(v => v.severity === 'major').length} major violation(s)`));
    } else {
        qaLog.info('Test sufficiency: all checks passed');
    }

    // If QA Lead also failed, synthesise a bug (Q6)
    if (qaLeadFailed) {
        allBugs.push(makeGateBug(
            'QA-LEAD-FAILED',
            'QA Lead agent produced no test plan',
            'critical',
            'qa-node',
            'QA Lead agent either crashed or returned an empty test plan',
            'QA Lead should produce a test plan covering all acceptance criteria',
            'No test plan was produced',
            'QA Lead agent invocation',
        ));
    }

    const artifacts = [...(leadArtifact ? [leadArtifact] : []), ...(unitArtifact ? [unitArtifact] : [])];

    // ── Deterministic quality gate (fixes A6)
    let latestGateReport: import('../quality-gates').GateReport | null = null;
    const verificationErrors: Array<{ stage: string; message: string }> = [];
    try {
        let productVerifyReport;
        try {
            productVerifyReport = await runProductVerification(state.workspacePath, roots, 'full');
            const artOk = productVerifyReport.artifacts.filter(a => a.passed).length;
            qaLog.info(`Product verification: artifacts=${artOk}/${productVerifyReport.artifacts.length}, unresolved refs=${productVerifyReport.resolveIssues.length}, smoke=${productVerifyReport.smoke?.passed ? 'pass' : productVerifyReport.smoke?.ran ? 'fail' : 'skipped'}`);
        } catch (pvErr: any) {
            qaLog.warn(`Product verification error (non-fatal): ${pvErr.message}`);
            verificationErrors.push({ stage: 'product-verify', message: pvErr.message });
        }

        const gateReport = await runQualityGates(state.workspacePath, {
            productVerify: productVerifyReport,
        });
        latestGateReport = gateReport;
        const gateTestReport = gateReportToTestReport(gateReport, 'quality-gates');
        testReports.push(gateTestReport);

        const agentClaimedPass = unitOutput?.testReport?.status === 'pass';
        if (agentClaimedPass && gateTestReport.status === 'fail') {
            qaLog.warn(`QA agent reported status='pass' but quality gates FAILED — keeping both reports (gate report drives bug-fix loop)`);
            transcript.push(msg('quality-gates', 'qa', `WARNING: QA agent self-reported pass but quality gates failed — deterministic gate overrides`));
        }

        const gateBugs = synthesiseGateBugs(gateReport);
        if (gateBugs.length > 0) {
            allBugs.push(...gateBugs);
            qaLog.info(`Quality gates synthesised ${gateBugs.length} bug(s): ${gateBugs.map(b => b.id).join(', ')}`);
        }

        transcript.push(msg('quality-gates', 'qa',
            `Quality gates: ${gateReport.passed ? 'PASSED' : 'FAILED'} — ${gateReport.stacks.join(',')} — ${gateReport.results.filter(r => !r.skipped).length} steps executed, ${gateReport.results.filter(r => !r.passed && !r.skipped).length} failed, inconclusive=${gateReport.inconclusive}`));
    } catch (gateErr: any) {
        qaLog.error(`Quality gate execution error: ${gateErr.message}`);
        verificationErrors.push({ stage: 'quality-gates', message: gateErr.message });
    }

    // ── Security gate (secret scan, dependency audit, licence check)
    try {
        const securityReport = await runSecurityGates(state.workspacePath);

        writeArtifact({
            agentId: 'security-gates', colorCode: 196, workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'Security Report',
            content: `## Security Report\n\n${securityReportToMarkdown(securityReport)}`,
        });

        // Plan 25, 26-04 §4: propagate sub-gate errors to verificationErrors
        if (securityReport.errors && securityReport.errors.length > 0) {
            for (const err of securityReport.errors) {
                verificationErrors.push({ stage: 'security-gates', message: err });
            }
        }

        if (securityReport.findings.length > 0) {
            qaLog.warn(`Security gate: ${securityReport.findings.length} finding(s), ${securityReport.findings.filter(f => f.severity === 'critical').length} critical`);

            const secBugs = synthesiseSecurityBugs(securityReport);
            if (secBugs.length > 0) {
                allBugs.push(...secBugs);
                qaLog.info(`Security gate synthesised ${secBugs.length} bug(s): ${secBugs.map(b => b.id).join(', ')}`);
            }

            transcript.push(msg('security-gates', 'qa',
                `Security gate: ${securityReport.passed ? 'PASSED (non-critical)' : 'FAILED'} — ${securityReport.findings.length} finding(s), ${securityReport.findings.filter(f => f.severity === 'critical').length} critical`));
        } else {
            transcript.push(msg('security-gates', 'qa', 'Security gate: clean — no findings'));
        }
    } catch (secErr: any) {
        qaLog.error(`Security gate execution error: ${secErr.message}`);
        verificationErrors.push({ stage: 'security-gates', message: secErr.message });
    }

    // ── AC coverage gate (Sub-Plan 10)
    try {
        if (MIN_AC_COVERAGE_PCT > 0) {
            const traceReport = buildTraceabilityReport({
                ...state,
                testPlan: leadOutput?.testPlan ?? state.testPlan,
                testReports,
            } as ProjectStateType);
            const t = traceReport.totals;
            const vPct = t.verifiedPct * 100;
            const iPct = t.implementedPct * 100;
            const coverageOk = vPct >= MIN_AC_COVERAGE_PCT
                && (MIN_AC_IMPLEMENTED_PCT <= 0 || iPct >= MIN_AC_IMPLEMENTED_PCT);

            testReports.push({
                type: 'unit' as const,
                framework: 'ac-coverage',
                source: 'quality-gates' as const,
                total: t.criteria,
                passed: t.verified,
                failed: t.criteria - t.verified,
                skipped: 0,
                status: coverageOk ? 'pass' as const : 'fail' as const,
                iterationIndex: state.iteration?.bugfix ?? 0,
                runnerError: false,
                failures: [],
                agentId: 'ac-coverage-gate',
                cases: [],
            });

            if (!coverageOk) {
                const missingGaps = traceReport.rows.filter(r => r.status === 'missing');
                const failingGaps = traceReport.rows.filter(r => r.status === 'tested-failing');
                const untestedGaps = traceReport.rows.filter(r => r.status === 'implemented-untested');
                const blockedGaps = traceReport.rows.filter(r => r.status === 'blocked');
                const prioritised = [...missingGaps, ...failingGaps, ...blockedGaps, ...untestedGaps];

                const acBugs: Bug[] = prioritised.slice(0, MIN_AC_COVERAGE_MAX_BUGS).map(row => makeGateBug(
                    `AC-${row.storyId}-${row.acIndex}`,
                    `Acceptance criterion not verified: ${row.storyId} AC#${row.acIndex}`,
                    'critical',
                    'ac-coverage-gate',
                    `Story ${row.storyId}, AC#${row.acIndex}: "${row.acText}"`,
                    `A test named "[${row.storyId}#${row.acIndex}] ..." exists, is executed, and passes`,
                    `Status "${row.status}" — ${
                        row.status === 'missing' ? 'no assignment references this story'
                        : row.status === 'tested-failing' ? 'test exists but fails'
                        : row.status === 'blocked' ? 'PR blocked/conflicted'
                        : 'code merged but no tagged test executed'}`,
                    row.assignmentIds[0] ? `Assignment ${row.assignmentIds[0]}` : `Story ${row.storyId}`,
                ));
                if (acBugs.length > 0) {
                    allBugs.push(...acBugs);
                    qaLog.info(`AC coverage gate: verified ${vPct.toFixed(0)}% < ${MIN_AC_COVERAGE_PCT}%, implemented ${iPct.toFixed(0)}% — synthesised ${acBugs.length} bug(s)`);
                    transcript.push(msg('quality-gates', 'qa',
                        `AC coverage gate FAILED: verified ${vPct.toFixed(0)}%, implemented ${iPct.toFixed(0)}%, delivery ${t.deliveryScore.toFixed(2)} — ${acBugs.length} bugs for ${prioritised.length} gaps`));
                }
            } else {
                qaLog.info(`AC coverage gate: verified ${vPct.toFixed(0)}% >= ${MIN_AC_COVERAGE_PCT}%, implemented ${iPct.toFixed(0)}% — passed (delivery ${t.deliveryScore.toFixed(2)})`);
            }
            emitRunEvent('traceability:update', {
                verifiedPct: t.verifiedPct, implementedPct: t.implementedPct,
                deliveryScore: t.deliveryScore, criteria: t.criteria,
                verified: t.verified, missing: t.missing, blocked: t.blocked,
            });
        }
    } catch (acErr: any) {
        qaLog.error(`AC coverage gate error: ${acErr.message}`);
        verificationErrors.push({ stage: 'ac-coverage', message: acErr.message });
    }

    // ── Compute fixedBugIds by re-evaluation (fixes E5)
    const currentBugIds = new Set(allBugs.map(b => b.id));
    const attemptedSet = new Set(state.attemptedBugIds ?? []);
    const newlyFixed = [...attemptedSet].filter(id => !currentBugIds.has(id));

    // Sub-Plan 09 invariant: testReports must never be empty after qaNode.
    if (testReports.length === 0) {
        qaLog.warn('Invariant: qaNode produced no test report — synthesising inconclusive report');
        testReports.push({
            type: 'unit' as const,
            framework: 'unknown',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            status: 'inconclusive' as const,
            source: 'executed' as const,
            iterationIndex: 0,
            runnerError: true,
            failures: [],
            agentId: 'qa-node',
            cases: [],
        });
    }

    emitRunEvent('phase:end', { phase: 'qa', testReports: testReports.length, bugs: allBugs.length });
    return {
        ...rerunUpdate,
        testPlan: leadOutput?.testPlan,
        testReports,
        bugs: allBugs,
        fixedBugIds: newlyFixed,
        fileChanges: unitOutput?.fileChanges ?? [],
        artifacts,
        transcript,
        latestGateReport: latestGateReport,
        verificationErrors: [...qaUnitErrors, ...verificationErrors],
        qaClaimDiscrepancies: claimDiscrepancies,
        phase: 'qa' as PhaseName,
        tokenUsage: qaTokenUsage,
    };
});
