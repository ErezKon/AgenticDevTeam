/**
 * Conductor graph nodes — one function per pipeline phase.
 *
 * Each node reads ProjectState, invokes agent(s), and returns a partial
 * state update that the LangGraph reducers merge into the full state.
 */
import { getAccessToken } from '../utils/oauth-auth.util';
import { getLogger, setRunLogPath } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { writeArtifact } from '../agents/_shared/artifact';
import { createProjectWorkspace, createRunOutputDir, ensureProjectGitignore, getGitignoreEntriesForStack } from '../utils/workspace';
import { parseRequirementsFile } from '../tools/requirements/parse-requirements';
import { createCodebaseAnalyzerAgent } from '../agents/codebase-analyzer/codebase-analyzer.agent';
import { writeCodebaseAnalysis, readExistingAnalysis } from '../utils/codebase-analysis-writer';
import { createArchitectAgent } from '../agents/architect/architect.agent';
import { createProductManagerAgent } from '../agents/product-manager/product-manager.agent';
import { createDbaAgent } from '../agents/dba/dba.agent';
import { createTeamLeaderAgent } from '../agents/team-leader/team-leader.agent';
import { dispatchDevelopers } from '../agents/developers/dispatcher';
import { createQaLeadAgent, createQaUnitAgent, createQaE2eAgent } from '../agents/qa/qa.agents';
import { createDevOpsAgent } from '../agents/devops/devops.agent';
import { deployConventionsToWorkspace, resolveConventionFiles } from '../utils/coding-conventions';
import { getDevAgent } from '../agents/developers/registry';
import { getPlaywrightMcpTools, closePlaywrightMcp } from '../tools/mcp/playwright-mcp';
import {
    GIT_DEFAULT_BRANCH, PIPELINE_RECURSION_LIMIT,
    TOOL_PIPELINE_RECURSION_LIMIT,
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    GITHUB_PROJECT_TOKEN, GITHUB_PROJECT_OWNER,
    ARCHITECT_MODEL, PRODUCT_MANAGER_MODEL, DBA_MODEL, TEAM_LEADER_MODEL,
    DEVOPS_MODEL, CODEBASE_ANALYZER_MODEL, QA_MODEL, LLM_MODEL,
    MODEL_PRICING, DEV_CONTEXT_FILE_CHANGES_LIMIT,
    DEVOPS_VERIFY_ENABLED, DEVOPS_TEARDOWN,
    DEVOPS_FALLBACK_ENABLED,
    E2E_ALLOW_LOCAL_SERVER,
    AGENT_OUTPUT_REPAIR_ATTEMPTS,
    CONTEXT_MAX_CHARS,
    TEAM_LEADER_CONTEXT_MAX_CHARS,
    PLAN_COVERAGE_MODE, PLAN_COVERAGE_REPAIR_ATTEMPTS,
    MIN_AC_COVERAGE_PCT, MIN_AC_IMPLEMENTED_PCT, MIN_AC_COVERAGE_MAX_BUGS,
    TRACEABILITY_JSON,
    SECURITY_GATES_ENABLED,
    RUN_FAIL_POLICY,
    MAX_BRANCHES,
} from '../config';
import { sanitizeMermaidLabels } from '../tools/diagram/diagram-tools';
import { createGitHubRepo, validateGitHubRepo, initializeRepoLocally } from '../utils/github-repo-manager';
import { gitExec, gitPush, findGitRoot } from '../utils/git-exec';
import { GITHUB_MODE } from '../utils/github-local';
import { setLocalBareRepoPath, retryFailedPRCreation } from './pr-workflow';
import { syncWorkspaceToBranch, looksSourceless } from './workspace-sync';
import { selectPendingAssignments, dedupeBugs, namespaceBugfixAssignments, sanitizeAssignmentStoryIds } from './assignment-policy';
import { runAssemblyGate, buildAssemblyAssignment } from './assembly-gate';
import { consolidateBranches } from './branch-consolidation';
import { verifyDeployment, teardownDeployment } from './devops-verify';
import { runQualityGates, gateReportToTestReport, synthesiseGateBugs, detectStackRoots } from './quality-gates';
import { runProductVerification } from './product-verify';
import { runSecurityGates, synthesiseSecurityBugs, securityReportToMarkdown } from './security-gates';
import {
    summariseArchitecture, summariseTechStack, summariseDbDesign,
    summariseStories, storiesForIds, storiesWithCriteria, summariseTasks,
    summariseFileChanges, summariseCodebaseAnalysis, summariseEpics,
    summariseRepoContract,
    buildContext, recordContextChars, getContextStats,
} from './context-builder';
import { getCumulativeCompactionStats } from '../agents/_shared/history-compactor';
import { getTruncationStats } from '../tools/_shared/truncate';
import type { ContextSection } from './context-builder';
import {
    parseAgentJson, validateAgentOutput, buildRepairMessage,
    repairFieldViolations, extractAgentText, trimTruncatedArrayTails,
    getValidationStats, logValidationStats,
    _recordValidated, _recordRepaired, _recordFailed,
} from '../utils/structured-output';
import type { ParseResult } from '../utils/structured-output';
import { initResponseLog, logAgentResponse } from '../utils/response-log';
import { validateStoryPlan, validateAssignmentPlan, buildCoverageGapPrompt, logPlanFunnel } from './plan-coverage';
import { z } from 'zod';
import { CodebaseAnalysisSchema } from '../agents/_shared/base-schemas';
import { ArchitectOutputSchema } from '../agents/architect/schemas/architect-output.schema';
import { ProductManagerOutputSchema } from '../agents/product-manager/schemas/pm-output.schema';
import { DbaOutputSchema } from '../agents/dba/schemas/dba-output.schema';
import { TeamLeaderOutputSchema } from '../agents/team-leader/schemas/tl-output.schema';
import { QaLeadOutputSchema, QaUnitOutputSchema, QaE2eOutputSchema } from '../agents/qa/schemas/qa-output.schema';
import { DevOpsOutputSchema } from '../agents/devops/schemas/devops-output.schema';
import { execSync } from 'child_process';
import type { ProjectStateType } from './state';
import type { PhaseName, TranscriptMessage, Bug, CodebaseAnalysis, GitContext } from '../agents/_shared/base-schemas';
import type { PullRequest } from '../agents/_shared/schemas/pr.schema';
import { tokenTracker, type TokenCallRecord } from '../utils/token-tracker';
import { extractTokenUsageFromMessages } from '../utils/token-usage-extractor';
import { generateTokenReport, refreshTokenReport } from '../utils/token-report';
import { getThrottleStats, logThrottleStats } from '../utils/llm-throttle';
import { estimateCost } from '../utils/cost';
import { startRunBudget, getBudgetStatus, getEffectiveLimits, shouldStopRun } from '../utils/run-budget';
import { emitRunEvent, getAllEvents } from '../utils/event-bus';
import { writeStateSnapshot, writeRunManifest, writePeriodicSnapshot, countPRsByStatus, extractPhaseTimeline, renderPhaseTimeline } from '../utils/run-snapshot';
import { generateRunDiagnosis } from '../utils/run-diagnosis';
import { buildTraceabilityReport, renderTraceabilityMarkdown } from '../utils/traceability';
import { evaluateAcceptance, haltIfUnrecoverable, detectUnrecoverable, acceptanceBlockersToBugs, acceptanceReportToMarkdown } from './acceptance-gate';
import type { DispatchRound } from './acceptance-gate';
import { initLedger, appendLedger } from '../utils/run-ledger';
import { generateRunReport } from '../utils/ledger-report';
import { checkInvariants } from './run-invariants';
import { writeRepoContract } from '../utils/repo-contract-writer';
import { REPO_CONTRACT_MAX_MODULES, QA_TEST_TIMEOUT_MS, QA_MAX_INVOCATIONS, QA_TESTS_VIA_PR } from '../config';
import { runTests, executedToTestReports, compareClaimVsReality, type ExecutedTestReport, type ClaimDiscrepancy } from './test-runner';
import { checkTestSufficiency, sufficiencyViolationsToBugs } from './test-sufficiency';
import { detectTrivialTests } from './gate-integrity';
import * as path from 'path';
import * as fs from 'fs';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ts(): string { return new Date().toISOString(); }

/**
 * Detect the default branch name for a git repo.
 * Tries symbolic-ref, then checks for common branch names, then falls back to config.
 */
function detectDefaultBranch(workspacePath: string): string {
    try {
        const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
            cwd: workspacePath, encoding: 'utf-8', timeout: 5000,
        }).trim();
        // refs/remotes/origin/main → main
        return ref.replace('refs/remotes/origin/', '');
    } catch {
        // Fallback: check if main or master branch exists
        try {
            const branches = execSync('git branch --list', {
                cwd: workspacePath, encoding: 'utf-8', timeout: 5000,
            }).trim();
            if (branches.includes('main')) return 'main';
            if (branches.includes('master')) return 'master';
        } catch { /* ignore */ }
    }
    return GIT_DEFAULT_BRANCH;
}

// gitExec, gitPush, findGitRoot imported from ../utils/git-exec

function msg(agentId: string, phase: PhaseName, message: string): TranscriptMessage {
    emitRunEvent('transcript', { agentId, phase, message });
    return { timestamp: ts(), agentId, phase, message };
}

/**
 * Build a highest-priority feedback section for a phase's user message when
 * `state.phaseFeedback[phase]` is non-empty.
 *
 * This is the change that makes "enhance" real — the user's feedback is
 * injected into the agent's prompt so it can address the specific concerns.
 */
function buildFeedbackSection(state: ProjectStateType, phase: PhaseName): string {
    const feedback = state.phaseFeedback?.[phase];
    if (!feedback || feedback.length === 0) return '';
    const numbered = feedback.map((f, i) => `${i + 1}. ${f}`).join('\n');
    return `## Reviewer Feedback — you MUST address this\n${numbered}`;
}

/**
 * Check if this node is being re-run via pendingRerun, and return
 * partial state updates to clear the flag. Also logs the re-run.
 */
function checkRerun(state: ProjectStateType, phase: PhaseName, logger: ReturnType<typeof getLogger>): Partial<ProjectStateType> | null {
    if (state.pendingRerun === phase) {
        logger.info(`Re-running ${phase} with user feedback`);
        return { pendingRerun: null as any };
    }
    return null;
}

/**
 * Stage, commit, and push any new/modified files in the workspace.
 * Used by planning agents (architect, PM) that produce doc artifacts
 * but don't go through the PR workflow.
 *
 * Syncs with origin before committing, and retries the push once after
 * a sync if the first push fails (non-fast-forward after squash merges).
 */
function commitAndPushArtifacts(
    workspacePath: string,
    commitMessage: string,
    gitContext?: GitContext | null,
    logger?: ReturnType<typeof getLogger>,
): void {
    // Resolve git root for sync operations
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(workspacePath);
    } catch {
        gitRoot = workspacePath;
    }

    // Sync before committing to avoid non-fast-forward pushes
    const currentBranch = gitExec(gitRoot, 'rev-parse --abbrev-ref HEAD');
    if (currentBranch && !currentBranch.startsWith('Error:')) {
        syncWorkspaceToBranch(gitRoot, currentBranch, gitContext);
    }

    gitExec(workspacePath, 'add .');
    const status = gitExec(workspacePath, 'status --short');
    if (!status || status.includes('nothing to commit')) {
        // No new changes to commit, but check if we need to push existing commits
        if (currentBranch && !currentBranch.startsWith('Error:')) {
            const ahead = gitExec(workspacePath, `rev-list origin/${currentBranch}..HEAD --count`);
            if (ahead && !ahead.startsWith('Error:') && parseInt(ahead.trim(), 10) > 0) {
                const pushResult = gitPush(workspacePath, currentBranch, gitContext);
                if (pushResult.startsWith('Error:')) {
                    logger?.warn?.(`Push of existing commits failed: ${pushResult}`);
                } else {
                    logger?.info?.(`Pushed ${ahead.trim()} existing commit(s) on ${currentBranch}`);
                }
            }
        }
        return;
    }

    gitExec(workspacePath, `commit -m "${commitMessage}"`);
    if (currentBranch && !currentBranch.startsWith('Error:')) {
        const pushResult = gitPush(workspacePath, currentBranch, gitContext);
        if (pushResult.startsWith('Error:')) {
            // Retry once: sync again then push
            logger?.warn?.(`Push failed, retrying after sync: ${pushResult}`);
            syncWorkspaceToBranch(gitRoot, currentBranch, gitContext);
            const retryResult = gitPush(workspacePath, currentBranch, gitContext);
            if (retryResult.startsWith('Error:')) {
                logger?.error?.(`Failed to push artifacts after retry: ${retryResult}`);
            } else {
                logger?.info?.(`Committed and pushed artifacts on ${currentBranch} (after retry)`);
            }
        } else {
            logger?.info?.(`Committed and pushed artifacts on ${currentBranch}`);
        }
    }
}

/**
 * Ensure package-lock.json is in sync with package.json.
 * If package.json exists but the lockfile is missing or stale, run `npm install`
 * to regenerate it, then commit + push the result.
 */
function ensureNodeLockfileSync(
    workspacePath: string,
    systemBranch: string,
    gitContext?: GitContext | null,
    logger?: ReturnType<typeof getLogger>,
): void {
    const pkgPath = path.join(workspacePath, 'package.json');
    if (!fs.existsSync(pkgPath)) return; // Not a Node.js project

    logger?.info?.('Ensuring package-lock.json is in sync with package.json...');

    try {
        // Run npm install to regenerate lockfile
        // Use --no-audit --no-fund to reduce noise
        execSync('npm install --no-audit --no-fund', {
            cwd: workspacePath,
            timeout: 300_000, // 5 min
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 5,
            env: { ...process.env, CI: 'true' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Check if lockfile was created/updated
        const lockPath = path.join(workspacePath, 'package-lock.json');
        if (fs.existsSync(lockPath)) {
            // Stage and check for changes
            gitExec(workspacePath, 'add package-lock.json');
            const status = gitExec(workspacePath, 'status --short -- package-lock.json');
            if (status && status.trim() && !status.includes('nothing to commit')) {
                const slug = path.basename(workspacePath);
                gitExec(workspacePath, `commit -m "[${slug}]-chore: sync package-lock.json"`);
                const branch = gitExec(workspacePath, 'rev-parse --abbrev-ref HEAD');
                if (branch && !branch.startsWith('Error:')) {
                    gitPush(workspacePath, branch, gitContext);
                }
                logger?.info?.('package-lock.json synced and pushed');
            } else {
                logger?.info?.('package-lock.json already in sync');
            }
        }
    } catch (err: any) {
        logger?.warn?.(`Lockfile sync failed (non-fatal): ${err.message}`);
    }
}

/**
 * Ensure all Dockerfiles in the workspace have `npm config set strict-ssl false`
 * before any `npm ci` or `npm install` RUN commands.
 * This is a failsafe for corporate environments with self-signed SSL certificates.
 */
function patchDockerfilesSsl(workspacePath: string, logger?: ReturnType<typeof getLogger>): void {
    const dockerfiles = ['Dockerfile'];
    // Also look for Dockerfile.* variants
    try {
        const entries = fs.readdirSync(workspacePath);
        for (const e of entries) {
            if (e.startsWith('Dockerfile') && !dockerfiles.includes(e)) {
                dockerfiles.push(e);
            }
        }
    } catch { /* ignore */ }

    for (const df of dockerfiles) {
        const dfPath = path.join(workspacePath, df);
        if (!fs.existsSync(dfPath)) continue;

        let content = fs.readFileSync(dfPath, 'utf-8');
        // Check if any RUN line has npm ci or npm install WITHOUT strict-ssl already set
        const npmRunPattern = /^(RUN\s+(?:.*&&\s*)?)npm\s+(ci|install)\b/gm;
        const sslAlready = /npm config set strict-ssl false/;

        if (npmRunPattern.test(content) && !sslAlready.test(content)) {
            // Inject `npm config set strict-ssl false && ` before `npm ci`/`npm install`
            content = content.replace(
                /npm\s+(ci|install)\b/g,
                'npm config set strict-ssl false && npm $1',
            );
            fs.writeFileSync(dfPath, content, 'utf-8');
            logger?.info?.(`Patched ${df}: added npm strict-ssl=false workaround`);
        }
    }
}

/** Resolve the configured model name for a pipeline agent. */
function getModelForAgent(agentId: string): string {
    const modelMap: Record<string, string | undefined> = {
        'codebase-analyzer': CODEBASE_ANALYZER_MODEL ?? ARCHITECT_MODEL,
        'architect': ARCHITECT_MODEL,
        'product-manager': PRODUCT_MANAGER_MODEL,
        'dba': DBA_MODEL,
        'team-leader': TEAM_LEADER_MODEL,
        'devops': DEVOPS_MODEL,
        'qa-lead': QA_MODEL,
        'qa-unit': QA_MODEL,
        'qa-e2e': QA_MODEL,
    };
    return modelMap[agentId] ?? LLM_MODEL;
}

const invokeLog = getLogger('[InvokeAgent]', 183);

async function invokeAgent(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, phase: string,
    opts?: { recursionLimit?: number; schema?: z.ZodTypeAny },
): Promise<{ output: any; tokenUsage: TokenCallRecord | null }> {
    const recursionLimit = opts?.recursionLimit ?? PIPELINE_RECURSION_LIMIT;
    return retryWithBackoff(async () => {
        const threadId = `conductor-${threadSuffix}-${Date.now()}`;
        const model = getModelForAgent(agentId);
        const startMs = Date.now();
        emitRunEvent('agent:start', { agentId, phase, model });

        // Track this invocation for the Invocation Efficiency report
        const invocationId = tokenTracker.startInvocation(agentId, phase);
        agent.setInvocationId?.(invocationId);

        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: threadId }, recursionLimit },
        );

        tokenTracker.endInvocation(invocationId);
        agent.setInvocationId?.(undefined);

        // Extract per-invocation token usage from messages (complementary to callback tracking)
        const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, phase);

        const emitEnd = (extra?: Record<string, unknown>) => {
            const durationMs = Date.now() - startMs;
            emitRunEvent('agent:end', {
                agentId, phase, model, durationMs,
                inputTokens: tokenUsage?.inputTokens ?? 0,
                outputTokens: tokenUsage?.outputTokens ?? 0,
                ...extra,
            });
        };

        // Normalise content: Anthropic streaming and OpenAI Responses API
        // return AIMessage.content as an array of content blocks instead of
        // a plain string.  Extract the text so JSON parsing can proceed.
        const extraction = extractAgentText(result.messages);
        const schema = opts?.schema;

        logAgentResponse({
            agentId, phase, model, threadId, invocationId,
            kind: 'invoke', userMessage, systemPrompt: agent.systemPromptText,
            durationMs: Date.now() - startMs,
        }, result);

        if (extraction.truncatedByTokenLimit) {
            invokeLog.warn(
                `Agent "${threadSuffix}" response was cut off by the output-token limit ` +
                `— raise PLANNING_MAX_OUTPUT_TOKENS/LLM_MAX_OUTPUT_TOKENS if this repeats.`,
            );
        }
        if (extraction.text === null && !schema) {
            // No schema — the caller wants whatever structured data came back
            // (e.g. tool calls), so pass the raw content through unchanged.
            const last = result.messages[result.messages.length - 1];
            invokeLog.warn(
                `Agent "${threadSuffix}" returned no text content ` +
                `(final message content: ${extraction.blockTypes}) — passing raw content through.`,
            );
            emitEnd();
            return { output: last?.content, tokenUsage };
        }
        if (extraction.text !== null && extraction.source !== 'string') {
            invokeLog.debug(
                `Extracted ${extraction.text.length} chars from ${extraction.source} ` +
                `(${extraction.blockTypes}) for "${threadSuffix}"`,
            );
        }

        // Extract JSON from the response using the shared parser
        const raw = extraction.text?.trim() ?? '';
        const parseResult: ParseResult = extraction.text === null
            ? { ok: false, error: `Response carried no text content (final message content: ${extraction.blockTypes}).` }
            : parseAgentJson(raw);

        // If JSON parsing failed and no schema is provided, throw immediately
        if (!parseResult.ok && !schema) {
            emitEnd({ error: parseResult.error });
            throw new SyntaxError(
                `Agent "${threadSuffix}" did not return valid JSON. ${parseResult.error}`
            );
        }

        // Determine initial parse + validation state
        let parsed = parseResult.ok ? parseResult.value : undefined;
        let issuesForRepair: string;

        if (extraction.text === null) {
            // Content blocks with no text at all: a reasoning-only response, or
            // an output budget consumed entirely by thinking. Returning the raw
            // blocks here is what silently produced empty phases — re-ask instead.
            invokeLog.error(
                `Agent "${threadSuffix}" returned no text content ` +
                `(final message content: ${extraction.blockTypes}) — re-asking.`,
            );
            issuesForRepair = `Your previous response contained no text output at all `
                + `(content blocks: ${extraction.blockTypes}). No JSON payload was received.`;
        } else if (!parseResult.ok) {
            // JSON parsing failed but we have a schema — route into repair loop
            invokeLog.warn(`Agent "${threadSuffix}" returned unparseable JSON — entering repair loop. ${parseResult.error}`);
            issuesForRepair = `Response was not valid JSON. ${parseResult.error}`;
        } else if (schema) {
            _recordValidated();
            const validation = validateAgentOutput(schema, parsed);
            if (validation.ok) {
                emitEnd();
                return { output: validation.value, tokenUsage };
            }
            invokeLog.warn(`Agent "${threadSuffix}" output failed schema validation:\n${validation.issues}`);

            // Attempt deterministic field-level repair before LLM repair (P1/P2)
            const fieldFix = repairFieldViolations(parsed, schema);
            if (fieldFix.repaired.length > 0) {
                invokeLog.info(`Field-level repair: fixed ${fieldFix.repaired.length} violation(s) for "${threadSuffix}": ${fieldFix.repaired.map(r => `${r.path}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`).join(', ')}`);
            }
            if (fieldFix.unrepairable.length === 0) {
                // All issues fixed deterministically — validate the repaired value
                const rv = validateAgentOutput(schema, fieldFix.value);
                if (rv.ok) {
                    _recordRepaired();
                    invokeLog.info(`Agent "${threadSuffix}" repaired deterministically (${fieldFix.repaired.length} field fixes)`);
                    emitEnd({ repaired: true, fieldRepair: true });
                    return { output: rv.value, tokenUsage };
                }
            }
            // Fall through to LLM repair with remaining issues
            issuesForRepair = validation.issues;
        } else {
            // No schema, JSON parsed fine — return as-is
            emitEnd();
            return { output: parsed, tokenUsage };
        }

        // ── Truncation recovery: trim incomplete trailing array elements ──
        // When jsonrepair salvaged a truncated response, the last element(s)
        // of arrays (e.g. tasks, userStories) are often incomplete — missing
        // required fields. Rather than rejecting the entire 32K+ token output
        // or burning LLM repair attempts, trim those incomplete tails.
        if (parseResult.ok && parseResult.wasTruncated && schema && parsed !== undefined) {
            const trimResult = trimTruncatedArrayTails(parsed, schema);
            if (trimResult.ok && trimResult.trimmed.length > 0) {
                _recordRepaired();
                for (const t of trimResult.trimmed) {
                    invokeLog.info(`Truncation recovery: trimmed ${t.removedCount} incomplete element(s) from "${t.path}" for "${threadSuffix}"`);
                }
                if (extraction.truncatedByTokenLimit) {
                    invokeLog.warn(
                        `Agent "${threadSuffix}" output was truncated by token limit — `
                        + `accepted valid prefix after trimming ${trimResult.trimmed.length} array tail(s). `
                        + `Consider raising PLANNING_MAX_OUTPUT_TOKENS if this repeats.`,
                    );
                }
                emitEnd({ repaired: true, truncationRecovery: true });
                return { output: trimResult.value, tokenUsage };
            }
        }

        // ── Repair loop: fix JSON parse failures OR schema violations ─────
        // Attempt repair on a FRESH thread: avoid replaying the entire ReAct
        // history just to fix a schema violation. The repair message carries
        // the previous raw JSON so the model corrects rather than regenerates.
        for (let attempt = 0; attempt < AGENT_OUTPUT_REPAIR_ATTEMPTS; attempt++) {
            invokeLog.info(`Repair attempt ${attempt + 1}/${AGENT_OUTPUT_REPAIR_ATTEMPTS} for "${threadSuffix}"...`);
            const repairThreadId = `${threadId}-repair-${attempt}`;
            const repairMsg = buildRepairMessage(issuesForRepair, userMessage, raw);
            let repairResult: any;
            try {
                repairResult = await agent.invoke(
                    { messages: [{ role: 'user', content: repairMsg }] },
                    // Use PIPELINE_RECURSION_LIMIT to accommodate input processing +
                    // pre_model_hook + agent node steps. The previous value of 6 was
                    // too low for planning agents with large outputs (P2).
                    { configurable: { thread_id: repairThreadId }, recursionLimit: PIPELINE_RECURSION_LIMIT },
                );
            } catch (repairErr: any) {
                invokeLog.warn(`Repair attempt ${attempt + 1} for "${threadSuffix}" threw: ${repairErr?.message ?? repairErr}`);
                continue;
            }
            logAgentResponse({
                agentId, phase, model, threadId: repairThreadId, invocationId,
                kind: 'repair', attempt: attempt + 1, userMessage: repairMsg,
                systemPrompt: agent.systemPromptText,
            }, repairResult);
            // Normalise content blocks (same as main path above)
            const repairExtraction = extractAgentText(repairResult.messages);
            if (repairExtraction.text === null) {
                const repairLast = repairResult.messages[repairResult.messages.length - 1];
                invokeLog.warn(
                    `Repair attempt ${attempt + 1} for "${threadSuffix}" returned no text ` +
                    `(${repairExtraction.blockTypes})`,
                );
                // Non-text content — try validating it directly
                const rv = validateAgentOutput(schema!, repairLast?.content);
                if (rv.ok) {
                    _recordRepaired();
                    invokeLog.info(`Agent "${threadSuffix}" repaired on attempt ${attempt + 1}`);
                    emitEnd({ repaired: true, repairAttempt: attempt + 1 });
                    return { output: rv.value, tokenUsage };
                }
                continue;
            }
            const repairParse = parseAgentJson(repairExtraction.text.trim());
            if (!repairParse.ok) continue;
            const rv = validateAgentOutput(schema!, repairParse.value);
            if (rv.ok) {
                _recordRepaired();
                invokeLog.info(`Agent "${threadSuffix}" repaired on attempt ${attempt + 1}`);
                emitEnd({ repaired: true, repairAttempt: attempt + 1 });
                return { output: rv.value, tokenUsage };
            }
        }

        // All repair attempts failed — strict enforcement: throw instead of
        // returning unvalidated data that silently corrupts downstream state.
        _recordFailed();
        const errMsg = `Agent "${threadSuffix}" output invalid after ${AGENT_OUTPUT_REPAIR_ATTEMPTS} repair attempt(s). Issues: ${issuesForRepair}`;
        invokeLog.error(errMsg);
        emitEnd({ validationFailed: true });
        throw new Error(errMsg);
    }, threadSuffix);
}

// ─── Continue-run idempotency (Plan 23, Sub-Plan 04) ────────────────────────

/**
 * Phase ordering for continue-run skip logic.
 * Must match the pipeline flow defined in graph.ts.
 */
const CONTINUE_PHASE_ORDER: PhaseName[] = [
    'intake',
    'codebase-analyzer',
    'architect',
    'product-manager',
    'dba',
    'team-leader',
    'development',
    'qa',
    'bugfix-triage',
    'devops',
    'e2e',
    'acceptance-gate',
    'finalize',
];
const CONTINUE_PHASE_INDEX = new Map(CONTINUE_PHASE_ORDER.map((p, i) => [p, i]));

/**
 * Check whether a node should skip execution during a continuation run.
 *
 * Returns `true` when:
 *   1. `state._isContinuation` is true, AND
 *   2. `state._resumePhase` is set, AND
 *   3. The current phase's index is strictly before the resume phase's index
 *
 * Nodes at or after the resume phase execute normally.
 * This guard is intentionally conservative — if the indices cannot be resolved,
 * it returns `false` (execute the node).
 */
function shouldSkipOnContinue(
    state: ProjectStateType,
    currentPhase: PhaseName,
    logger: ReturnType<typeof getLogger>,
): boolean {
    if (!state._isContinuation || !state._resumePhase) return false;

    const currentIdx = CONTINUE_PHASE_INDEX.get(currentPhase);
    const resumeIdx = CONTINUE_PHASE_INDEX.get(state._resumePhase);

    if (currentIdx === undefined || resumeIdx === undefined) return false;

    if (currentIdx < resumeIdx) {
        logger.info(
            `Skipping ${currentPhase} — continuation resume target is ${state._resumePhase}`,
        );
        return true;
    }

    return false;
}

/**
 * Plan 25: Check if the run should stop due to budget exhaustion.
 * Returns a partial state update that sets `cancelled=true` and `_stopReason`
 * if the budget has reached 'stop' level, or `null` if the run should continue.
 *
 * Call this at the start of each node (after the continue-run skip check).
 * The graph's conditional edges already check `cancelled` and route to finalize.
 */
function checkBudgetStop(
    state: ProjectStateType,
    phase: PhaseName,
    logger: ReturnType<typeof getLogger>,
): Partial<ProjectStateType> | null {
    if (!shouldStopRun()) return null;

    const budget = getBudgetStatus();
    const reason = `budget-exhausted:${budget.binding}`;
    logger.warn(
        `Budget exhausted (${budget.binding} at ${(budget.utilisation * 100).toFixed(1)}%) ` +
        `— stopping run gracefully at phase "${phase}" for continue-run pickup`,
    );
    emitRunEvent('run:budget-stop', {
        phase,
        binding: budget.binding,
        utilisation: budget.utilisation,
        usedTokens: budget.usedTokens,
        estCostUsd: budget.estCostUsd,
        elapsedMs: budget.elapsedMs,
    });

    // Write a snapshot so continue-run has the latest state
    writePeriodicSnapshot(state.outputPath, state, phase);

    return {
        phase,
        cancelled: true,
        _stopReason: reason,
        transcript: [msg('conductor', phase, `Run stopped: budget exhausted (${budget.binding} at ${(budget.utilisation * 100).toFixed(1)}%)`)],
    };
}

// ─── 1. Intake ──────────────────────────────────────────────────────────────

const intakeLog = getLogger('[Intake]', 255);

export async function intakeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Idempotency guard: skip if already initialized (prevents re-creation on graph replay)
    if (state.outputPath && state.workspacePath) {
        intakeLog.info('Intake already completed — skipping (idempotent guard).');
        return {};
    }

    intakeLog.info('Starting intake phase...');
    emitRunEvent('phase:start', { phase: 'intake' });
    tokenTracker.reset();
    startRunBudget();

    let requirementsText = state.input.requirementsText;
    if (state.input.requirementsDocPath && !requirementsText) {
        intakeLog.info(`Parsing requirements from: ${state.input.requirementsDocPath}`);
        requirementsText = await parseRequirementsFile(state.input.requirementsDocPath);
        intakeLog.info(`Extracted ${requirementsText.length} characters`);
    }

    let workspacePath: string;
    if (state.input.runType === 'maintain') {
        // Maintain mode: use existing project directory as workspace
        const existingPath = state.input.existingProjectPath;
        if (!existingPath || !fs.existsSync(existingPath)) {
            throw new Error(`Existing project path not found: ${existingPath}`);
        }
        workspacePath = path.resolve(existingPath);
        intakeLog.info(`Maintain mode: using existing project at ${workspacePath}`);
        // Ensure docs/ subdir exists for artifacts
        fs.mkdirSync(path.join(workspacePath, 'docs', 'agents'), { recursive: true });
    } else {
        // Greenfield mode: create a new project workspace
        workspacePath = createProjectWorkspace(state.input.systemName);
    }

    const outputPath = createRunOutputDir(state.input.systemName);
    setRunLogPath(path.join(outputPath, 'run.log'));
    initLedger(outputPath);
    initResponseLog(outputPath);
    appendLedger({ kind: 'phase', phase: 'intake', event: 'start' });

    // ── Token report: create skeleton immediately so it exists on disk ───
    tokenTracker.enablePersistence(outputPath, state.input.systemName);
    tokenTracker.setRefreshCallback(() => refreshTokenReport());
    refreshTokenReport(); // Write the initial skeleton HTML
    intakeLog.info(`Token report skeleton created at ${outputPath}`);

    // ── Resolve GitContext based on repoTarget ───────────────────────────
    const repoTarget = state.input.repoTarget;
    const isSeparateRepo =
        state.input.runType !== 'maintain' &&
        (repoTarget?.type === 'new-repo' || repoTarget?.type === 'existing-repo');

    let gitRoot: string;
    let defaultBranch: string;
    let gitContext: GitContext;

    if (isSeparateRepo) {
        // ── Separate repo: create or validate, initialize locally ────────
        const projectToken = GITHUB_PROJECT_TOKEN || GITHUB_TOKEN;
        const projectOwner = GITHUB_PROJECT_OWNER || GITHUB_OWNER;

        if (!projectToken && GITHUB_MODE !== 'local') {
            throw new Error(
                'No GitHub token available for project repo. ' +
                'Set GITHUB_PROJECT_TOKEN or GITHUB_TOKEN in your environment.',
            );
        }
        if (!projectOwner && GITHUB_MODE !== 'local') {
            throw new Error(
                'No GitHub owner available for project repo. ' +
                'Set GITHUB_PROJECT_OWNER or GITHUB_OWNER in your environment.',
            );
        }

        const repoName = repoTarget!.repoName ?? state.input.systemName
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);

        if (repoTarget!.type === 'new-repo') {
            // Create a new GitHub repository
            intakeLog.info(`Creating new GitHub repo: ${projectOwner}/${repoName}`);
            const created = await createGitHubRepo(
                projectToken, projectOwner, repoName, repoTarget!.isPrivate ?? true,
            );
            defaultBranch = created.defaultBranch;

            // Initialize local workspace as a standalone git repo
            initializeRepoLocally(workspacePath, created.cloneUrl, defaultBranch, projectToken);
            // Fetch remote content (auto-initialized README)
            gitExec(workspacePath, 'fetch origin');
            // Align local branch with remote default branch
            const resetResult = gitExec(workspacePath, `reset --hard origin/${defaultBranch}`);
            if (resetResult.startsWith('Error:')) {
                intakeLog.warn(`Could not reset to origin/${defaultBranch} (remote may be empty): ${resetResult}`);
            }

            intakeLog.info(`New repo created: ${created.fullName} (${created.htmlUrl})`);
        } else {
            // Validate an existing GitHub repository
            intakeLog.info(`Validating existing repo: ${projectOwner}/${repoName}`);
            const validated = await validateGitHubRepo(projectToken, projectOwner, repoName);
            if (!validated.exists) {
                throw new Error(
                    `Repository ${projectOwner}/${repoName} not found or not accessible. ` +
                    `Ensure the repo exists and GITHUB_PROJECT_TOKEN has access.`,
                );
            }
            defaultBranch = validated.defaultBranch;

            // Initialize local workspace with remote
            initializeRepoLocally(workspacePath, validated.cloneUrl, defaultBranch, projectToken);
            // Fetch remote content
            gitExec(workspacePath, 'fetch origin');
            // Align local branch with remote default branch
            const resetResult = gitExec(workspacePath, `reset --hard origin/${defaultBranch}`);
            if (resetResult.startsWith('Error:')) {
                intakeLog.warn(`Could not reset to origin/${defaultBranch}: ${resetResult}`);
            }

            intakeLog.info(`Existing repo validated: ${validated.fullName}`);
        }

        gitRoot = workspacePath;
        gitContext = {
            token: projectToken,
            owner: projectOwner,
            repo: repoName,
            defaultBranch,
        };
    } else {
        // ── Same-repo: existing behavior ─────────────────────────────────
        try {
            gitRoot = findGitRoot(workspacePath);
        } catch {
            if (GITHUB_MODE === 'local') {
                // In local mode, init a repo and create a bare origin on the fly
                // so the system can run without any GitHub account (fixes A12).
                const bareRepoPath = path.join(outputPath, 'origin.git');
                execSync(`git init --bare "${bareRepoPath}"`, { encoding: 'utf-8', timeout: 10_000 });
                execSync(`git init -b main`, { cwd: workspacePath, encoding: 'utf-8', timeout: 10_000 });
                execSync(`git config user.name "AgenticDevTeam"`, { cwd: workspacePath, encoding: 'utf-8' });
                execSync(`git config user.email "agenticdevteam@noreply.github.com"`, { cwd: workspacePath, encoding: 'utf-8' });
                execSync(`git remote add origin "${bareRepoPath}"`, { cwd: workspacePath, encoding: 'utf-8' });
                execSync('git add -A && git commit --allow-empty -m "Initial commit"', { cwd: workspacePath, encoding: 'utf-8', timeout: 10_000 });
                execSync(`git push origin main`, { cwd: workspacePath, encoding: 'utf-8', timeout: 10_000 });
                intakeLog.info(`Local mode: initialized git repo and bare origin at ${bareRepoPath}`);
                gitRoot = workspacePath;
                setLocalBareRepoPath(bareRepoPath);
            } else {
                throw new Error(
                    `Workspace is not inside a Git repository: ${workspacePath}. ` +
                    `Initialize with 'git init' in a parent directory and configure a GitHub remote before running.`
                );
            }
        }
        defaultBranch = detectDefaultBranch(gitRoot);

        gitContext = {
            token: GITHUB_TOKEN,
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            defaultBranch,
        };

        // In local mode, record the bare repo path for pr-workflow
        if (GITHUB_MODE === 'local') {
            // If we didn't just create it, derive the bare repo path from outputPath
            const bareRepoPath = path.join(outputPath, 'origin.git');
            if (!fs.existsSync(bareRepoPath)) {
                // The repo may already exist (e.g. in same-repo mode with a real git root)
                // In that case, create the bare repo as a clone of origin
                execSync(`git init --bare "${bareRepoPath}"`, { encoding: 'utf-8', timeout: 10_000 });
                // Push existing content to it
                gitExec(gitRoot, `remote set-url origin "${bareRepoPath}"`);
            }
            setLocalBareRepoPath(bareRepoPath);
        }
    }

    intakeLog.info(`Git repo validated. Default branch: ${defaultBranch}, separate repo: ${isSeparateRepo}`);

    // ── Create or checkout the system branch (project/<system-name>) ─────
    const systemSlug = state.input.systemName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
    const systemBranch = `project/${systemSlug}`;

    // Check if the system branch already exists (remote or local)
    const remoteBranches = gitExec(gitRoot, 'branch -r').split('\n').map((b: string) => b.trim());
    const localBranches = gitExec(gitRoot, 'branch --list').split('\n').map((b: string) => b.trim().replace(/^\* /, ''));
    const existsRemote = remoteBranches.some((b: string) => b === `origin/${systemBranch}`);
    const existsLocal = localBranches.includes(systemBranch);

    if (state.input.runType === 'maintain') {
        // Maintain mode: checkout existing system branch, update from default branch
        if (existsLocal) {
            gitExec(gitRoot, `checkout ${systemBranch}`);
        } else if (existsRemote) {
            gitExec(gitRoot, `checkout -b ${systemBranch} origin/${systemBranch}`);
        } else {
            // System branch doesn't exist yet — create from default branch
            gitExec(gitRoot, `checkout ${defaultBranch}`);
            gitExec(gitRoot, `pull origin ${defaultBranch} --ff-only`);
            gitExec(gitRoot, `checkout -b ${systemBranch}`);
        }
        // Update from default branch
        gitExec(gitRoot, `merge ${defaultBranch} --no-edit`);
        intakeLog.info(`System branch: ${systemBranch} (maintain mode, updated from ${defaultBranch})`);
    } else {
        // Greenfield mode: create system branch from default branch
        gitExec(gitRoot, `checkout ${defaultBranch}`);
        gitExec(gitRoot, `pull origin ${defaultBranch} --ff-only`);
        if (existsLocal || existsRemote) {
            // Branch already exists — checkout and update
            if (existsLocal) {
                gitExec(gitRoot, `checkout ${systemBranch}`);
            } else {
                gitExec(gitRoot, `checkout -b ${systemBranch} origin/${systemBranch}`);
            }
            gitExec(gitRoot, `merge ${defaultBranch} --no-edit`);
        } else {
            gitExec(gitRoot, `checkout -b ${systemBranch}`);
        }
        intakeLog.info(`System branch: ${systemBranch} (greenfield)`);
    }
    // Push the system branch to remote
    const pushResult = gitPush(gitRoot, systemBranch, gitContext);
    if (pushResult.startsWith('Error:')) {
        intakeLog.error(`Failed to push system branch ${systemBranch}: ${pushResult}`);
    } else {
        intakeLog.info(`Pushed system branch: ${systemBranch}`);
    }

    // ── Keep scaffolding + common dependency dirs out of the repo ──────────
    const defaultGitignoreEntries = [
        ...getGitignoreEntriesForStack(), // common entries (no tech decisions yet)
        '.conventions/',
        '.worktrees/',
        '.worktrees-failed/',
        '.agent/',
    ];
    ensureProjectGitignore(workspacePath, defaultGitignoreEntries);

    // ── Sweep stale worktree leftovers from previous runs ────────────────
    try {
        gitExec(gitRoot, 'worktree prune');
        const worktreesDir = path.join(gitRoot, '.worktrees');
        if (fs.existsSync(worktreesDir)) {
            // List directories that git no longer tracks as active worktrees
            const trackedRaw = gitExec(gitRoot, 'worktree list --porcelain');
            const trackedPaths = new Set(
                trackedRaw.split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.slice('worktree '.length).trim()),
            );
            for (const entry of fs.readdirSync(worktreesDir)) {
                const entryPath = path.join(worktreesDir, entry);
                if (!fs.statSync(entryPath).isDirectory()) continue;
                if (!trackedPaths.has(entryPath)) {
                    fs.rmSync(entryPath, { recursive: true, force: true });
                    intakeLog.info(`Removed stale worktree leftover: ${entry}`);
                }
            }
        }
        // Sub-Plan 06 §3: Prune .worktrees-failed/ from previous runs
        const failedDir = path.join(gitRoot, '.worktrees-failed');
        if (fs.existsSync(failedDir)) {
            fs.rmSync(failedDir, { recursive: true, force: true });
            intakeLog.info('Pruned .worktrees-failed/ from previous run');
        }
    } catch (sweepErr) {
        intakeLog.warn(`Worktree sweep failed (non-fatal): ${sweepErr}`);
    }

    intakeLog.info(`Workspace: ${workspacePath}`);
    intakeLog.info(`Output: ${outputPath}`);
    intakeLog.info(`Run type: ${state.input.runType ?? 'greenfield'}`);

    const nextPhase = state.input.runType === 'maintain' ? 'codebase-analyzer' : 'architect';

    emitRunEvent('phase:end', { phase: 'intake', nextPhase });
    return {
        input: { ...state.input, requirementsText },
        workspacePath,
        outputPath,
        systemBranch,
        gitContext,
        phase: 'intake' as PhaseName,
        transcript: [msg('conductor', 'intake', `Intake complete (${state.input.runType ?? 'greenfield'}). System branch: ${systemBranch}. Repo: ${gitContext.owner}/${gitContext.repo}. Requirements: ${requirementsText.length} chars`)],
    };
}

// ─── 1b. Codebase Analyzer (maintain mode only) ─────────────────────────────

const analyzerLog = getLogger('[Analyzer]', 147);

export async function codebaseAnalyzerNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip if this phase completed in a previous run
    if (shouldSkipOnContinue(state, 'codebase-analyzer', analyzerLog)) {
        return { phase: 'codebase-analyzer' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'codebase-analyzer' });
    writePeriodicSnapshot(state.outputPath, state, 'codebase-analyzer');
    const budgetStop = checkBudgetStop(state, 'codebase-analyzer' as PhaseName, analyzerLog);
    if (budgetStop) return budgetStop;
    const rerunUpdate = checkRerun(state, 'codebase-analyzer', analyzerLog);
    analyzerLog.info('Starting codebase analysis...');
    const apiKey = await getAccessToken();
    const agent = createCodebaseAnalyzerAgent(apiKey, state.workspacePath);

    // Check for existing analysis to use as baseline
    const existingAnalysis = readExistingAnalysis(state.workspacePath);
    const contextParts: string[] = [];
    const feedbackSection = buildFeedbackSection(state, 'codebase-analyzer');
    if (feedbackSection) contextParts.push(feedbackSection);
    if (existingAnalysis) {
        analyzerLog.info('Found existing codebase-analysis.md — using as baseline');
        contextParts.push(`## Previous Codebase Analysis (use as baseline, update what changed)\n\n${existingAnalysis}`);
    }
    contextParts.push(`## Task\n\nAnalyze the codebase at the workspace root and produce a comprehensive CodebaseAnalysis.`);

    const userMsg = contextParts.join('\n\n');
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'codebase-analyzer', 'codebase-analyzer', 'codebase-analyzer', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: CodebaseAnalysisSchema });

    analyzerLog.info(`Analysis complete: ${output.modules?.length ?? 0} modules, ${output.primaryLanguages?.length ?? 0} languages`);
    analyzerLog.info(`Architecture: ${output.architecture?.style ?? 'unknown'}`);

    // Write analysis to both locations
    writeCodebaseAnalysis(output, state.workspacePath, state.outputPath);

    const artifact = writeArtifact({
        agentId: 'codebase-analyzer',
        colorCode: 147,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Codebase Analyzer Mission Report',
        content: [
            `## Project: ${output.projectName} (${output.projectType})`,
            `\n## Languages: ${(output.primaryLanguages ?? []).join(', ')}`,
            `\n## Frameworks: ${(output.frameworks ?? []).join(', ')}`,
            `\n## Architecture: ${output.architecture?.style}`,
            `\n${output.architecture?.description ?? ''}`,
            output.architecture?.mermaidDiagram ? `\n\`\`\`mermaid\n${sanitizeMermaidLabels(output.architecture.mermaidDiagram)}\n\`\`\`` : '',
            `\n## Modules (${(output.modules ?? []).length})`,
            ...(output.modules ?? []).map((m: any) => `- **${m.name}** (\`${m.path}\`): ${m.responsibility}`),
            `\n## Known Issues (${(output.knownIssues ?? []).length})`,
            ...(output.knownIssues ?? []).map((i: string) => `- ${i}`),
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: codebase analyzer mission report`,
        state.gitContext,
        analyzerLog,
    );

    emitRunEvent('phase:end', { phase: 'codebase-analyzer', nextPhase: 'architect' });
    return {
        ...rerunUpdate,
        codebaseAnalysis: output as CodebaseAnalysis,
        phase: 'codebase-analyzer' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('codebase-analyzer', 'codebase-analyzer', `Analyzed ${output.modules?.length ?? 0} modules across ${output.primaryLanguages?.length ?? 0} languages`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 2. Architect ───────────────────────────────────────────────────────────

const archLog = getLogger('[Architect]', 39);

export async function architectNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip if this phase completed in a previous run
    if (shouldSkipOnContinue(state, 'architect', archLog)) {
        return { phase: 'architect' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'architect' });
    writePeriodicSnapshot(state.outputPath, state, 'architect');
    const budgetStop = checkBudgetStop(state, 'architect' as PhaseName, archLog);
    if (budgetStop) return budgetStop;
    const rerunUpdate = checkRerun(state, 'architect', archLog);
    archLog.info('Starting architecture phase...');
    const apiKey = await getAccessToken();
    const agent = createArchitectAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'System Requirements', body: state.input.requirementsText, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'architect');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 2 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Design CHANGES to the existing system, not a new system from scratch.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    archLog.info(`Context [architect]: ${userMsg.length} chars`);
    recordContextChars('architect', userMsg.length);
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'architect', 'architect', 'architect', { schema: ArchitectOutputSchema });

    archLog.info(`Architecture: ${output.architecture?.components?.length ?? 0} components`);
    archLog.info(`Tech decisions: ${output.techStack?.length ?? 0}`);
    archLog.info(`Epics: ${output.epics?.length ?? 0}`);

    // ── Repo Contract (Sub-Plan 05) ──────────────────────────────────────
    let repoContract = output.repoContract ?? null;
    if (repoContract) {
        // Cap modules to REPO_CONTRACT_MAX_MODULES
        if (repoContract.modules.length > REPO_CONTRACT_MAX_MODULES) {
            archLog.warn(`Repo contract has ${repoContract.modules.length} modules — capping to ${REPO_CONTRACT_MAX_MODULES}`);
            repoContract = { ...repoContract, modules: repoContract.modules.slice(0, REPO_CONTRACT_MAX_MODULES) };
        }
        archLog.info(`Repo contract: layout=${repoContract.layout}, ${repoContract.roots.length} roots, ${repoContract.modules.length} modules`);
        try {
            writeRepoContract(state.workspacePath, repoContract);
        } catch (err: any) {
            archLog.error(`Failed to write repo contract: ${err.message}`);
        }
    } else {
        archLog.warn('Architect did not produce a repoContract');
    }

    const artifact = writeArtifact({
        agentId: 'architect',
        colorCode: 39,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Architect Mission Report',
        content: [
            `## Architecture Style\n\n${output.architecture?.style}`,
            `\n## Components\n\n${(output.architecture?.components ?? []).map((c: any) => `- **${c.name}** (${c.type}): ${c.description}`).join('\n')}`,
            `\n## Tech Stack\n\n${(output.techStack ?? []).map((t: any) => `- **${t.layer}**: ${t.choice} — ${t.rationale}`).join('\n')}`,
            `\n## Epics\n\n${(output.epics ?? []).map((e: any) => `- **${e.id}** ${e.title}: ${e.description}`).join('\n')}`,
            output.architecture?.mermaidDiagram ? `\n## Architecture Diagram\n\n\`\`\`mermaid\n${sanitizeMermaidLabels(output.architecture.mermaidDiagram)}\n\`\`\`` : '',
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: architect mission report`,
        state.gitContext,
        archLog,
    );

    emitRunEvent('phase:end', { phase: 'architect', nextPhase: 'product-manager' });
    return {
        ...rerunUpdate,
        architecture: output.architecture,
        repoContract,
        techStack: output.techStack ?? [],
        epics: output.epics ?? [],
        phase: 'architect' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('architect', 'architect', `Designed ${output.architecture?.components?.length ?? 0} components, ${output.epics?.length ?? 0} epics, contract: ${repoContract ? repoContract.modules.length + ' modules' : 'none'}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 3. Product Manager ─────────────────────────────────────────────────────

const pmLog = getLogger('[Product Manager]', 214);

export async function productManagerNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip if this phase completed in a previous run
    if (shouldSkipOnContinue(state, 'product-manager', pmLog)) {
        return { phase: 'product-manager' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'product-manager' });
    writePeriodicSnapshot(state.outputPath, state, 'product-manager');
    const budgetStop = checkBudgetStop(state, 'product-manager' as PhaseName, pmLog);
    if (budgetStop) return budgetStop;
    const rerunUpdate = checkRerun(state, 'product-manager', pmLog);
    pmLog.info('Starting product management phase...');
    const apiKey = await getAccessToken();
    const agent = createProductManagerAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 1 },
            { title: 'Epics', body: summariseEpics(state.epics), priority: 1 },
            { title: 'Original Requirements', body: state.input.requirementsText, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'product-manager');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Create stories/tasks for CHANGES to the existing system.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    pmLog.info(`Context [product-manager]: ${userMsg.length} chars`);
    recordContextChars('product-manager', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'pm', 'product-manager', 'product-manager', { schema: ProductManagerOutputSchema });
    pmLog.info(`Stories: ${output.userStories?.length ?? 0}, Tasks: ${output.tasks?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'product-manager',
        colorCode: 214,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Product Manager Mission Report',
        content: [
            `## User Stories (${output.userStories?.length ?? 0})\n`,
            ...(output.userStories ?? []).map((s: any) => `### ${s.id}: As a ${s.asA}, I want ${s.iWant}\n- So that: ${s.soThat}\n- AC: ${s.acceptanceCriteria?.join('; ')}`),
            `\n## Tasks (${output.tasks?.length ?? 0})\n`,
            ...(output.tasks ?? []).map((t: any) => `- **${t.id}** [${t.layer}/${t.suggestedTech}] ${t.title}`),
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: product manager mission report`,
        state.gitContext,
        pmLog,
    );

    emitRunEvent('phase:end', { phase: 'product-manager', nextPhase: 'dba' });
    return {
        ...rerunUpdate,
        userStories: output.userStories ?? [],
        tasks: output.tasks ?? [],
        phase: 'product-manager' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('product-manager', 'product-manager', `Created ${output.userStories?.length ?? 0} stories, ${output.tasks?.length ?? 0} tasks`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 4. DBA ─────────────────────────────────────────────────────────────────

const dbaLog = getLogger('[DBA]', 100);

export async function dbaNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip if this phase completed in a previous run
    if (shouldSkipOnContinue(state, 'dba', dbaLog)) {
        return { phase: 'dba' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'dba' });
    writePeriodicSnapshot(state.outputPath, state, 'dba');
    const budgetStop = checkBudgetStop(state, 'dba' as PhaseName, dbaLog);
    if (budgetStop) return budgetStop;
    const rerunUpdate = checkRerun(state, 'dba', dbaLog);
    dbaLog.info('Starting database design phase...');
    const apiKey = await getAccessToken();
    const agent = createDbaAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 3 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 2 },
            { title: 'User Stories', body: summariseStories(state.userStories), priority: 2 },
            { title: 'Tasks', body: summariseTasks(state.tasks), priority: 3 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'dba');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Design only the DB CHANGES needed, not the full schema from scratch.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    dbaLog.info(`Context [dba]: ${userMsg.length} chars`);
    recordContextChars('dba', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'dba', 'dba', 'dba', { schema: DbaOutputSchema });
    dbaLog.info(`DB engine: ${output.dbDesign?.engine}, Entities: ${output.dbDesign?.entities?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'dba',
        tag: '[DBA]',
        colorCode: 100,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'DBA Mission Report',
        content: [
            `## Database Engine: ${output.dbDesign?.engine}\n\n${output.dbDesign?.rationale}`,
            `\n## Entities (${output.dbDesign?.entities?.length ?? 0})\n`,
            ...(output.dbDesign?.entities ?? []).map((e: any) => `- **${e.name}**: ${e.columns?.length ?? 0} columns`),
            output.dbDesign?.erdMermaid ? `\n## ERD\n\n\`\`\`mermaid\n${sanitizeMermaidLabels(output.dbDesign.erdMermaid)}\n\`\`\`` : '',
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: DBA mission report`,
        state.gitContext,
        dbaLog,
    );

    emitRunEvent('phase:end', { phase: 'dba', nextPhase: 'team-leader' });
    return {
        ...rerunUpdate,
        dbDesign: output.dbDesign,
        phase: 'dba' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('dba', 'dba', `Designed ${output.dbDesign?.entities?.length ?? 0} entities on ${output.dbDesign?.engine}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 5. Team Leader ─────────────────────────────────────────────────────────

const tlLog = getLogger('[Team Leader]', 213);

export async function teamLeaderNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip if this phase completed in a previous run
    if (shouldSkipOnContinue(state, 'team-leader', tlLog)) {
        return { phase: 'team-leader' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'team-leader' });
    writePeriodicSnapshot(state.outputPath, state, 'team-leader');
    const budgetStop = checkBudgetStop(state, 'team-leader' as PhaseName, tlLog);
    if (budgetStop) return budgetStop;
    const rerunUpdate = checkRerun(state, 'team-leader', tlLog);
    tlLog.info('Starting assignment phase...');
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const projectSlug = state.systemBranch.replace(/^project\//, '');

    let userMsg: string;
    {
        // Give the TL full acceptance criteria instead of just counts (P8)
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 1 },
            { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
            { title: 'User Stories (with Acceptance Criteria)', body: storiesWithCriteria(state.userStories), priority: 1 },
            { title: 'Tasks', body: summariseTasks(state.tasks), priority: 1 },
            { title: 'Project Slug', body: `${projectSlug}\nUse this slug as the prefix for all branch names (e.g., "${projectSlug}/feature/US-001-description").`, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'team-leader');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Assignments may involve modifying existing files.', priority: 1 });
        }
        userMsg = buildContext(sections, TEAM_LEADER_CONTEXT_MAX_CHARS);
    }
    tlLog.info(`Context [team-leader]: ${userMsg.length} chars`);
    recordContextChars('team-leader', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'tl', 'team-leader', 'team-leader', { schema: TeamLeaderOutputSchema });
    let assignments = output.assignments ?? [];
    tlLog.info(`Assignments: ${assignments.length}`);
    if (output.coverageNote) tlLog.info(`Coverage self-check: ${output.coverageNote}`);

    // ── Plan coverage validation (P9) ────────────────────────────────────
    // Build a temporary state snapshot with the new assignments for validation
    if (PLAN_COVERAGE_MODE !== 'off') {
        const tempState = { ...state, assignments: [...state.assignments, ...assignments] };
        let violations = validateAssignmentPlan(tempState);

        // Gap-repair: re-invoke the TL with a targeted prompt
        for (let attempt = 0; attempt < PLAN_COVERAGE_REPAIR_ATTEMPTS && violations.length > 0; attempt++) {
            const criticalCount = violations.filter(v => v.severity === 'critical').length;
            if (criticalCount === 0) break;

            const nextId = assignments.length > 0
                ? Math.max(...assignments.map((a: { id: string }) => parseInt(a.id.replace(/\D/g, '') || '0', 10))) + 1
                : 1;
            const gapPrompt = buildCoverageGapPrompt(violations, nextId);
            tlLog.info(`Plan coverage repair attempt ${attempt + 1}/${PLAN_COVERAGE_REPAIR_ATTEMPTS}: ${violations.length} violation(s), ${criticalCount} critical`);

            try {
                const { output: gapOutput } = await invokeAgent(agent, gapPrompt, `tl-gap-${attempt}`, 'team-leader', 'team-leader', { schema: TeamLeaderOutputSchema });
                const additions = gapOutput.assignments ?? [];
                if (additions.length > 0) {
                    tlLog.info(`Gap repair produced ${additions.length} additional assignment(s)`);
                    assignments = assignments.concat(additions);
                    const revalidateState = { ...state, assignments: [...state.assignments, ...assignments] };
                    violations = validateAssignmentPlan(revalidateState);
                }
            } catch (err: any) {
                tlLog.warn(`Gap repair attempt ${attempt + 1} failed: ${err?.message ?? err}`);
            }
        }

        // Log the funnel
        const funnelState = { ...state, assignments: [...state.assignments, ...assignments] };
        logPlanFunnel(funnelState);

        if (violations.length > 0) {
            const criticalCount = violations.filter(v => v.severity === 'critical').length;
            const summaryMsg = `Coverage: ${state.userStories.length - violations.filter(v => v.kind === 'story-without-assignment').length}/${state.userStories.length} stories assigned, ${violations.length} violation(s) (${criticalCount} critical)`;
            if (PLAN_COVERAGE_MODE === 'enforce') {
                for (const v of violations) tlLog.error(`[PLAN] ${v.severity}: ${v.detail}`);
                tlLog.error(summaryMsg);
            } else {
                for (const v of violations) tlLog.warn(`[PLAN] ${v.severity}: ${v.detail}`);
                tlLog.warn(summaryMsg);
            }
            emitRunEvent('plan:coverage', { violations: violations.length, stories: state.userStories.length, assigned: state.userStories.length - violations.filter(v => v.kind === 'story-without-assignment').length });
        } else {
            tlLog.info(`Plan coverage: all stories and tasks assigned — 0 violations`);
        }
    }

    // ── Post-plan branch consolidation (Plan 24, E3) ─────────────────────
    {
        const { assignments: consolidated, consolidationLog } = consolidateBranches(
            assignments,
            MAX_BRANCHES,
            state.userStories,
        );
        if (consolidationLog.length > 0) {
            for (const line of consolidationLog) tlLog.info(`[CONSOLIDATION] ${line}`);
        }
        assignments = consolidated;
    }

    const artifact = writeArtifact({
        agentId: 'team-leader',
        colorCode: 213,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Team Leader Mission Report',
        content: [
            `## Assignments (${assignments.length})\n`,
            ...assignments.map((a: any) =>
                `### ${a.id} -> ${a.devAgentId} [${a.rank}]\n- Priority: ${a.priority} | Complexity: ${a.complexity}\n- ${a.description}`
            ),
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: team leader mission report`,
        state.gitContext,
        tlLog,
    );

    // Collect plan violations for state (used by acceptance gate SCOPE criterion)
    const planViolations = PLAN_COVERAGE_MODE !== 'off'
        ? validateAssignmentPlan({ ...state, assignments: [...state.assignments, ...assignments] })
            .map(v => ({ kind: v.kind, severity: v.severity, id: v.id, detail: v.detail }))
        : [];

    emitRunEvent('phase:end', { phase: 'team-leader', nextPhase: 'development' });
    return {
        ...rerunUpdate,
        assignments,
        planViolations,
        phase: 'team-leader' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('team-leader', 'team-leader', `Created ${assignments.length} assignments`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 6. Development (fan-out) ───────────────────────────────────────────────

const devLog = getLogger('[Development]', 226);

export async function developmentNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip if this phase completed in a previous run.
    // Development uses selectPendingAssignments() internally, so partially-completed
    // development will still dispatch only the remaining assignments.
    if (shouldSkipOnContinue(state, 'development', devLog)) {
        return { phase: 'development' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'development' });
    writePeriodicSnapshot(state.outputPath, state, 'development');
    const budgetStop = checkBudgetStop(state, 'development' as PhaseName, devLog);
    if (budgetStop) return budgetStop;
    const haltUpdate = haltIfUnrecoverable(state, devLog, RUN_FAIL_POLICY);
    if (haltUpdate) return { ...haltUpdate, phase: 'development' as PhaseName };
    const rerunUpdate = checkRerun(state, 'development', devLog);
    devLog.info(`Starting development with ${state.assignments.length} assignments...`);

    // ── Retry any PR-creation-failed branches from a previous run ─────────
    const failedPRs = (state.pullRequests ?? []).filter((pr: PullRequest) => pr.status === 'pr-creation-failed');
    if (failedPRs.length > 0) {
        devLog.info(`Found ${failedPRs.length} branch(es) with pr-creation-failed — retrying PR creation`);
        const retriedPRs: PullRequest[] = [];
        const retriedTranscript: TranscriptMessage[] = [];
        for (const failedPR of failedPRs) {
            try {
                const updatedPR = await retryFailedPRCreation(failedPR, state.systemBranch, state.gitContext);
                retriedPRs.push(updatedPR);
                retriedTranscript.push(msg('conductor', 'development', `PR creation retry succeeded for ${failedPR.branchName}: PR #${updatedPR.prNumber}`));
            } catch (retryErr: any) {
                devLog.error(`PR creation retry failed again for ${failedPR.branchName}: ${retryErr.message}`);
                retriedTranscript.push(msg('conductor', 'development', `PR creation retry failed again for ${failedPR.branchName}: ${retryErr.message} — stopping run`));
                // Return immediately — stop the run gracefully so continue-run can try again later
                return {
                    ...rerunUpdate,
                    phase: 'development' as PhaseName,
                    pullRequests: [failedPR], // preserve the failed PR in state
                    transcript: retriedTranscript,
                };
            }
        }
        // If all retries succeeded, update the PR entries and mark their assignments as needing
        // review (they'll flow through the normal review/merge path on the next dispatch)
        if (retriedPRs.length > 0) {
            devLog.info(`Successfully retried ${retriedPRs.length} PR(s) — updating state`);
            // Replace the failed PRs with the retried ones in state
            const otherPRs = (state.pullRequests ?? []).filter((pr: PullRequest) => pr.status !== 'pr-creation-failed');
            return {
                ...rerunUpdate,
                phase: 'development' as PhaseName,
                pullRequests: [...otherPRs, ...retriedPRs],
                transcript: retriedTranscript,
            };
        }
    }

    // ── Filter to only pending assignments (fixes A2) ────────────────────
    const pending = selectPendingAssignments(state.assignments, state.completedAssignmentIds);
    devLog.info(`Development: ${pending.length} pending of ${state.assignments.length} total assignments (${state.completedAssignmentIds.length} already complete)`);
    if (pending.length === 0) {
        devLog.warn('No pending assignments — skipping development phase');
        emitRunEvent('phase:end', { phase: 'development', nextPhase: 'qa', skipped: true });
        return { phase: 'development' as PhaseName, transcript: [msg('conductor', 'development', 'No pending assignments')] };
    }

    const apiKey = await getAccessToken();

    // Deploy only the convention files the dispatched agents need (fixes A11)
    const devLanguages = [...new Set(
        pending.flatMap(a => getDevAgent(a.devAgentId)?.languages ?? []),
    )];
    const devConventionFiles = resolveConventionFiles(devLanguages, state.techStack);
    deployConventionsToWorkspace(state.workspacePath, devConventionFiles);

    // Enhance .gitignore with tech-stack-specific entries now that we know the stack
    const stackGitignoreEntries = [
        ...getGitignoreEntriesForStack(state.techStack),
        '.conventions/',
        '.worktrees/',
        '.agent/',
    ];
    ensureProjectGitignore(state.workspacePath, stackGitignoreEntries);

    let contextPrompt: string;
    {
        // Build the shared context sections (stories are added per-branch in the dispatcher)
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 1 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 1 },
            { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
            { title: 'Files Already Written', body: summariseFileChanges(state.fileChanges, DEV_CONTEXT_FILE_CHANGES_LIMIT), priority: 3 },
        ];
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Modify existing files where appropriate rather than creating new ones.', priority: 1 });
        }
        contextPrompt = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    devLog.info(`Context [development]: ${contextPrompt.length} chars`);
    recordContextChars('development', contextPrompt.length);
    const projectSlug = state.systemBranch.replace(/^project\//, '');

    const isMaintainMode = state.codebaseAnalysis != null;
    const result = await dispatchDevelopers(apiKey, pending, state.workspacePath, contextPrompt, state.systemBranch, projectSlug, state.gitContext, state.techStack, state.completedAssignmentIds, state.userStories, isMaintainMode, state.outputPath, state.tasks);

    devLog.info(`Development complete: ${result.fileChanges.length} file changes, ${result.pullRequests.length} PRs`);
    if (result.completionEvidence.length > 0) {
        const incomplete = result.completionEvidence.filter(e => !e.merged || e.filesChanged === 0 || !e.gatePassed);
        if (incomplete.length > 0) {
            devLog.warn(`${incomplete.length} assignment(s) merged without full evidence — will be re-evaluated`);
        }
    }
    if (result.salvageBranches.length > 0) {
        devLog.warn(`${result.salvageBranches.length} branch(es) salvaged (not merged): ${result.salvageBranches.join(', ')}`);
    }

    // Plan 25: provider failure — stop gracefully so continue-run can pick up
    if (result.providerFailureKind) {
        const reason = `provider-${result.providerFailureKind}`;
        devLog.error(`Provider failure (${result.providerFailureKind}) — routing to finalize for graceful shutdown`);
        writePeriodicSnapshot(state.outputPath, state, 'development');
        return {
            ...rerunUpdate,
            fileChanges: result.fileChanges,
            artifacts: result.artifacts,
            pullRequests: result.pullRequests,
            completedAssignmentIds: result.completedAssignmentIds,
            completionEvidence: result.completionEvidence,
            salvageBranches: result.salvageBranches,
            transcript: [
                ...result.transcript,
                msg('conductor', 'development', `Run stopped: provider failure (${result.providerFailureKind})`),
            ],
            phase: 'development' as PhaseName,
            tokenUsage: result.tokenUsage ?? [],
            cancelled: true,
            _stopReason: reason,
        };
    }

    // ── Sync workspace to merged system branch (fixes A1) ────────────────
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(state.workspacePath);
    } catch {
        gitRoot = state.workspacePath;
    }
    const syncResult = syncWorkspaceToBranch(gitRoot, state.systemBranch, state.gitContext);
    devLog.info(`Workspace synced to origin/${state.systemBranch}: ${syncResult.details}`);

    // Warn if the workspace still looks sourceless after sync
    const lsFiles = gitExec(gitRoot, 'ls-files');
    if (!lsFiles.startsWith('Error:')) {
        const files = lsFiles.split('\n').filter(Boolean);
        if (looksSourceless(files)) {
            devLog.error(`WARNING: Workspace appears sourceless after sync — QA and DevOps will see no application code. Files: ${files.length}`);
            result.transcript.push(msg('conductor', 'development', `ERROR: Workspace is sourceless after development sync — PR merges may not have landed`));
        }
    }

    // Plan 24, F1–F3: Assembly gate — check wiring and asset completeness
    // Only run when we have at least one merged PR (otherwise there's nothing to assemble)
    if (result.pullRequests.some(pr => pr.status === 'merged')) {
        const assemblyResult = runAssemblyGate(state.workspacePath);
        if (!assemblyResult.passed) {
            devLog.warn(`Assembly gate failed: ${assemblyResult.summary}`);
            result.transcript.push(msg('conductor', 'development', `Assembly gate: ${assemblyResult.summary}`));
            emitRunEvent('gate:result', { gate: 'assembly', passed: false, summary: assemblyResult.summary });

            // Synthesize a bug for the assembly issue
            const assemblyBugs = [];
            if (assemblyResult.missingAssets.length > 0) {
                assemblyBugs.push({
                    id: 'ASSEMBLY-MISSING-ASSETS',
                    title: `${assemblyResult.missingAssets.length} referenced asset(s) missing from disk`,
                    severity: 'major' as const,
                    stepsToReproduce: `Check referenced assets in HTML: ${assemblyResult.missingAssets.slice(0, 5).join(', ')}`,
                    expectedBehavior: 'All referenced assets should exist on disk',
                    actualBehavior: `${assemblyResult.missingAssets.length} assets not found`,
                    suspectedArea: 'public/ or src/assets/ directory',
                    reportedBy: 'assembly-gate',
                });
            }
            if (assemblyResult.unwiredModules.length > 0) {
                assemblyBugs.push({
                    id: 'ASSEMBLY-UNWIRED',
                    title: 'Entry point does not import product modules',
                    severity: 'critical' as const,
                    stepsToReproduce: 'Check the entry point (main.ts/index.ts) for module imports',
                    expectedBehavior: 'Entry point should import all declared modules',
                    actualBehavior: `Entry point has no imports: ${assemblyResult.unwiredModules.join(', ')}`,
                    suspectedArea: 'src/main.ts or src/index.ts',
                    reportedBy: 'assembly-gate',
                });
            }
            // Add assembly bugs to state bugs for bugfix triage to pick up
            result.transcript.push(msg('conductor', 'development', `Assembly gate synthesized ${assemblyBugs.length} bug(s)`));
        } else {
            devLog.info(`Assembly gate passed: ${assemblyResult.summary}`);
            emitRunEvent('gate:result', { gate: 'assembly', passed: true, summary: assemblyResult.summary });
        }
    }

    // Record this dispatch round so detectUnrecoverable() can spot a runaway
    // zero-output loop. Only MERGED PRs count — `PR-SKIPPED-*` placeholders are
    // recorded for no-commit branches and would otherwise mask total failure
    // (Plan 21, E3: this channel was declared but never written).
    const mergedPrCount = result.pullRequests.filter(pr => pr.status === 'merged').length;
    const round: DispatchRound = {
        fileChanges: result.fileChanges.length,
        prs: mergedPrCount,
        completed: result.completedAssignmentIds.length,
    };
    if (round.fileChanges === 0 && round.prs === 0) {
        devLog.error(`Dispatch round produced no file changes and no merged PRs (${result.pullRequests.length} PR record(s), all skipped/unmerged)`);
    }

    emitRunEvent('phase:end', { phase: 'development', nextPhase: 'qa', fileChanges: result.fileChanges.length, prs: mergedPrCount });
    return {
        ...rerunUpdate,
        dispatchRounds: [round],
        fileChanges: result.fileChanges,
        artifacts: result.artifacts,
        pullRequests: result.pullRequests,
        completedAssignmentIds: result.completedAssignmentIds,
        completionEvidence: result.completionEvidence,
        salvageBranches: result.salvageBranches,
        transcript: [
            ...result.transcript,
            msg('conductor', 'development', `Development phase complete: ${result.fileChanges.length} files changed, ${result.pullRequests.length} PRs merged. Sync: ${syncResult.details}`),
        ],
        phase: 'development' as PhaseName,
        tokenUsage: result.tokenUsage ?? [],
    };
}

// ─── 7. QA ──────────────────────────────────────────────────────────────────

const qaLog = getLogger('[QA Lead]', 198);

export async function qaNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past QA
    if (shouldSkipOnContinue(state, 'qa', qaLog)) {
        return { phase: 'qa' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'qa' });
    writePeriodicSnapshot(state.outputPath, state, 'qa');
    const budgetStop = checkBudgetStop(state, 'qa' as PhaseName, qaLog);
    if (budgetStop) return budgetStop;
    const haltQa = haltIfUnrecoverable(state, qaLog, RUN_FAIL_POLICY);
    if (haltQa) return { ...haltQa, phase: 'qa' as PhaseName };
    const rerunUpdate = checkRerun(state, 'qa', qaLog);
    qaLog.info('Starting QA phase...');
    const apiKey = await getAccessToken();
    const transcript: TranscriptMessage[] = [];
    const allBugs: Bug[] = [];

    // ── Sync workspace before QA (idempotent — protects HITL resume) ─────
    let qaGitRoot: string;
    try {
        qaGitRoot = findGitRoot(state.workspacePath);
    } catch {
        qaGitRoot = state.workspacePath;
    }
    const qaSyncResult = syncWorkspaceToBranch(qaGitRoot, state.systemBranch, state.gitContext);
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
                        // Whole-story coverage: mark all ACs for that story
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
                const planGapBugs: Bug[] = uncoveredAcs.slice(0, 15).map(gap => ({
                    id: `QA-PLAN-GAP-${gap.storyId}-${gap.acIndex}`,
                    title: `QA plan omits AC: ${gap.storyId} AC#${gap.acIndex}`,
                    severity: 'major' as const,
                    stepsToReproduce: `Story ${gap.storyId}, AC#${gap.acIndex}: "${gap.acText}"`,
                    expectedBehavior: `QA test plan should include at least one item for this criterion`,
                    actualBehavior: `No test plan item references ${gap.storyId} AC#${gap.acIndex}`,
                    suspectedArea: `Story ${gap.storyId}`,
                    reportedBy: 'qa-plan-coverage',
                }));
                allBugs.push(...planGapBugs);
            }
        }
    } catch (err: any) {
        // Log the model name and the provider's error body on one line — the
        // pacmanclaude run needed a package dive to work out that the 400
        // "Unsupported parameter: 'response_format'" came from QA_MODEL routing
        // through the OpenAI Responses API (Plan 21, E2).
        const providerBody = err?.error ? JSON.stringify(err.error) : (err?.response?.data ? JSON.stringify(err.response.data) : '');
        qaLog.error(`QA Lead failed [model=${QA_MODEL}${err?.status ? `, status=${err.status}` : ''}]: ${err.message}${providerBody ? ` | provider: ${providerBody}` : ''}`);
        if (err?.stack) qaLog.error(err.stack);
        transcript.push(msg('qa-lead', 'qa', `QA Lead failed [model=${QA_MODEL}]: ${err.message}`));
    }

    // 7b. QA Unit — write & run unit/integration tests
    // Sub-Plan 09: invoke qa-unit per story (bounded by QA_MAX_INVOCATIONS),
    // then run the real test suite and use the runner's output as the
    // authoritative signal. The agent's self-report is advisory only.
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
        // Sub-Plan 09 §6: QA crash synthesises a bug — silence must never be an option
        allBugs.push({
            id: 'QA-UNIT-FAILED',
            title: 'QA Unit agent crashed',
            severity: 'critical' as const,
            stepsToReproduce: `QA Unit agent threw: ${err.message}`,
            expectedBehavior: 'QA should write and run tests successfully',
            actualBehavior: `Agent crashed: ${err.message}`,
            suspectedArea: 'QA agent invocation',
            reportedBy: 'qa-node',
        });
    }

    // Commit QA-generated files via the shared helper (includes sync + retry)
    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-chore: QA unit test files`,
        state.gitContext,
        qaLog,
    );

    // ── Sub-Plan 09: Run the real test suite ─────────────────────────────
    // The deterministic runner's output is the authoritative signal.
    // The agent's self-report is advisory — discrepancies are recorded.
    const roots = detectStackRoots(state.workspacePath);
    const reportDir = path.join(state.outputPath, 'test-reports');
    fs.mkdirSync(reportDir, { recursive: true });

    const executedReports: ExecutedTestReport[] = [];
    for (const root of roots) {
        try {
            const result = runTests(root, {
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
    const testReports = [
        ...authoritativeReports,
        // Keep the claimed report for reference but it does NOT drive routing
        ...(unitOutput?.testReport ? [{
            ...unitOutput.testReport,
            source: 'claimed' as const,
            cases: unitOutput.testReport.cases ?? [],
        }] : []),
    ];

    // ── Test sufficiency check ───────────────────────────────────────────
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
        allBugs.push({
            id: 'QA-LEAD-FAILED',
            title: 'QA Lead agent produced no test plan',
            severity: 'critical' as const,
            stepsToReproduce: 'QA Lead agent either crashed or returned an empty test plan',
            expectedBehavior: 'QA Lead should produce a test plan covering all acceptance criteria',
            actualBehavior: 'No test plan was produced',
            suspectedArea: 'QA Lead agent invocation',
            reportedBy: 'qa-node',
        });
    }

    const artifacts = [...(leadArtifact ? [leadArtifact] : []), ...(unitArtifact ? [unitArtifact] : [])];

    // ── Deterministic quality gate (fixes A6) ────────────────────────────
    // Run the real build/lint/test pipeline and compare with the agent's
    // self-report. The gate report drives afterQaRouter, so a hallucinated
    // 'pass' from qa-unit can no longer suppress the bug-fix loop.
    let latestGateReport: import('./quality-gates').GateReport | null = null;
    const verificationErrors: Array<{ stage: string; message: string }> = [];
    try {
        // Run product verification (full mode: artifacts + resolve + smoke)
        // `roots` already computed above for the test runner
        let productVerifyReport;
        try {
            productVerifyReport = await runProductVerification(state.workspacePath, roots, 'full');
            const artOk = productVerifyReport.artifacts.filter(a => a.passed).length;
            qaLog.info(`Product verification: artifacts=${artOk}/${productVerifyReport.artifacts.length}, unresolved refs=${productVerifyReport.resolveIssues.length}, smoke=${productVerifyReport.smoke?.passed ? 'pass' : productVerifyReport.smoke?.ran ? 'fail' : 'skipped'}`);
        } catch (pvErr: any) {
            qaLog.warn(`Product verification error (non-fatal): ${pvErr.message}`);
            verificationErrors.push({ stage: 'product-verify', message: pvErr.message });
        }

        const gateReport = runQualityGates(state.workspacePath, {
            productVerify: productVerifyReport,
        });
        latestGateReport = gateReport;
        const gateTestReport = gateReportToTestReport(gateReport, 'quality-gates');
        testReports.push(gateTestReport);

        // Warn when the agent claimed pass but the gate failed
        const agentClaimedPass = unitOutput?.testReport?.status === 'pass';
        if (agentClaimedPass && gateTestReport.status === 'fail') {
            qaLog.warn(`QA agent reported status='pass' but quality gates FAILED — keeping both reports (gate report drives bug-fix loop)`);
            transcript.push(msg('quality-gates', 'qa', `WARNING: QA agent self-reported pass but quality gates failed — deterministic gate overrides`));
        }

        // Synthesise bugs for failing gate steps and product verification
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

    // ── Security gate (secret scan, dependency audit, licence check) ────
    try {
        const securityReport = runSecurityGates(state.workspacePath);

        // Write Security Report artifact
        writeArtifact({
            agentId: 'security-gates', colorCode: 196, workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'Security Report',
            content: `## Security Report\n\n${securityReportToMarkdown(securityReport)}`,
        });

        if (securityReport.findings.length > 0) {
            qaLog.warn(`Security gate: ${securityReport.findings.length} finding(s), ${securityReport.findings.filter(f => f.severity === 'critical').length} critical`);

            // Synthesise bugs for critical/major findings when SECURITY_GATE_BLOCKING=true
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

    // ── AC coverage gate (Sub-Plan 10) ───────────────────────────────
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

            // Emit a TestReport-shaped signal so afterQaRouter can see the failure
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
                // Identify gaps — prioritise missing over implemented-untested
                const missingGaps = traceReport.rows.filter(r => r.status === 'missing');
                const failingGaps = traceReport.rows.filter(r => r.status === 'tested-failing');
                const untestedGaps = traceReport.rows.filter(r => r.status === 'implemented-untested');
                const blockedGaps = traceReport.rows.filter(r => r.status === 'blocked');
                const prioritised = [...missingGaps, ...failingGaps, ...blockedGaps, ...untestedGaps];

                const acBugs: Bug[] = prioritised.slice(0, MIN_AC_COVERAGE_MAX_BUGS).map(row => ({
                    id: `AC-${row.storyId}-${row.acIndex}`,
                    title: `Acceptance criterion not verified: ${row.storyId} AC#${row.acIndex}`,
                    severity: 'critical' as const,
                    stepsToReproduce: `Story ${row.storyId}, AC#${row.acIndex}: "${row.acText}"`,
                    expectedBehavior: `A test named "[${row.storyId}#${row.acIndex}] ..." exists, is executed, and passes`,
                    actualBehavior: `Status "${row.status}" — ${
                        row.status === 'missing' ? 'no assignment references this story'
                        : row.status === 'tested-failing' ? 'test exists but fails'
                        : row.status === 'blocked' ? 'PR blocked/conflicted'
                        : 'code merged but no tagged test executed'}`,
                    suspectedArea: row.assignmentIds[0] ? `Assignment ${row.assignmentIds[0]}` : `Story ${row.storyId}`,
                    reportedBy: 'ac-coverage-gate',
                }));
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

    // ── Compute fixedBugIds by re-evaluation (fixes E5) ────────────────
    // A bug is fixed when it was previously attempted and is NOT present
    // in the freshly synthesised bug set. Gate bugs use stable ids
    // (GATE-node-build, PRODUCT-RESOLVE, ACCEPT-BUILD), so this is set difference.
    const currentBugIds = new Set(allBugs.map(b => b.id));
    const attemptedSet = new Set(state.attemptedBugIds ?? []);
    const newlyFixed = [...attemptedSet].filter(id => !currentBugIds.has(id));

    // Sub-Plan 09 invariant: testReports must never be empty after qaNode.
    // If the runner produced nothing AND the agent produced nothing, emit an
    // inconclusive report so downstream routers always have signal.
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
}

// ─── 8. Bug-fix Triage ──────────────────────────────────────────────────────

const bugLog = getLogger('[BugTriage]', 196);

export async function bugfixTriageNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past bugfix-triage
    if (shouldSkipOnContinue(state, 'bugfix-triage', bugLog)) {
        return { phase: 'bugfix-triage' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'bugfix-triage' });
    writePeriodicSnapshot(state.outputPath, state, 'bugfix-triage');
    const budgetStop = checkBudgetStop(state, 'bugfix-triage' as PhaseName, bugLog);
    if (budgetStop) return budgetStop;
    const iteration = state.iteration.bugfix + 1;
    bugLog.info(`Bug-fix triage iteration ${iteration}/${getEffectiveLimits().maxBugfixIterations}`);

    // ── Runaway guard (Plan 21, E3) ──────────────────────────────────────
    // `unrecoverable` was previously only ever set after e2e, so the
    // haltIfUnrecoverable() checks in development/qa/devops could never fire
    // inside the QA -> triage -> development loop — which is exactly the loop
    // that ran away. Detect here, at the loop's entry point.
    const triageHalt = detectUnrecoverable(state);
    if (triageHalt.unrecoverable) {
        bugLog.error(`Run is unrecoverable: ${triageHalt.reason}`);
        const update: Partial<ProjectStateType> = {
            unrecoverable: { flag: true, reason: triageHalt.reason ?? 'unrecoverable' },
            phase: 'bugfix-triage' as PhaseName,
            transcript: [msg('conductor', 'bugfix-triage', `Unrecoverable: ${triageHalt.reason}`)],
        };
        if (RUN_FAIL_POLICY === 'halt') {
            bugLog.warn('RUN_FAIL_POLICY=halt — skipping bug-fix triage, no new assignments will be dispatched');
            emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'devops', skipped: true });
            return { ...update, iteration: { bugfix: iteration } };
        }
        // Non-halt policies: flag it so downstream gates report truthfully, but continue.
        bugLog.warn(`RUN_FAIL_POLICY=${RUN_FAIL_POLICY} — continuing triage despite unrecoverable state`);
    }

    // ── Deduplicate and filter already-fixed bugs ────────────────────────
    const fixedSet = new Set(state.fixedBugIds ?? []);
    const openBugs = dedupeBugs(state.bugs)
        .filter(b => !fixedSet.has(b.id))
        .filter(b => b.severity === 'critical' || b.severity === 'major');

    if (openBugs.length === 0) {
        bugLog.info('No critical/major bugs — skipping to DevOps');
        emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'devops', skipped: true });
        return {
            phase: 'bugfix-triage' as PhaseName,
            iteration: { bugfix: iteration },
            transcript: [msg('team-leader', 'bugfix-triage', 'No critical bugs to fix')],
        };
    }

    bugLog.info(`Re-assigning ${openBugs.length} bugs to developers...`);
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: `Bug-fix Triage — Iteration ${iteration}`, body: '', priority: 1 },
            { title: 'Open Bugs', body: JSON.stringify(openBugs, null, 2), priority: 1 },
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Existing Assignments', body: state.assignments.map(a => `- ${a.id} [${a.devAgentId}]: ${a.description?.slice(0, 100)}`).join('\n'), priority: 3 },
            // Without this the LLM copies the synthetic BUG id into `storyId` (Plan 21, E5).
            { title: 'Valid Story IDs', body: (state.userStories ?? []).map(s => `- ${s.id}: ${s.iWant}`).join('\n') || '(no user stories)', priority: 1 },
            { title: 'Instructions', body: `Please create NEW assignments to fix these bugs. Assign each bug to the most appropriate developer.

Every assignment's "storyId" MUST be one of the ids listed under "Valid Story IDs" above. NEVER put a bug id (e.g. "QA-no-tests", "BUG-003") in "storyId" — bug ids belong in the description.

IMPORTANT: When triaging lint errors about "unused imports" or "defined but never used" in the application entry point file (main.ts, App.tsx, index.ts, server.ts, etc.):
- If the unused imports are core application components (services, managers, UI components, controllers), the fix is NOT to remove them — it is to ADD the integration code that uses them (game loop, app bootstrap, route mounting, etc.)
- Only remove imports that are genuinely extraneous (duplicates, wrong file, superseded).`, priority: 1 },
        ];
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    bugLog.info(`Context [bugfix-triage]: ${userMsg.length} chars`);
    recordContextChars('bugfix-triage', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, `tl-bugfix-${iteration}`, 'team-leader', 'bugfix-triage', { schema: TeamLeaderOutputSchema });

    // ── Namespace bugfix assignment ids to avoid collisions ──────────────
    const rawAssignments = output.assignments ?? [];
    const namespaced = namespaceBugfixAssignments(rawAssignments, iteration);

    // ── Story-id integrity (Plan 21, E5) ─────────────────────────────────
    // The prompt asks for real story ids; this is the guarantee. An unresolvable
    // id is dropped, not passed through — a phantom id makes the developer prompt
    // claim acceptance criteria that were never supplied.
    const { assignments: namespacedAssignments, dropped } = sanitizeAssignmentStoryIds(
        namespaced, state.userStories ?? [], state.bugs ?? [],
    );
    if (dropped.length > 0) {
        bugLog.warn(`Dropped ${dropped.length} unresolvable storyId reference(s) from bugfix assignments: ${dropped.join(', ')}`);
    }
    bugLog.info(`Created ${namespacedAssignments.length} bugfix assignments (iteration ${iteration})`);

    // Track which bugs are being attempted (not fixed — fix is verified later)
    const bugIdsBeingAttempted = openBugs.map(b => b.id);

    // Increment bug attempt counts
    const newBugAttempts: Record<string, number> = {};
    for (const id of bugIdsBeingAttempted) {
        newBugAttempts[id] = (state.bugAttempts?.[id] ?? 0) + 1;
    }

    emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'development', bugs: bugIdsBeingAttempted.length, assignments: namespacedAssignments.length });
    return {
        assignments: namespacedAssignments,
        attemptedBugIds: bugIdsBeingAttempted,
        bugAttempts: newBugAttempts,
        iteration: { bugfix: iteration },
        phase: 'bugfix-triage' as PhaseName,
        transcript: [msg('team-leader', 'bugfix-triage', `Iteration ${iteration}: reassigned ${namespacedAssignments.length} bug fixes for ${bugIdsBeingAttempted.length} bugs`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 9. DevOps ──────────────────────────────────────────────────────────────

const opsLog = getLogger('[DevOps]', 33);

export async function devopsNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past devops
    if (shouldSkipOnContinue(state, 'devops', opsLog)) {
        return { phase: 'devops' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'devops' });
    writePeriodicSnapshot(state.outputPath, state, 'devops');
    const budgetStop = checkBudgetStop(state, 'devops' as PhaseName, opsLog);
    if (budgetStop) return budgetStop;
    const haltOps = haltIfUnrecoverable(state, opsLog, RUN_FAIL_POLICY);
    if (haltOps) return { ...haltOps, phase: 'devops' as PhaseName };
    const rerunUpdate = checkRerun(state, 'devops', opsLog);
    opsLog.info('Starting DevOps phase...');
    const apiKey = await getAccessToken();

    // ── Sync workspace before DevOps (idempotent — protects HITL resume) ──
    let devopsGitRoot: string;
    try {
        devopsGitRoot = findGitRoot(state.workspacePath);
    } catch {
        devopsGitRoot = state.workspacePath;
    }
    const devopsSyncResult = syncWorkspaceToBranch(devopsGitRoot, state.systemBranch, state.gitContext);
    opsLog.info(`Workspace synced to origin/${state.systemBranch}: ${devopsSyncResult.details}`);

    // ── Ensure Node.js lockfile is in sync before DevOps ─────────────────
    ensureNodeLockfileSync(state.workspacePath, state.systemBranch, state.gitContext, opsLog);

    // Deploy only the convention files DevOps agent needs (fixes A11)
    const devopsConventionFiles = resolveConventionFiles([], state.techStack);
    deployConventionsToWorkspace(state.workspacePath, devopsConventionFiles);

    let output: any = { devops: { buildStatus: 'failed', runStatus: 'failed', serviceUrls: [], healthChecks: [] }, fileChanges: [] };
    let tokenUsage: TokenCallRecord | null = null;
    const transcript: TranscriptMessage[] = [];
    let verifiedContainers: string[] = [];

    try {
        const agent = createDevOpsAgent(apiKey, state.workspacePath, devopsConventionFiles);

        let userMsg: string;
        {
            const sections: ContextSection[] = [
                { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
                { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 1 },
                { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
                { title: 'File Changes', body: summariseFileChanges(state.fileChanges, DEV_CONTEXT_FILE_CHANGES_LIMIT), priority: 3 },
            ];
            if (state.codebaseAnalysis) {
                sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
                sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Update existing Docker/K8s configs rather than creating from scratch.', priority: 1 });
            }
            userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
        }
        opsLog.info(`Context [devops]: ${userMsg.length} chars`);
        recordContextChars('devops', userMsg.length);

        const r = await invokeAgent(agent, userMsg, 'devops', 'devops', 'devops', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: DevOpsOutputSchema });
        output = r.output;
        tokenUsage = r.tokenUsage;
        opsLog.info(`Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`);
    } catch (err: any) {
        opsLog.error(`DevOps agent failed: ${err.message}`);
        if (err?.stack) opsLog.error(err.stack);
        transcript.push(msg('devops', 'devops', `DevOps agent failed: ${err.message}`));
    }

    // ── Deterministic Dockerfile fallback (D11) ───────────────────────────
    // When the DevOps agent failed or produced no Docker artifacts, generate
    // a minimal, correct Dockerfile + compose from the detected stack roots.
    if (DEVOPS_FALLBACK_ENABLED) {
        const mode = (await import('./devops-verify')).chooseDeploymentMode(state.workspacePath);
        if (mode === 'none') {
            opsLog.info('No Docker artifacts after DevOps agent — generating fallback deployment');
            try {
                const { generateFallbackDeployment } = await import('./devops-fallback');
                const roots = state.latestGateReport?.roots ?? detectStackRoots(state.workspacePath);
                const fallback = generateFallbackDeployment(state.workspacePath, roots, state.repoContract);
                if (fallback.files.length > 0) {
                    opsLog.info(`Fallback generated ${fallback.files.length} file(s): ${fallback.composeServices.join(', ')}`);
                    emitRunEvent('devops:fallback', { files: fallback.files.length, services: fallback.composeServices });
                }
            } catch (fbErr: any) {
                opsLog.warn(`Fallback deployment generation failed: ${fbErr.message}`);
            }
        }
    }

    // ── Patch Dockerfiles for SSL (failsafe for self-signed certs) ────
    patchDockerfilesSsl(state.workspacePath, opsLog);

    // ── Verify deployment for real (fixes A5, D2) ─────────────────────────
    // The agent's self-reported deployment status is NEVER authoritative.
    // When verification is skipped we overwrite the claims with 'skipped' / []
    // rather than leaving them in place — retroboard3 ran E2E against two
    // hallucinated service URLs because of the old guard.
    const verificationErrors: Array<{ stage: string; message: string }> = [];
    const verified = await verifyDeployment(state.workspacePath, path.basename(state.workspacePath));
    {
        const claimedUrls = output.devops?.serviceUrls ?? [];
        output.devops = {
            ...output.devops,
            buildStatus: verified.buildStatus,
            runStatus: verified.runStatus,
            serviceUrls: verified.serviceUrls ?? [],
            healthChecks: verified.healthChecks ?? [],
            verificationMode: verified.mode,
        };
        if (claimedUrls.length > 0 && (verified.serviceUrls ?? []).length === 0) {
            opsLog.error(`DevOps agent claimed ${claimedUrls.length} service URL(s) but verification produced none — discarding the claims.`);
            verificationErrors.push({ stage: 'devops', message: 'unverified serviceUrls discarded' });
        }
        verifiedContainers = verified.containerNames;
        transcript.push(msg('devops', 'devops', `Deployment verification: mode=${verified.mode}, build=${verified.buildStatus}, run=${verified.runStatus}, services=${(verified.serviceUrls ?? []).length}`));
    }

    // ── Synthesise deployment bugs (D5) ──────────────────────────────────
    const deployBugs: Bug[] = [];
    if (verified.buildStatus === 'failed') {
        deployBugs.push({
            id: 'DEPLOY-BUILD-FAILED',
            title: 'Deployment build failed',
            severity: 'critical',
            stepsToReproduce: 'Run docker build / docker compose up --build',
            expectedBehavior: 'Docker build should succeed',
            actualBehavior: `Build failed: ${(verified.logs ?? '').slice(-500)}`,
            suspectedArea: 'Dockerfile / docker-compose.yml',
            reportedBy: 'devops-verify',
        });
    }
    if (verified.runStatus === 'unhealthy') {
        const failedChecks = (verified.healthChecks ?? []).filter(h => h.status !== 'healthy');
        deployBugs.push({
            id: 'DEPLOY-UNHEALTHY',
            title: 'Deployment services unhealthy',
            severity: 'critical',
            stepsToReproduce: 'Start containers and health-check all published ports',
            expectedBehavior: 'All services should respond with HTTP 200',
            actualBehavior: `${failedChecks.length} health check(s) failed: ${failedChecks.map(h => `${h.service}=${h.status}`).join(', ')}`,
            suspectedArea: 'Service health endpoints / port bindings',
            reportedBy: 'devops-verify',
        });
    }

    const artifactContent = [
        `## Build Status: ${output.devops?.buildStatus ?? 'unknown'}`,
        `## Run Status: ${output.devops?.runStatus ?? 'unknown'}`,
        `\n## Services\n\n${(output.devops?.serviceUrls ?? []).map((s: any) => `- **${s.service}**: ${s.url}`).join('\n')}`,
        `\n## Health Checks\n\n${(output.devops?.healthChecks ?? []).map((h: any) => `- ${h.service}: ${h.status}`).join('\n')}`,
    ];
    if (DEVOPS_VERIFY_ENABLED && output.devops?.logs) {
        artifactContent.push(`\n## Verification Logs\n\n\`\`\`\n${output.devops.logs}\n\`\`\``);
    }

    const artifact = writeArtifact({
        agentId: 'devops', colorCode: 33, workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'DevOps Mission Report',
        content: artifactContent.join('\n'),
    });

    // Commit DevOps-generated files via the shared helper (includes sync + retry)
    const devopsSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${devopsSlug}]-chore: DevOps configuration files`,
        state.gitContext,
        opsLog,
    );

    transcript.push(msg('devops', 'devops', `Build: ${output.devops?.buildStatus ?? 'unknown'}, Run: ${output.devops?.runStatus ?? 'unknown'}`));

    emitRunEvent('phase:end', { phase: 'devops', nextPhase: 'e2e', buildStatus: output.devops?.buildStatus ?? 'unknown' });
    return {
        ...rerunUpdate,
        devopsPlan: output.devops,
        fileChanges: output.fileChanges ?? [],
        runningContainers: verifiedContainers,
        bugs: deployBugs,
        verificationErrors,
        phase: 'devops' as PhaseName,
        artifacts: [artifact],
        transcript,
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 9b. E2E Testing ────────────────────────────────────────────────────────

const e2eLog = getLogger('[QA E2E]', 118);

export async function e2eNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past e2e
    if (shouldSkipOnContinue(state, 'e2e', e2eLog)) {
        return { phase: 'e2e' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'e2e' });
    writePeriodicSnapshot(state.outputPath, state, 'e2e');
    const budgetStop = checkBudgetStop(state, 'e2e' as PhaseName, e2eLog);
    if (budgetStop) return budgetStop;
    const rerunUpdate = checkRerun(state, 'e2e', e2eLog);
    e2eLog.info('Starting E2E testing phase...');
    const transcript: TranscriptMessage[] = [];
    const e2eTokenUsage: TokenCallRecord[] = [];
    const allBugs: Bug[] = [];

    // ── Helper: build an inconclusive e2e TestReport so downstream sees a signal ──
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

    // ── Skip: no service URLs and no web root → E2E not applicable ──────
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
                const { runSmokeTest } = await import('./product-verify');
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

    // ── Playwright preflight (D10) ───────────────────────────────────────
    e2eLog.info(`Running E2E tests against ${state.devopsPlan!.serviceUrls.length} service(s)...`);
    let playwrightAvailable = true;
    try {
        const { preflightPlaywright } = await import('../tools/mcp/playwright-preflight');
        const preflight = await preflightPlaywright();
        if (!preflight.available) {
            playwrightAvailable = false;
            e2eLog.warn(`Playwright MCP not available: ${preflight.reason}`);
            // Fall back to smoke test instead of failing entirely
            e2eLog.info('Falling back to deterministic smoke test');
            try {
                const roots = state.latestGateReport?.roots ?? detectStackRoots(state.workspacePath);
                const { runSmokeTest } = await import('./product-verify');
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

    // ── Main Playwright E2E path ─────────────────────────────────────────
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

        // ── Cross-check E2E self-report (D9) ──────────────────────────────
        // If agent claims N scenarios but we have no evidence of visited URLs, record discrepancy
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

        allBugs.push({
            id: 'E2E-INFRA-FAILED',
            title: 'E2E testing infrastructure failure',
            severity: 'major',
            stepsToReproduce: 'Run E2E phase with Playwright MCP',
            expectedBehavior: 'E2E agent should connect to the MCP server and execute tests',
            actualBehavior: `E2E failed: ${err.message}`,
            suspectedArea: 'Playwright MCP setup / browser installation',
            reportedBy: 'e2e-node',
        });

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
}

// ─── 10. Acceptance Gate ────────────────────────────────────────────────────

const acceptLog = getLogger('[Acceptance]', 214);

export async function acceptanceNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past acceptance-gate
    if (shouldSkipOnContinue(state, 'acceptance-gate', acceptLog)) {
        return { phase: 'acceptance-gate' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'acceptance-gate' });
    writePeriodicSnapshot(state.outputPath, state, 'acceptance-gate');
    // No budget check here — acceptance gate is lightweight and must always run
    acceptLog.info('Evaluating acceptance gate...');

    const report = evaluateAcceptance(state);

    // Log every blocker at error level
    for (const blocker of report.blockers) {
        acceptLog.error(`BLOCKER: ${blocker}`);
    }

    // Log status
    acceptLog.info(`Acceptance status: ${report.status.toUpperCase()} — ${report.criteria.filter(c => c.passed).length}/${report.criteria.length} criteria passed, ${report.blockers.length} blocker(s)`);
    if (report.unrecoverable) {
        acceptLog.warn(`Run is unrecoverable: ${report.unrecoverableReason}`);
    }

    // Write acceptance report artifact
    try {
        const reportMd = acceptanceReportToMarkdown(report);
        writeArtifact({
            agentId: 'acceptance-gate',
            colorCode: 214,
            workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'Acceptance Report',
            content: reportMd,
        });
        // Also write to outputs/<run>/acceptance-report.md
        const reportPath = path.join(state.outputPath, 'acceptance-report.md');
        fs.writeFileSync(reportPath, reportMd, 'utf-8');
    } catch (err: any) {
        acceptLog.warn(`Failed to write acceptance report artifact: ${err.message}`);
    }

    // Convert acceptance blockers to bugs for the bugfix loop
    const acceptanceBugs = acceptanceBlockersToBugs(report);

    const transcript: TranscriptMessage[] = [
        msg('acceptance-gate', 'acceptance-gate',
            `Acceptance gate: ${report.status.toUpperCase()} — ${report.blockers.length} blocker(s)${report.unrecoverable ? ' [UNRECOVERABLE]' : ''}`),
    ];

    emitRunEvent('acceptance:result', {
        status: report.status,
        blockers: report.blockers.length,
        unrecoverable: report.unrecoverable,
        criteria: report.criteria.map(c => ({ id: c.id, passed: c.passed })),
    });
    emitRunEvent('phase:end', { phase: 'acceptance-gate', status: report.status });

    return {
        acceptance: report,
        unrecoverable: report.unrecoverable ? { flag: true, reason: report.unrecoverableReason ?? 'unknown' } : null,
        bugs: acceptanceBugs,
        phase: 'acceptance-gate' as PhaseName,
        transcript,
    };
}

// ─── 11. Finalize ───────────────────────────────────────────────────────────

const finalLog = getLogger('[Finalize]', 46);

export async function finalizeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'finalize' });
    finalLog.info('Finalizing run...');

    // ── Tear down containers started by deployment verification ──────────
    if (DEVOPS_TEARDOWN && state.runningContainers && state.runningContainers.length > 0) {
        try {
            await teardownDeployment(state.workspacePath, state.runningContainers);
            finalLog.info(`Tore down ${state.runningContainers.length} container(s)`);
        } catch (err: any) {
            finalLog.warn(`Container teardown failed: ${err.message}`);
        }
    }

    // ── Terminal status — the acceptance gate drives this (Plan 19 Sub-Plan 03) ──
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

    // ── Token usage summary ─────────────────────────────────────────────
    const usageSummary = tokenTracker.getRunSummary();
    const usageSnapshot = tokenTracker.getSnapshot();

    // ── Count files actually on disk vs phantom file-change claims ─────
    let filesDelivered = 0;
    let phantomFileChanges = 0;
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
    const budget = getBudgetStatus();
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

    // ── Requirements traceability (Sub-Plan 10) ────────────────────────
    let traceReport: ReturnType<typeof buildTraceabilityReport> | null = null;
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

    // ── Token usage report artifact ─────────────────────────────────────
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
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Total LLM Calls | ${usageSummary.totalCalls} |`,
        `| Input Tokens | ${usageSummary.totalInputTokens.toLocaleString()} |`,
        `| Output Tokens | ${usageSummary.totalOutputTokens.toLocaleString()} |`,
        `| **Total Tokens** | **${usageSummary.totalTokens.toLocaleString()}** |`,
        `| **Estimated Cost** | **$${totalEstimatedCost.toFixed(4)}** |`,
        ``,
        `## By Agent`,
        ``,
        `| Agent | Model | Calls | Input | Output | Total | Est. Cost |`,
        `|-------|-------|------:|------:|-------:|------:|----------:|`,
    ];
    for (const a of usageSummary.byAgent) {
        const cost = estimateCost(a.model, a.inputTokens, a.outputTokens);
        usageReportLines.push(
            `| ${a.agentId} | ${a.model} | ${a.callCount} | ${a.inputTokens.toLocaleString()} | ${a.outputTokens.toLocaleString()} | ${a.totalTokens.toLocaleString()} | $${cost.toFixed(4)} |`,
        );
    }
    usageReportLines.push(
        ``,
        `## By Phase`,
        ``,
        `| Phase | Calls | Input | Output | Total |`,
        `|-------|------:|------:|-------:|------:|`,
    );
    for (const p of usageSummary.byPhase) {
        usageReportLines.push(
            `| ${p.phase} | ${p.callCount} | ${p.inputTokens.toLocaleString()} | ${p.outputTokens.toLocaleString()} | ${p.totalTokens.toLocaleString()} |`,
        );
    }
    usageReportLines.push(
        ``,
        `## By Model`,
        ``,
        `| Model | Calls | Input | Output | Total | Est. Cost |`,
        `|-------|------:|------:|-------:|------:|----------:|`,
    );
    for (const m of usageSummary.byModel) {
        const cost = estimateCost(m.model, m.inputTokens, m.outputTokens);
        usageReportLines.push(
            `| ${m.model} | ${m.callCount} | ${m.inputTokens.toLocaleString()} | ${m.outputTokens.toLocaleString()} | ${m.totalTokens.toLocaleString()} | $${cost.toFixed(4)} |`,
        );
    }
    usageReportLines.push(
        ``,
        `## Pricing Rates`,
        ``,
        `| Model | Input ($/1K tokens) | Output ($/1K tokens) |`,
        `|-------|--------------------:|---------------------:|`,
    );
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        usageReportLines.push(
            `| ${model} | $${pricing.inputPer1k.toFixed(4)} | $${pricing.outputPer1k.toFixed(4)} |`,
        );
    }

    writeArtifact({
        agentId: 'conductor',
        colorCode: 220,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Token Usage Report',
        content: usageReportLines.join('\n'),
    });

    // ── Requirements traceability artifact (Sub-Plan 10) ────────────────
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
        try {
            const tracePath = path.join(state.outputPath, 'traceability.md');
            fs.writeFileSync(tracePath, traceMd, 'utf-8');
            finalLog.info(`Traceability matrix: ${tracePath}`);
        } catch (err: any) {
            finalLog.warn(`Failed to write traceability.md: ${err.message}`);
        }
        // Write machine-readable outputs/<run>/traceability.json
        if (TRACEABILITY_JSON) {
            try {
                const traceJsonPath = path.join(state.outputPath, 'traceability.json');
                fs.writeFileSync(traceJsonPath, JSON.stringify(traceReport, null, 2), 'utf-8');
                finalLog.info(`Traceability JSON: ${traceJsonPath}`);
            } catch (err: any) {
                finalLog.warn(`Failed to write traceability.json: ${err.message}`);
            }
        }
    }

    // ── HTML token usage report + raw JSON ──────────────────────────────
    const { jsonPath, htmlPath } = generateTokenReport(
        usageSnapshot,
        state.outputPath,
        state.input.systemName,
        finalStatus,
    );
    finalLog.info(`Token usage JSON: ${jsonPath}`);
    finalLog.info(`Token usage HTML report: ${htmlPath}`);

    // ── Acceptance blockers in the final log ────────────────────────────
    if (acceptance.blockers.length > 0) {
        summary.push('');
        summary.push(`── Acceptance Blockers ──`);
        for (const b of acceptance.blockers) {
            summary.push(`  - ${b}`);
        }
    }

    // ── PR & branch counters (Sub-Plan G1/G2) ────────────────────────────
    const prCounts = countPRsByStatus(state.pullRequests ?? []);
    const branchesSalvaged = (state.salvageBranches ?? []).length;

    // Branches with assignments but no PR opened
    const branchesWithPR = new Set<string>(
        (state.pullRequests ?? [])
            .filter((pr: any) => pr.prNumber !== 0)
            .map((pr: any) => pr.branchName),
    );
    const allAssignedBranches = new Set<string>(
        (state.branchAssignments ?? []).map((ba: any) => ba.branchName),
    );
    const branchesNotAttempted = [...allAssignedBranches].filter(b => !branchesWithPR.has(b)).length;

    // Deferred = dispatch rounds where prs === 0 (nothing merged/opened)
    const branchesDeferred = (state.dispatchRounds ?? []).filter((r: DispatchRound) => r.prs === 0 && r.fileChanges === 0).length;

    // ── Phase timeline (Sub-Plan G4) ────────────────────────────────────
    const allEvents = getAllEvents();
    const phaseTimeline = extractPhaseTimeline(allEvents);

    // Add timeline to the summary
    const timelineText = renderPhaseTimeline(phaseTimeline);
    if (timelineText) {
        summary.push('');
        summary.push(timelineText);
    }

    // ── Write state snapshot and run manifest ─────────────────────────────
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
            integrityFindings: (state.bugs ?? []).filter(b => b.id.startsWith('TAMPER-')).length,
        },
        phantomFileChanges,
        filesDelivered,
        prCounts,
        branchesSalvaged,
        branchesDeferred,
        branchesNotAttempted,
        phaseTimeline,
    });

    // ── Ledger: acceptance entry ────────────────────────────────────────
    appendLedger({
        kind: 'acceptance',
        status: acceptance.status,
        blockers: acceptance.blockers,
        unrecoverable: acceptance.unrecoverable,
    });

    // ── Run invariants ───────────────────────────────────────────────────
    let invariantViolations: Array<{ id: string; phase: string; detail: string }> = [];
    try {
        invariantViolations = checkInvariants(state, 'finalize');
    } catch (err: any) {
        finalLog.warn(`Invariant check threw: ${err.message}`);
    }

    // ── Coverage ledger entry ────────────────────────────────────────────
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

    // ── Plan funnel ledger entry ─────────────────────────────────────────
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

    // ── Generate run report from ledger ──────────────────────────────────
    appendLedger({ kind: 'phase', phase: 'finalize', event: 'end' });
    try {
        const reportPath = generateRunReport(state.outputPath, state.input.systemName);
        finalLog.info(`Run report: ${reportPath}`);
    } catch (err: any) {
        finalLog.warn(`Failed to generate run report: ${err.message}`);
    }

    // ── Run diagnosis (Sub-Plan G3) ──────────────────────────────────────
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
