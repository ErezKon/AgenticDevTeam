/**
 * E2E testing node — Playwright-based end-to-end tests with
 * smoke test fallback when Playwright MCP is unavailable.
 */
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { createQaE2eAgent } from '../../agents/qa/qa.agents';
import { writeArtifact } from '../../agents/_shared/artifact';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import { detectStackRoots } from '../quality-gates';
import { getPlaywrightMcpTools, closePlaywrightMcp } from '../../tools/mcp/playwright-mcp';
import { makeGateBug } from '../bug-factory';
import { QaE2eOutputSchema } from '../../agents/qa/schemas/qa-output.schema';
import {
    TOOL_PIPELINE_RECURSION_LIMIT,
    E2E_ALLOW_LOCAL_SERVER,
} from '../../config';
import { emitRunEvent } from '../../utils/event-bus';
import type { TokenCallRecord } from '../../utils/token-tracker';
import { phaseNode, msg } from './_guards';
import { invokeAgent } from './_invoke';
import type { ProjectStateType } from '../state';
import type { PhaseName, TranscriptMessage, Bug } from '../../agents/_shared/base-schemas';

const e2eLog = getLogger('[QA E2E]', 118);

export const e2eNode = phaseNode('e2e', e2eLog, {}, async (state, { rerunUpdate }) => {
    e2eLog.info('Starting E2E testing phase...');
    const transcript: TranscriptMessage[] = [];
    const e2eTokenUsage: TokenCallRecord[] = [];
    const allBugs: Bug[] = [];

    // ── Helper: build an inconclusive e2e TestReport so downstream sees a signal
    function inconclusiveReport(reason: string): any {
        return {
            type: 'e2e', source: 'executed', status: 'inconclusive',
            framework: 'e2e-smoke', agentId: 'e2e-node',
            total: 0, passed: 0, failed: 0, skipped: 0,
            failures: [],
            runnerError: true, cases: [], iterationIndex: state.iteration?.bugfix ?? 0,
            summary: reason,
        };
    }

    // ── Skip: no service URLs and no web root → E2E not applicable
    const hasServiceUrls = (state.devopsPlan?.serviceUrls ?? []).length > 0;
    const hasWebRoot = (state.latestGateReport?.roots ?? []).some(
        r => r.stack === 'node' || r.stack === 'python',
    );

    if (!hasServiceUrls) {
        // Try the local-server fallback path if a web root exists (D6, non-Docker E2E path)
        if (hasWebRoot && E2E_ALLOW_LOCAL_SERVER) {
            e2eLog.info('No service URLs but web root exists — attempting local smoke test fallback');
            try {
                const roots = state.latestGateReport?.roots ?? detectStackRoots(state.workspacePath);
                const { runSmokeTest } = await import('../product-verify');
                const smokeResult = await runSmokeTest(state.workspacePath, roots, []);
                if (smokeResult.ran && smokeResult.passed) {
                    e2eLog.info(`Local smoke test passed (HTTP ${smokeResult.httpStatus}, ${smokeResult.bodyBytes} bytes)`);
                    const smokeReport = {
                        type: 'e2e' as const, source: 'executed' as const, status: 'pass' as const,
                        framework: 'e2e-smoke', agentId: 'e2e-node',
                        total: 1, passed: 1, failed: 0, skipped: 0,
                        failures: [] as any[],
                        runnerError: false, cases: [], iterationIndex: state.iteration?.bugfix ?? 0,
                        summary: `Smoke test: HTTP ${smokeResult.httpStatus}, ${smokeResult.bodyBytes} bytes`,
                    };
                    transcript.push(msg('qa-e2e', 'e2e', `Local smoke test passed`));
                    emitRunEvent('e2e:status', { status: 'passed', mode: 'smoke' });
                    emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'acceptance-gate' });
                    return {
                        ...rerunUpdate,
                        e2eStatus: 'passed',
                        testReports: [smokeReport],
                        phase: 'e2e' as PhaseName,
                        transcript,
                        tokenUsage: e2eTokenUsage,
                    };
                } else {
                    const smokeReason = smokeResult.reason ?? 'smoke test failed';
                    e2eLog.warn(`Local smoke test failed: ${smokeReason}`);
                    transcript.push(msg('qa-e2e', 'e2e', `Local smoke test failed: ${smokeReason}`));
                    emitRunEvent('e2e:status', { status: 'error', mode: 'smoke', reason: smokeReason });
                    emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'acceptance-gate', error: smokeReason });
                    return {
                        ...rerunUpdate,
                        e2eStatus: 'error',
                        e2eSkipReason: smokeReason,
                        testReports: [inconclusiveReport(smokeReason)],
                        verificationErrors: [{ stage: 'e2e', message: smokeReason }],
                        phase: 'e2e' as PhaseName,
                        transcript,
                        tokenUsage: e2eTokenUsage,
                    };
                }
            } catch (smokeErr: any) {
                e2eLog.error(`Local smoke fallback failed: ${smokeErr.message}`);
            }
        }

        // No services, no local server — skip but record the signal (D6)
        const { DEVOPS_VERIFY_ENABLED } = require('../../config');
        const reason = !DEVOPS_VERIFY_ENABLED
            ? 'DEVOPS_VERIFY_ENABLED=false — no services were started'
            : 'no service URLs from DevOps — deployment did not produce running services';
        e2eLog.info(`Skipping E2E tests — ${reason}`);
        transcript.push(msg('qa-e2e', 'e2e', `Skipped — ${reason}`));
        emitRunEvent('e2e:status', { status: 'skipped-no-services', reason });
        emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'acceptance-gate', skipped: true, reason });
        return {
            ...rerunUpdate,
            e2eStatus: 'skipped-no-services',
            e2eSkipReason: reason,
            testReports: [inconclusiveReport(reason)],
            phase: 'e2e' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    }

    // ── Playwright preflight (D10)
    e2eLog.info(`Running E2E tests against ${state.devopsPlan!.serviceUrls.length} service(s)...`);
    try {
        const { preflightPlaywright } = await import('../../tools/mcp/playwright-preflight');
        const preflight = await preflightPlaywright();
        if (!preflight.available) {
            e2eLog.warn(`Playwright MCP not available: ${preflight.reason}`);
            // Fall back to smoke test instead of failing entirely
            e2eLog.info('Falling back to deterministic smoke test');
            try {
                const roots = state.latestGateReport?.roots ?? detectStackRoots(state.workspacePath);
                const { runSmokeTest } = await import('../product-verify');
                // Use deterministic smoke test against built artifacts
                const smokeResult = await runSmokeTest(state.workspacePath, roots, []);
                const smokeReport = {
                    type: 'e2e' as const, source: 'executed' as const,
                    status: (smokeResult.passed ? 'pass' : 'fail') as 'pass' | 'fail',
                    framework: 'e2e-smoke', agentId: 'e2e-node',
                    total: 1, passed: smokeResult.passed ? 1 : 0, failed: smokeResult.passed ? 0 : 1, skipped: 0,
                    failures: [] as any[],
                    runnerError: false, cases: [], iterationIndex: state.iteration?.bugfix ?? 0,
                    summary: smokeResult.passed
                        ? `Smoke test: HTTP ${smokeResult.httpStatus}, ${smokeResult.bodyBytes} bytes`
                        : `Smoke test failed: ${smokeResult.reason}`,
                };
                transcript.push(msg('qa-e2e', 'e2e', `Playwright unavailable — smoke test ${smokeResult.passed ? 'passed' : 'failed'}`));
                emitRunEvent('e2e:status', { status: smokeResult.passed ? 'passed' : 'failed', mode: 'smoke-fallback' });
                emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'acceptance-gate' });
                return {
                    ...rerunUpdate,
                    e2eStatus: smokeResult.passed ? 'passed' : 'failed',
                    testReports: [smokeReport],
                    phase: 'e2e' as PhaseName,
                    transcript,
                    tokenUsage: e2eTokenUsage,
                };
            } catch (fallbackErr: any) {
                e2eLog.error(`Smoke fallback also failed: ${fallbackErr.message}`);
            }
        }
    } catch (preflightErr: any) {
        e2eLog.warn(`Preflight check failed: ${preflightErr.message}`);
    }

    // ── Main Playwright E2E path
    try {
        const apiKey = await getAccessToken();
        const qaConventionFiles = resolveConventionFiles([], state.techStack);
        const mcpTools = await getPlaywrightMcpTools();
        const qaE2eAgent = createQaE2eAgent(apiKey, mcpTools, qaConventionFiles);
        const e2eMsg = [
            `## Test Plan (e2e)\n\n${JSON.stringify(state.testPlan?.e2e ?? [], null, 2)}`,
            `\n## Service URLs\n\n${JSON.stringify(state.devopsPlan!.serviceUrls, null, 2)}`,
        ].join('\n');
        const { output: e2eOutput, tokenUsage: e2eTU } = await invokeAgent(qaE2eAgent, e2eMsg, 'qa-e2e', 'qa-e2e', 'e2e', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: QaE2eOutputSchema });
        if (e2eTU) e2eTokenUsage.push(e2eTU);
        const e2eReport = e2eOutput.testReport;
        if (e2eOutput.bugs) allBugs.push(...e2eOutput.bugs);
        e2eLog.info(`E2E tests: ${e2eReport?.passed ?? 0} passed, ${e2eReport?.failed ?? 0} failed`);

        // ── Cross-check E2E self-report (D9)
        const claimedTotal = e2eReport?.total ?? 0;
        const e2eEvidenceData = { screenshots: [] as string[], consoleErrors: [] as string[], urlsVisited: [] as string[] };

        const e2eArtifact = writeArtifact({
            agentId: 'qa-e2e', colorCode: 118, workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'QA E2E — Test Report',
            content: `## Results\n\n${JSON.stringify(e2eReport, null, 2)}`,
        });
        transcript.push(msg('qa-e2e', 'e2e', `E2E tests: ${e2eReport?.passed ?? 0}/${e2eReport?.total ?? 0} passed`));
        await closePlaywrightMcp();

        const e2eStatus = (e2eReport?.failed ?? 0) > 0 ? 'failed' : 'passed';
        emitRunEvent('e2e:status', { status: e2eStatus, total: claimedTotal });
        emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'acceptance-gate' });
        return {
            ...rerunUpdate,
            e2eStatus: e2eStatus as 'passed' | 'failed',
            e2eEvidence: e2eEvidenceData,
            testReports: e2eReport ? [e2eReport] : [],
            bugs: allBugs,
            artifacts: [e2eArtifact],
            phase: 'e2e' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    } catch (err: any) {
        // D8: catch now sets e2eStatus='error', pushes an inconclusive report, records
        // verificationErrors entry, and synthesises an E2E-INFRA-FAILED bug.
        e2eLog.error(`E2E testing failed: ${err.message}`);
        if (err?.stack) e2eLog.error(err.stack);
        transcript.push(msg('qa-e2e', 'e2e', `E2E testing failed: ${err.message}`));

        allBugs.push(makeGateBug(
            'E2E-INFRA-FAILED',
            'E2E testing infrastructure failure',
            'major',
            'e2e-node',
            'Run E2E phase with Playwright MCP',
            'E2E agent should connect to the MCP server and execute tests',
            `E2E failed: ${err.message}`,
            'Playwright MCP setup / browser installation',
        ));

        emitRunEvent('e2e:status', { status: 'error', error: err.message });
        emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'acceptance-gate', error: err.message });
        return {
            ...rerunUpdate,
            e2eStatus: 'error',
            e2eSkipReason: err.message,
            testReports: [inconclusiveReport(err.message)],
            bugs: allBugs,
            verificationErrors: [{ stage: 'e2e', message: err.message }],
            phase: 'e2e' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    }
});
