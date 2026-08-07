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
    AGENT_OUTPUT_REPAIR_ATTEMPTS,
    CONTEXT_MAX_CHARS,
    MIN_AC_COVERAGE_PCT, MIN_AC_COVERAGE_MAX_BUGS,
    SECURITY_GATES_ENABLED,
} from '../config';
import { sanitizeMermaidLabels } from '../tools/diagram/diagram-tools';
import { createGitHubRepo, validateGitHubRepo, initializeRepoLocally } from '../utils/github-repo-manager';
import { gitExec, gitPush, findGitRoot } from '../utils/git-exec';
import { GITHUB_MODE } from '../utils/github-local';
import { setLocalBareRepoPath } from './pr-workflow';
import { syncWorkspaceToBranch, looksSourceless } from './workspace-sync';
import { selectPendingAssignments, dedupeBugs, namespaceBugfixAssignments } from './assignment-policy';
import { verifyDeployment, teardownDeployment } from './devops-verify';
import { runQualityGates, gateReportToTestReport, synthesiseGateBugs } from './quality-gates';
import { runSecurityGates, synthesiseSecurityBugs, securityReportToMarkdown } from './security-gates';
import {
    summariseArchitecture, summariseTechStack, summariseDbDesign,
    summariseStories, storiesForIds, summariseTasks,
    summariseFileChanges, summariseCodebaseAnalysis, summariseEpics,
    buildContext, recordContextChars, getContextStats,
} from './context-builder';
import { getCumulativeCompactionStats } from '../agents/_shared/history-compactor';
import type { ContextSection } from './context-builder';
import {
    parseAgentJson, validateAgentOutput, buildRepairMessage,
    getValidationStats, logValidationStats,
    _recordValidated, _recordRepaired, _recordFailed,
} from '../utils/structured-output';
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
import { tokenTracker, type TokenCallRecord } from '../utils/token-tracker';
import { extractTokenUsageFromMessages } from '../utils/token-usage-extractor';
import { generateTokenReport, refreshTokenReport } from '../utils/token-report';
import { getThrottleStats, logThrottleStats } from '../utils/llm-throttle';
import { estimateCost } from '../utils/cost';
import { startRunBudget, getBudgetStatus, getEffectiveLimits } from '../utils/run-budget';
import { emitRunEvent } from '../utils/event-bus';
import { writeStateSnapshot, writeRunManifest } from '../utils/run-snapshot';
import { buildTraceabilityReport, renderTraceabilityMarkdown } from '../utils/traceability';
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

        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: threadId }, recursionLimit },
        );

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

        const last = result.messages[result.messages.length - 1];
        if (typeof last.content !== 'string') {
            emitEnd();
            return { output: last.content, tokenUsage };
        }

        // Extract JSON from the response using the shared parser
        const raw = last.content.trim();
        const parseResult = parseAgentJson(raw);
        if (!parseResult.ok) {
            emitEnd({ error: parseResult.error });
            throw new SyntaxError(
                `Agent "${threadSuffix}" did not return valid JSON. ${parseResult.error}`
            );
        }

        let parsed = parseResult.value;

        // ── Schema validation with repair loop (fixes A7) ────────────────
        if (opts?.schema) {
            _recordValidated();
            const validation = validateAgentOutput(opts.schema, parsed);
            if (validation.ok) {
                emitEnd();
                return { output: validation.value, tokenUsage };
            }

            // Attempt repair on a FRESH thread: avoid replaying the entire ReAct
            // history just to fix a schema violation. The repair message carries
            // the previous raw JSON so the model corrects rather than regenerates.
            invokeLog.warn(`Agent "${threadSuffix}" output failed schema validation:\n${validation.issues}`);
            for (let attempt = 0; attempt < AGENT_OUTPUT_REPAIR_ATTEMPTS; attempt++) {
                invokeLog.info(`Repair attempt ${attempt + 1}/${AGENT_OUTPUT_REPAIR_ATTEMPTS} for "${threadSuffix}"...`);
                const repairThreadId = `${threadId}-repair-${attempt}`;
                const repairMsg = buildRepairMessage(validation.issues, userMessage, raw);
                const repairResult = await agent.invoke(
                    { messages: [{ role: 'user', content: repairMsg }] },
                    { configurable: { thread_id: repairThreadId }, recursionLimit: 2 },
                );
                const repairLast = repairResult.messages[repairResult.messages.length - 1];
                if (typeof repairLast.content !== 'string') {
                    // Non-string content — try validating it directly
                    const rv = validateAgentOutput(opts.schema, repairLast.content);
                    if (rv.ok) {
                        _recordRepaired();
                        invokeLog.info(`Agent "${threadSuffix}" repaired on attempt ${attempt + 1}`);
                        emitEnd({ repaired: true, repairAttempt: attempt + 1 });
                        return { output: rv.value, tokenUsage };
                    }
                    continue;
                }
                const repairParse = parseAgentJson(repairLast.content.trim());
                if (!repairParse.ok) continue;
                const rv = validateAgentOutput(opts.schema, repairParse.value);
                if (rv.ok) {
                    _recordRepaired();
                    invokeLog.info(`Agent "${threadSuffix}" repaired on attempt ${attempt + 1}`);
                    emitEnd({ repaired: true, repairAttempt: attempt + 1 });
                    return { output: rv.value, tokenUsage };
                }
            }

            // All repair attempts failed — log ERROR and return the unvalidated object
            _recordFailed();
            invokeLog.error(`Agent "${threadSuffix}" output still invalid after ${AGENT_OUTPUT_REPAIR_ATTEMPTS} repair attempt(s):\n${validation.issues}`);
            emitEnd({ validationFailed: true });
            return { output: parsed, tokenUsage };
        }

        emitEnd();
        return { output: parsed, tokenUsage };
    }, threadSuffix);
}

// ─── 1. Intake ──────────────────────────────────────────────────────────────

const intakeLog = getLogger('[Intake]', 255);

export async function intakeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
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
        phase: nextPhase as PhaseName,
        transcript: [msg('conductor', 'intake', `Intake complete (${state.input.runType ?? 'greenfield'}). System branch: ${systemBranch}. Repo: ${gitContext.owner}/${gitContext.repo}. Requirements: ${requirementsText.length} chars`)],
    };
}

// ─── 1b. Codebase Analyzer (maintain mode only) ─────────────────────────────

const analyzerLog = getLogger('[Analyzer]', 147);

export async function codebaseAnalyzerNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'codebase-analyzer' });
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
        workspacePath: state.workspacePath,
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
        phase: 'architect' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('codebase-analyzer', 'codebase-analyzer', `Analyzed ${output.modules?.length ?? 0} modules across ${output.primaryLanguages?.length ?? 0} languages`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 2. Architect ───────────────────────────────────────────────────────────

const archLog = getLogger('[Architect]', 39);

export async function architectNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'architect' });
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

    const artifact = writeArtifact({
        agentId: 'architect',
        colorCode: 39,
        workspacePath: state.workspacePath,
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
        techStack: output.techStack ?? [],
        epics: output.epics ?? [],
        phase: 'product-manager' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('architect', 'architect', `Designed ${output.architecture?.components?.length ?? 0} components, ${output.epics?.length ?? 0} epics`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 3. Product Manager ─────────────────────────────────────────────────────

const pmLog = getLogger('[Product Manager]', 214);

export async function productManagerNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'product-manager' });
    const rerunUpdate = checkRerun(state, 'product-manager', pmLog);
    pmLog.info('Starting product management phase...');
    const apiKey = await getAccessToken();
    const agent = createProductManagerAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
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
        workspacePath: state.workspacePath,
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
        phase: 'dba' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('product-manager', 'product-manager', `Created ${output.userStories?.length ?? 0} stories, ${output.tasks?.length ?? 0} tasks`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 4. DBA ─────────────────────────────────────────────────────────────────

const dbaLog = getLogger('[DBA]', 100);

export async function dbaNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'dba' });
    const rerunUpdate = checkRerun(state, 'dba', dbaLog);
    dbaLog.info('Starting database design phase...');
    const apiKey = await getAccessToken();
    const agent = createDbaAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 3 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
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
        workspacePath: state.workspacePath,
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
        phase: 'team-leader' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('dba', 'dba', `Designed ${output.dbDesign?.entities?.length ?? 0} entities on ${output.dbDesign?.engine}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 5. Team Leader ─────────────────────────────────────────────────────────

const tlLog = getLogger('[Team Leader]', 213);

export async function teamLeaderNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'team-leader' });
    const rerunUpdate = checkRerun(state, 'team-leader', tlLog);
    tlLog.info('Starting assignment phase...');
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const projectSlug = state.systemBranch.replace(/^project\//, '');

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
            { title: 'User Stories', body: summariseStories(state.userStories), priority: 1 },
            { title: 'Tasks', body: summariseTasks(state.tasks), priority: 1 },
            { title: 'Project Slug', body: `${projectSlug}\nUse this slug as the prefix for all branch names (e.g., "${projectSlug}/feature/US-001-description").`, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'team-leader');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Assignments may involve modifying existing files.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    tlLog.info(`Context [team-leader]: ${userMsg.length} chars`);
    recordContextChars('team-leader', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'tl', 'team-leader', 'team-leader', { schema: TeamLeaderOutputSchema });
    tlLog.info(`Assignments: ${output.assignments?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'team-leader',
        colorCode: 213,
        workspacePath: state.workspacePath,
        title: 'Team Leader Mission Report',
        content: [
            `## Assignments (${output.assignments?.length ?? 0})\n`,
            ...(output.assignments ?? []).map((a: any) =>
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

    emitRunEvent('phase:end', { phase: 'team-leader', nextPhase: 'development' });
    return {
        ...rerunUpdate,
        assignments: output.assignments ?? [],
        phase: 'development' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('team-leader', 'team-leader', `Created ${output.assignments?.length ?? 0} assignments`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 6. Development (fan-out) ───────────────────────────────────────────────

const devLog = getLogger('[Development]', 226);

export async function developmentNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'development' });
    const rerunUpdate = checkRerun(state, 'development', devLog);
    devLog.info(`Starting development with ${state.assignments.length} assignments...`);

    // ── Filter to only pending assignments (fixes A2) ────────────────────
    const pending = selectPendingAssignments(state.assignments, state.completedAssignmentIds);
    devLog.info(`Development: ${pending.length} pending of ${state.assignments.length} total assignments (${state.completedAssignmentIds.length} already complete)`);
    if (pending.length === 0) {
        devLog.warn('No pending assignments — skipping development phase');
        emitRunEvent('phase:end', { phase: 'development', nextPhase: 'qa', skipped: true });
        return { phase: 'qa' as PhaseName, transcript: [msg('conductor', 'development', 'No pending assignments')] };
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
    ];
    ensureProjectGitignore(state.workspacePath, stackGitignoreEntries);

    let contextPrompt: string;
    {
        // Build the shared context sections (stories are added per-branch in the dispatcher)
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 1 },
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
    const result = await dispatchDevelopers(apiKey, pending, state.workspacePath, contextPrompt, state.systemBranch, projectSlug, state.gitContext, state.techStack, state.completedAssignmentIds, state.userStories, isMaintainMode);

    devLog.info(`Development complete: ${result.fileChanges.length} file changes, ${result.pullRequests.length} PRs`);

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

    emitRunEvent('phase:end', { phase: 'development', nextPhase: 'qa', fileChanges: result.fileChanges.length, prs: result.pullRequests.length });
    return {
        ...rerunUpdate,
        fileChanges: result.fileChanges,
        artifacts: result.artifacts,
        pullRequests: result.pullRequests,
        completedAssignmentIds: result.completedAssignmentIds,
        transcript: [
            ...result.transcript,
            msg('conductor', 'development', `Development phase complete: ${result.fileChanges.length} files changed, ${result.pullRequests.length} PRs merged. Sync: ${syncResult.details}`),
        ],
        phase: 'qa' as PhaseName,
        tokenUsage: result.tokenUsage ?? [],
    };
}

// ─── 7. QA ──────────────────────────────────────────────────────────────────

const qaLog = getLogger('[QA Lead]', 198);

export async function qaNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'qa' });
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
                { title: 'User Stories with Acceptance Criteria', body: storiesForIds(state.userStories, state.userStories.map(s => s.id)), priority: 1 },
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
            agentId: 'qa-lead', colorCode: 198, workspacePath: state.workspacePath,
            title: 'QA Lead — Test Plan',
            content: `## Test Plan\n\n${JSON.stringify(leadOutput.testPlan, null, 2)}`,
        });
        transcript.push(msg('qa-lead', 'qa', `Test plan created: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`));
    } catch (err: any) {
        qaLog.error(`QA Lead failed: ${err.message}`);
        if (err?.stack) qaLog.error(err.stack);
        transcript.push(msg('qa-lead', 'qa', `QA Lead failed: ${err.message}`));
    }

    // 7b. QA Unit — write & run unit/integration tests
    qaLog.info('QA Unit writing and running tests...');
    let unitOutput: any = { testReport: null, bugs: [], fileChanges: [] };
    let unitArtifact: any = null;
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
        qaLog.info(`Unit tests: ${unitOutput.testReport?.passed ?? 0} passed, ${unitOutput.testReport?.failed ?? 0} failed`);
        if (unitOutput.bugs) allBugs.push(...unitOutput.bugs);

        unitArtifact = writeArtifact({
            agentId: 'qa-unit', colorCode: 205, workspacePath: state.workspacePath,
            title: 'QA Unit — Test Report',
            content: `## Results\n\n${JSON.stringify(unitOutput.testReport, null, 2)}`,
        });
        transcript.push(msg('qa-unit', 'qa', `Unit tests: ${unitOutput.testReport?.passed ?? 0}/${unitOutput.testReport?.total ?? 0} passed`));
    } catch (err: any) {
        qaLog.error(`QA Unit failed: ${err.message}`);
        if (err?.stack) qaLog.error(err.stack);
        transcript.push(msg('qa-unit', 'qa', `QA Unit failed: ${err.message}`));
    }

    // Commit QA-generated files via the shared helper (includes sync + retry)
    const systemSlug = path.basename(state.workspacePath);
    commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-chore: QA unit test files`,
        state.gitContext,
        qaLog,
    );

    const testReports = [unitOutput?.testReport].filter(Boolean);
    const artifacts = [...(leadArtifact ? [leadArtifact] : []), ...(unitArtifact ? [unitArtifact] : [])];

    // ── Deterministic quality gate (fixes A6) ────────────────────────────
    // Run the real build/lint/test pipeline and compare with the agent's
    // self-report. The gate report drives afterQaRouter, so a hallucinated
    // 'pass' from qa-unit can no longer suppress the bug-fix loop.
    try {
        const gateReport = runQualityGates(state.workspacePath);
        const gateTestReport = gateReportToTestReport(gateReport, 'quality-gates');
        if (gateTestReport) {
            testReports.push(gateTestReport);

            // Warn when the agent claimed pass but the gate failed
            const agentClaimedPass = unitOutput?.testReport?.status === 'pass';
            if (agentClaimedPass && gateTestReport.status === 'fail') {
                qaLog.warn(`QA agent reported status='pass' but quality gates FAILED — keeping both reports (gate report drives bug-fix loop)`);
                transcript.push(msg('quality-gates', 'qa', `WARNING: QA agent self-reported pass but quality gates failed — deterministic gate overrides`));
            }

            // Synthesise bugs for failing gate steps
            const gateBugs = synthesiseGateBugs(gateReport);
            if (gateBugs.length > 0) {
                allBugs.push(...gateBugs);
                qaLog.info(`Quality gates synthesised ${gateBugs.length} bug(s): ${gateBugs.map(b => b.id).join(', ')}`);
            }

            transcript.push(msg('quality-gates', 'qa',
                `Quality gates: ${gateReport.passed ? 'PASSED' : 'FAILED'} — ${gateReport.stacks.join(',')} — ${gateReport.results.filter(r => !r.skipped).length} steps executed, ${gateReport.results.filter(r => !r.passed && !r.skipped).length} failed`));
        }
    } catch (gateErr: any) {
        qaLog.warn(`Quality gate execution error (non-fatal): ${gateErr.message}`);
    }

    // ── Security gate (secret scan, dependency audit, licence check) ────
    try {
        const securityReport = runSecurityGates(state.workspacePath);

        // Write Security Report artifact
        writeArtifact({
            agentId: 'security-gates', colorCode: 196, workspacePath: state.workspacePath,
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
        qaLog.warn(`Security gate execution error (non-fatal): ${secErr.message}`);
    }

    // ── Optional AC coverage gate ──────────────────────────────────────
    try {
        if (MIN_AC_COVERAGE_PCT > 0) {
            const traceReport = buildTraceabilityReport({
                ...state,
                testPlan: leadOutput?.testPlan ?? state.testPlan,
                testReports,
            } as ProjectStateType);
            const pct = traceReport.totals.coveragePct * 100;
            if (pct < MIN_AC_COVERAGE_PCT) {
                const gaps = traceReport.rows.filter(r =>
                    r.status === 'missing' || r.status === 'implemented-untested'
                );
                const acBugs: Bug[] = gaps.slice(0, MIN_AC_COVERAGE_MAX_BUGS).map(row => ({
                    id: `AC-${row.storyId}-${row.acIndex}`,
                    title: `Acceptance criterion not verified: ${row.storyId} AC#${row.acIndex}`,
                    severity: 'major' as const,
                    stepsToReproduce: `Check story ${row.storyId}, acceptance criterion ${row.acIndex}: "${row.acText}"`,
                    expectedBehavior: `Criterion should be implemented and verified by a passing test`,
                    actualBehavior: `Status is "${row.status}" — ${row.status === 'missing' ? 'no assignment references this story' : 'implemented but no test verifies it'}`,
                    suspectedArea: row.assignmentIds[0] ? `Assignment ${row.assignmentIds[0]}` : `Story ${row.storyId}`,
                    reportedBy: 'ac-coverage-gate',
                }));
                if (acBugs.length > 0) {
                    allBugs.push(...acBugs);
                    qaLog.info(`AC coverage gate: ${pct.toFixed(0)}% < ${MIN_AC_COVERAGE_PCT}% — synthesised ${acBugs.length} bug(s)`);
                    transcript.push(msg('quality-gates', 'qa',
                        `AC coverage gate: ${pct.toFixed(0)}% < ${MIN_AC_COVERAGE_PCT}% — ${acBugs.length} bugs synthesised for ${gaps.length} uncovered criteria`));
                }
            } else {
                qaLog.info(`AC coverage gate: ${pct.toFixed(0)}% >= ${MIN_AC_COVERAGE_PCT}% — passed`);
            }
        }
    } catch (acErr: any) {
        qaLog.warn(`AC coverage gate error (non-fatal): ${acErr.message}`);
    }

    emitRunEvent('phase:end', { phase: 'qa', testReports: testReports.length, bugs: allBugs.length });
    return {
        ...rerunUpdate,
        testPlan: leadOutput?.testPlan,
        testReports,
        bugs: allBugs,
        fileChanges: unitOutput?.fileChanges ?? [],
        artifacts,
        transcript,
        phase: 'qa' as PhaseName,
        tokenUsage: qaTokenUsage,
    };
}

// ─── 8. Bug-fix Triage ──────────────────────────────────────────────────────

const bugLog = getLogger('[BugTriage]', 196);

export async function bugfixTriageNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'bugfix-triage' });
    const iteration = state.iteration.bugfix + 1;
    bugLog.info(`Bug-fix triage iteration ${iteration}/${getEffectiveLimits().maxBugfixIterations}`);

    // ── Deduplicate and filter already-fixed bugs ────────────────────────
    const fixedSet = new Set(state.fixedBugIds ?? []);
    const openBugs = dedupeBugs(state.bugs)
        .filter(b => !fixedSet.has(b.id))
        .filter(b => b.severity === 'critical' || b.severity === 'major');

    if (openBugs.length === 0) {
        bugLog.info('No critical/major bugs — skipping to DevOps');
        emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'devops', skipped: true });
        return {
            phase: 'devops' as PhaseName,
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
            { title: 'Instructions', body: `Please create NEW assignments to fix these bugs. Assign each bug to the most appropriate developer.

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
    const namespacedAssignments = namespaceBugfixAssignments(rawAssignments, iteration);
    bugLog.info(`Created ${namespacedAssignments.length} bugfix assignments (iteration ${iteration})`);

    // Track which bugs are being addressed in this iteration
    const bugIdsBeingFixed = openBugs.map(b => b.id);

    emitRunEvent('phase:end', { phase: 'bugfix-triage', nextPhase: 'development', bugs: bugIdsBeingFixed.length, assignments: namespacedAssignments.length });
    return {
        assignments: namespacedAssignments,
        fixedBugIds: bugIdsBeingFixed,
        iteration: { bugfix: iteration },
        phase: 'development' as PhaseName,
        transcript: [msg('team-leader', 'bugfix-triage', `Iteration ${iteration}: reassigned ${namespacedAssignments.length} bug fixes for ${bugIdsBeingFixed.length} bugs`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 9. DevOps ──────────────────────────────────────────────────────────────

const opsLog = getLogger('[DevOps]', 33);

export async function devopsNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'devops' });
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

    // ── Patch Dockerfiles for SSL (failsafe for self-signed certs) ────
    patchDockerfilesSsl(state.workspacePath, opsLog);

    // ── Verify deployment for real (fixes A5) ────────────────────────────
    if (DEVOPS_VERIFY_ENABLED) {
        const verified = await verifyDeployment(state.workspacePath, path.basename(state.workspacePath));
        if (verified.buildStatus !== 'skipped') {
            if (output.devops?.buildStatus !== verified.buildStatus) {
                opsLog.warn(`DevOps agent reported buildStatus='${output.devops?.buildStatus}' but the real build was '${verified.buildStatus}' — using the verified value`);
            }
            output.devops = { ...output.devops, ...verified };
        }
        verifiedContainers = verified.containerNames;
        transcript.push(msg('devops', 'devops', `Deployment verification: build=${verified.buildStatus}, run=${verified.runStatus}, services=${verified.serviceUrls.length}`));
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
        agentId: 'devops', colorCode: 33, workspacePath: state.workspacePath,
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
        phase: 'e2e' as PhaseName,
        artifacts: [artifact],
        transcript,
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 9b. E2E Testing ────────────────────────────────────────────────────────

const e2eLog = getLogger('[QA E2E]', 118);

export async function e2eNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'e2e' });
    const rerunUpdate = checkRerun(state, 'e2e', e2eLog);
    e2eLog.info('Starting E2E testing phase...');
    const transcript: TranscriptMessage[] = [];
    const e2eTokenUsage: TokenCallRecord[] = [];

    // Gate: only run if DevOps produced service URLs
    if (!state.devopsPlan?.serviceUrls || state.devopsPlan.serviceUrls.length === 0) {
        const reason = !DEVOPS_VERIFY_ENABLED
            ? 'DEVOPS_VERIFY_ENABLED=false — no services were started'
            : 'no service URLs from DevOps — deployment did not produce running services';
        e2eLog.info(`Skipping E2E tests — ${reason}`);
        transcript.push(msg('qa-e2e', 'e2e', `Skipped — ${reason}`));
        emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'finalize', skipped: true, reason });
        return {
            phase: 'finalize' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    }

    e2eLog.info(`Running E2E tests against ${state.devopsPlan.serviceUrls.length} service(s)...`);
    let e2eReport = null;
    const allBugs: Bug[] = [];

    try {
        const apiKey = await getAccessToken();
        const qaConventionFiles = resolveConventionFiles([], state.techStack);
        const mcpTools = await getPlaywrightMcpTools();
        const qaE2eAgent = createQaE2eAgent(apiKey, mcpTools, qaConventionFiles);
        const e2eMsg = [
            `## Test Plan (e2e)\n\n${JSON.stringify(state.testPlan?.e2e ?? [], null, 2)}`,
            `\n## Service URLs\n\n${JSON.stringify(state.devopsPlan.serviceUrls, null, 2)}`,
        ].join('\n');
        const { output: e2eOutput, tokenUsage: e2eTU } = await invokeAgent(qaE2eAgent, e2eMsg, 'qa-e2e', 'qa-e2e', 'e2e', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: QaE2eOutputSchema });
        if (e2eTU) e2eTokenUsage.push(e2eTU);
        e2eReport = e2eOutput.testReport;
        if (e2eOutput.bugs) allBugs.push(...e2eOutput.bugs);
        e2eLog.info(`E2E tests: ${e2eReport?.passed ?? 0} passed, ${e2eReport?.failed ?? 0} failed`);

        const e2eArtifact = writeArtifact({
            agentId: 'qa-e2e', colorCode: 118, workspacePath: state.workspacePath,
            title: 'QA E2E — Test Report',
            content: `## Results\n\n${JSON.stringify(e2eReport, null, 2)}`,
        });
        transcript.push(msg('qa-e2e', 'e2e', `E2E tests: ${e2eReport?.passed ?? 0}/${e2eReport?.total ?? 0} passed`));
        await closePlaywrightMcp();

        emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'finalize' });
        return {
            ...rerunUpdate,
            testReports: e2eReport ? [e2eReport] : [],
            bugs: allBugs,
            artifacts: [e2eArtifact],
            phase: 'finalize' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    } catch (err: any) {
        e2eLog.error(`E2E testing failed: ${err.message}`);
        if (err?.stack) e2eLog.error(err.stack);
        transcript.push(msg('qa-e2e', 'e2e', `E2E testing failed: ${err.message}`));
        emitRunEvent('phase:end', { phase: 'e2e', nextPhase: 'finalize', error: err.message });
        return {
            ...rerunUpdate,
            phase: 'finalize' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    }
}

// ─── 10. Finalize ───────────────────────────────────────────────────────────

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

    // ── Mark run as completed (or cancelled if HITL denied) ───────────────
    const finalStatus = state.cancelled ? 'cancelled' : 'completed';
    tokenTracker.setRunStatus(finalStatus);
    if (state.cancelled) finalLog.warn('Run was cancelled by HITL deny.');

    // ── Token usage summary ─────────────────────────────────────────────
    const usageSummary = tokenTracker.getRunSummary();
    const usageSnapshot = tokenTracker.getSnapshot();

    const summary = [
        `System: ${state.input.systemName}`,
        `Architecture: ${state.architecture?.style} with ${state.architecture?.components?.length ?? 0} components`,
        `Stories: ${state.userStories.length}, Tasks: ${state.tasks.length}`,
        `Assignments: ${state.assignments.length}`,
        `File changes: ${state.fileChanges.length}`,
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

    // ── Requirements traceability ────────────────────────────────────────
    let traceReport: ReturnType<typeof buildTraceabilityReport> | null = null;
    try {
        traceReport = buildTraceabilityReport(state);
        const t = traceReport.totals;
        summary.push('');
        summary.push(`── AC Coverage ──`);
        summary.push(
            `AC coverage: ${t.verified}/${t.criteria} verified (${(t.coveragePct * 100).toFixed(0)}%), ${t.implemented} implemented-untested, ${t.missing} missing`,
        );
        if (traceReport.orphanedStories.length > 0) {
            summary.push(`Orphaned stories: ${traceReport.orphanedStories.join(', ')}`);
        }
        if (traceReport.orphanedAssignments.length > 0) {
            summary.push(`Orphaned assignments: ${traceReport.orphanedAssignments.join(', ')}`);
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
        workspacePath: state.workspacePath,
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
        workspacePath: state.workspacePath,
        title: 'Token Usage Report',
        content: usageReportLines.join('\n'),
    });

    // ── Requirements traceability artifact ─────────────────────────────
    if (traceReport) {
        const traceMd = renderTraceabilityMarkdown(traceReport);
        writeArtifact({
            agentId: 'conductor',
            colorCode: 183,
            workspacePath: state.workspacePath,
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

    // ── Write state snapshot and run manifest ─────────────────────────────
    writeStateSnapshot(state.outputPath, state);
    writeRunManifest(state.outputPath, state, finalStatus, {
        traceability: traceReport ? {
            criteria: traceReport.totals.criteria,
            verified: traceReport.totals.verified,
            implemented: traceReport.totals.implemented,
            missing: traceReport.totals.missing,
            coveragePct: traceReport.totals.coveragePct,
            orphanedStories: traceReport.orphanedStories,
            orphanedAssignments: traceReport.orphanedAssignments,
        } : undefined,
    });

    emitRunEvent('phase:end', { phase: 'finalize', totalTokens: usageSummary.totalTokens, totalCalls: usageSummary.totalCalls });
    return {
        phase: 'finalize' as PhaseName,
        tokenUsage: usageSnapshot,
        transcript: [msg('conductor', 'finalize', `Run complete. Total tokens: ${usageSummary.totalTokens.toLocaleString()} across ${usageSummary.totalCalls} LLM calls. Reports: ${htmlPath}`)],
    };
}
