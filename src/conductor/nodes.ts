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
import { createProjectWorkspace, createRunOutputDir } from '../utils/workspace';
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
import { deployAllConventionsToWorkspace, resolveConventionFiles } from '../utils/coding-conventions';
import { getPlaywrightMcpTools, closePlaywrightMcp } from '../tools/mcp/playwright-mcp';
import {
    MAX_BUGFIX_ITERATIONS, GIT_DEFAULT_BRANCH, PIPELINE_RECURSION_LIMIT,
    TOOL_PIPELINE_RECURSION_LIMIT,
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    GITHUB_PROJECT_TOKEN, GITHUB_PROJECT_OWNER,
    ARCHITECT_MODEL, PRODUCT_MANAGER_MODEL, DBA_MODEL, TEAM_LEADER_MODEL,
    DEVOPS_MODEL, CODEBASE_ANALYZER_MODEL, QA_MODEL, LLM_MODEL,
    MODEL_PRICING, DEV_CONTEXT_FILE_CHANGES_LIMIT,
    DEVOPS_VERIFY_ENABLED, DEVOPS_TEARDOWN,
} from '../config';
import { sanitizeMermaidLabels } from '../tools/diagram/diagram-tools';
import { createGitHubRepo, validateGitHubRepo, initializeRepoLocally } from '../utils/github-repo-manager';
import { gitExec, gitPush, findGitRoot } from '../utils/git-exec';
import { syncWorkspaceToBranch, looksSourceless } from './workspace-sync';
import { selectPendingAssignments, dedupeBugs, namespaceBugfixAssignments } from './assignment-policy';
import { verifyDeployment, teardownDeployment } from './devops-verify';
import { runQualityGates, gateReportToTestReport, synthesiseGateBugs } from './quality-gates';
import { execSync } from 'child_process';
import type { ProjectStateType } from './state';
import type { PhaseName, TranscriptMessage, Bug, CodebaseAnalysis, GitContext } from '../agents/_shared/base-schemas';
import { tokenTracker, type TokenCallRecord } from '../utils/token-tracker';
import { extractTokenUsageFromMessages } from '../utils/token-usage-extractor';
import { generateTokenReport, refreshTokenReport } from '../utils/token-report';
import { getThrottleStats, logThrottleStats } from '../utils/llm-throttle';
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
    return { timestamp: ts(), agentId, phase, message };
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
    if (!status || status.includes('nothing to commit')) return;

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

async function invokeAgent(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, phase: string,
    opts?: { recursionLimit?: number },
): Promise<{ output: any; tokenUsage: TokenCallRecord | null }> {
    const recursionLimit = opts?.recursionLimit ?? PIPELINE_RECURSION_LIMIT;
    return retryWithBackoff(async () => {
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `conductor-${threadSuffix}-${Date.now()}` }, recursionLimit },
        );

        // Extract per-invocation token usage from messages (complementary to callback tracking)
        const model = getModelForAgent(agentId);
        const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, phase);

        const last = result.messages[result.messages.length - 1];
        if (typeof last.content !== 'string') return { output: last.content, tokenUsage };

        // Try direct JSON parse first
        const raw = last.content.trim();
        try { return { output: JSON.parse(raw), tokenUsage }; } catch { /* fall through */ }

        // Try to extract JSON from markdown code blocks or raw braces
        const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (codeBlock) {
            try { return { output: JSON.parse(codeBlock[1].trim()), tokenUsage }; } catch { /* fall through */ }
        }
        const braces = raw.match(/(\{[\s\S]*\})/);
        if (braces) {
            try { return { output: JSON.parse(braces[1]), tokenUsage }; } catch { /* fall through */ }
        }

        throw new SyntaxError(
            `Agent "${threadSuffix}" did not return valid JSON. Response starts with: ${raw.substring(0, 200)}`
        );
    }, threadSuffix);
}

// ─── 1. Intake ──────────────────────────────────────────────────────────────

const intakeLog = getLogger('[Intake]', 255);

export async function intakeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    intakeLog.info('Starting intake phase...');
    tokenTracker.reset();

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

        if (!projectToken) {
            throw new Error(
                'No GitHub token available for project repo. ' +
                'Set GITHUB_PROJECT_TOKEN or GITHUB_TOKEN in your environment.',
            );
        }
        if (!projectOwner) {
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
            throw new Error(
                `Workspace is not inside a Git repository: ${workspacePath}. ` +
                `Initialize with 'git init' in a parent directory and configure a GitHub remote before running.`
            );
        }
        defaultBranch = detectDefaultBranch(gitRoot);

        gitContext = {
            token: GITHUB_TOKEN,
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            defaultBranch,
        };
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

    intakeLog.info(`Workspace: ${workspacePath}`);
    intakeLog.info(`Output: ${outputPath}`);
    intakeLog.info(`Run type: ${state.input.runType ?? 'greenfield'}`);

    const nextPhase = state.input.runType === 'maintain' ? 'codebase-analyzer' : 'architect';

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
    analyzerLog.info('Starting codebase analysis...');
    const apiKey = await getAccessToken();
    const agent = createCodebaseAnalyzerAgent(apiKey, state.workspacePath);

    // Check for existing analysis to use as baseline
    const existingAnalysis = readExistingAnalysis(state.workspacePath);
    const contextParts: string[] = [];
    if (existingAnalysis) {
        analyzerLog.info('Found existing codebase-analysis.md — using as baseline');
        contextParts.push(`## Previous Codebase Analysis (use as baseline, update what changed)\n\n${existingAnalysis}`);
    }
    contextParts.push(`## Task\n\nAnalyze the codebase at the workspace root and produce a comprehensive CodebaseAnalysis.`);

    const userMsg = contextParts.join('\n\n');
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'codebase-analyzer', 'codebase-analyzer', 'codebase-analyzer', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT });

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

    return {
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
    archLog.info('Starting architecture phase...');
    const apiKey = await getAccessToken();
    const agent = createArchitectAgent(apiKey);

    const userMsgParts = [`## System Requirements\n\n${state.input.requirementsText}`];
    if (state.codebaseAnalysis) {
        userMsgParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
        userMsgParts.push(`\n## NOTE: This is MAINTAIN mode. Design CHANGES to the existing system, not a new system from scratch.`);
    }
    const userMsg = userMsgParts.join('\n');
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'architect', 'architect', 'architect');

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

    return {
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
    pmLog.info('Starting product management phase...');
    const apiKey = await getAccessToken();
    const agent = createProductManagerAgent(apiKey);

    const pmParts = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## Epics\n\n${JSON.stringify(state.epics, null, 2)}`,
        `\n## Original Requirements\n\n${state.input.requirementsText}`,
    ];
    if (state.codebaseAnalysis) {
        pmParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
        pmParts.push(`\n## NOTE: This is MAINTAIN mode. Create stories/tasks for CHANGES to the existing system.`);
    }
    const userMsg = pmParts.join('\n');

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'pm', 'product-manager', 'product-manager');
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

    return {
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
    dbaLog.info('Starting database design phase...');
    const apiKey = await getAccessToken();
    const agent = createDbaAgent(apiKey);

    const dbaParts = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Tasks\n\n${JSON.stringify(state.tasks, null, 2)}`,
    ];
    if (state.codebaseAnalysis) {
        dbaParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
        dbaParts.push(`\n## NOTE: This is MAINTAIN mode. Design only the DB CHANGES needed, not the full schema from scratch.`);
    }
    const userMsg = dbaParts.join('\n');

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'dba', 'dba', 'dba');
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

    return {
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
    tlLog.info('Starting assignment phase...');
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const projectSlug = state.systemBranch.replace(/^project\//, '');

    const tlParts = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Tasks\n\n${JSON.stringify(state.tasks, null, 2)}`,
        `\n## Project Slug: ${projectSlug}\nUse this slug as the prefix for all branch names (e.g., "${projectSlug}/feature/US-001-description").`,
    ];
    if (state.codebaseAnalysis) {
        tlParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
        tlParts.push(`\n## NOTE: This is MAINTAIN mode. Assignments may involve modifying existing files.`);
    }
    const userMsg = tlParts.join('\n');

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'tl', 'team-leader', 'team-leader');
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

    return {
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
    devLog.info(`Starting development with ${state.assignments.length} assignments...`);

    // ── Filter to only pending assignments (fixes A2) ────────────────────
    const pending = selectPendingAssignments(state.assignments, state.completedAssignmentIds);
    devLog.info(`Development: ${pending.length} pending of ${state.assignments.length} total assignments (${state.completedAssignmentIds.length} already complete)`);
    if (pending.length === 0) {
        devLog.warn('No pending assignments — skipping development phase');
        return { phase: 'qa' as PhaseName, transcript: [msg('conductor', 'development', 'No pending assignments')] };
    }

    const apiKey = await getAccessToken();

    // Deploy coding convention files to the workspace for agents to read
    deployAllConventionsToWorkspace(state.workspacePath);

    // ── Cap the fileChanges blob (fixes A2 cost) ─────────────────────────
    const recent = state.fileChanges.slice(-DEV_CONTEXT_FILE_CHANGES_LIMIT);
    const fileChangesSummary = recent.length > 0
        ? `\n## Files Already Written (${state.fileChanges.length} total, showing last ${recent.length})\n\n`
          + recent.map(c => `- ${(c as any).action ?? 'modify'} ${(c as any).path}`).join('\n')
        : '';

    const devParts = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        fileChangesSummary,
    ];
    if (state.codebaseAnalysis) {
        devParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
        devParts.push(`\n## NOTE: This is MAINTAIN mode. Modify existing files where appropriate rather than creating new ones.`);
    }
    const contextPrompt = devParts.join('\n');
    const projectSlug = state.systemBranch.replace(/^project\//, '');

    const result = await dispatchDevelopers(apiKey, pending, state.workspacePath, contextPrompt, state.systemBranch, projectSlug, state.gitContext, state.techStack, state.completedAssignmentIds);

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

    return {
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

    // Deploy conventions (idempotent — skips if already deployed)
    deployAllConventionsToWorkspace(state.workspacePath);

    // Resolve convention files for QA agents based on tech stack
    const qaConventionFiles = resolveConventionFiles([], state.techStack);

    // 7a. QA Lead — create test plan
    qaLog.info('QA Lead creating test plan...');
    const qaTokenUsage: TokenCallRecord[] = [];
    let leadOutput: any = { testPlan: { unit: [], integration: [], e2e: [] } };
    let leadArtifact: any = null;
    try {
        const qaLeadAgent = createQaLeadAgent(apiKey);
        const leadMsg = [
            `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
            `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
            `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
            `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        ].join('\n');
        const r = await invokeAgent(qaLeadAgent, leadMsg, 'qa-lead', 'qa-lead', 'qa');
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
        const unitMsg = [
            `## Test Plan (unit + integration)\n\n${JSON.stringify({ unit: leadOutput.testPlan?.unit ?? [], integration: leadOutput.testPlan?.integration ?? [] }, null, 2)}`,
            `\n## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
            `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        ].join('\n');
        const r = await invokeAgent(qaUnitAgent, unitMsg, 'qa-unit', 'qa-unit', 'qa', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT });
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

    return {
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
    const iteration = state.iteration.bugfix + 1;
    bugLog.info(`Bug-fix triage iteration ${iteration}/${MAX_BUGFIX_ITERATIONS}`);

    // ── Deduplicate and filter already-fixed bugs ────────────────────────
    const fixedSet = new Set(state.fixedBugIds ?? []);
    const openBugs = dedupeBugs(state.bugs)
        .filter(b => !fixedSet.has(b.id))
        .filter(b => b.severity === 'critical' || b.severity === 'major');

    if (openBugs.length === 0) {
        bugLog.info('No critical/major bugs — skipping to DevOps');
        return {
            phase: 'devops' as PhaseName,
            iteration: { bugfix: iteration },
            transcript: [msg('team-leader', 'bugfix-triage', 'No critical bugs to fix')],
        };
    }

    bugLog.info(`Re-assigning ${openBugs.length} bugs to developers...`);
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const userMsg = [
        `## Bug-fix Triage — Iteration ${iteration}`,
        `\n## Open Bugs\n\n${JSON.stringify(openBugs, null, 2)}`,
        `\n## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Existing Assignments\n\n${JSON.stringify(state.assignments, null, 2)}`,
        `\n\nPlease create NEW assignments to fix these bugs. Assign each bug to the most appropriate developer.`,
    ].join('\n');

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, `tl-bugfix-${iteration}`, 'team-leader', 'bugfix-triage');

    // ── Namespace bugfix assignment ids to avoid collisions ──────────────
    const rawAssignments = output.assignments ?? [];
    const namespacedAssignments = namespaceBugfixAssignments(rawAssignments, iteration);
    bugLog.info(`Created ${namespacedAssignments.length} bugfix assignments (iteration ${iteration})`);

    // Track which bugs are being addressed in this iteration
    const bugIdsBeingFixed = openBugs.map(b => b.id);

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

    // Deploy conventions (idempotent — skips if already deployed)
    deployAllConventionsToWorkspace(state.workspacePath);

    // Resolve convention files for DevOps agent based on tech stack
    const devopsConventionFiles = resolveConventionFiles([], state.techStack);

    let output: any = { devops: { buildStatus: 'failed', runStatus: 'failed', serviceUrls: [], healthChecks: [] }, fileChanges: [] };
    let tokenUsage: TokenCallRecord | null = null;
    const transcript: TranscriptMessage[] = [];
    let verifiedContainers: string[] = [];

    try {
        const agent = createDevOpsAgent(apiKey, state.workspacePath, devopsConventionFiles);

        const devopsParts = [
            `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
            `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
            `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
            `\n## File Changes\n\n${JSON.stringify(state.fileChanges, null, 2)}`,
        ];
        if (state.codebaseAnalysis) {
            devopsParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
            devopsParts.push(`\n## NOTE: This is MAINTAIN mode. Update existing Docker/K8s configs rather than creating from scratch.`);
        }
        const userMsg = devopsParts.join('\n');

        const r = await invokeAgent(agent, userMsg, 'devops', 'devops', 'devops', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT });
        output = r.output;
        tokenUsage = r.tokenUsage;
        opsLog.info(`Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`);
    } catch (err: any) {
        opsLog.error(`DevOps agent failed: ${err.message}`);
        if (err?.stack) opsLog.error(err.stack);
        transcript.push(msg('devops', 'devops', `DevOps agent failed: ${err.message}`));
    }

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

    return {
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
        const { output: e2eOutput, tokenUsage: e2eTU } = await invokeAgent(qaE2eAgent, e2eMsg, 'qa-e2e', 'qa-e2e', 'e2e', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT });
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

        return {
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
        return {
            phase: 'finalize' as PhaseName,
            transcript,
            tokenUsage: e2eTokenUsage,
        };
    }
}

// ─── 10. Finalize ───────────────────────────────────────────────────────────

const finalLog = getLogger('[Finalize]', 46);

export async function finalizeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
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

    // ── Mark run as completed ────────────────────────────────────────────
    tokenTracker.setRunStatus('completed');

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
    const summaryText = summary.join('\n');

    finalLog.info(`\n${summaryText}`);
    logThrottleStats();

    // Write final summary artifact
    writeArtifact({
        agentId: 'conductor',
        colorCode: 46,
        workspacePath: state.workspacePath,
        title: 'Run Summary',
        content: summaryText,
    });

    // ── Cost estimation helper ────────────────────────────────────────────
    function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
        const pricing = MODEL_PRICING[model];
        if (!pricing) return 0;
        return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
    }

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

    // ── HTML token usage report + raw JSON ──────────────────────────────
    const { jsonPath, htmlPath } = generateTokenReport(
        usageSnapshot,
        state.outputPath,
        state.input.systemName,
        'completed',
    );
    finalLog.info(`Token usage JSON: ${jsonPath}`);
    finalLog.info(`Token usage HTML report: ${htmlPath}`);

    return {
        phase: 'finalize' as PhaseName,
        tokenUsage: usageSnapshot,
        transcript: [msg('conductor', 'finalize', `Run complete. Total tokens: ${usageSummary.totalTokens.toLocaleString()} across ${usageSummary.totalCalls} LLM calls. Reports: ${htmlPath}`)],
    };
}
