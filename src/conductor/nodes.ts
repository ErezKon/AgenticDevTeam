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
import { getPlaywrightMcpTools, closePlaywrightMcp } from '../tools/mcp/playwright-mcp';
import {
    MAX_BUGFIX_ITERATIONS, GIT_DEFAULT_BRANCH, AGENT_RECURSION_LIMIT,
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GIT_USER_NAME, GIT_USER_EMAIL,
    GITHUB_PROJECT_TOKEN, GITHUB_PROJECT_OWNER,
    ARCHITECT_MODEL, PRODUCT_MANAGER_MODEL, DBA_MODEL, TEAM_LEADER_MODEL,
    DEVOPS_MODEL, CODEBASE_ANALYZER_MODEL, QA_MODEL, LLM_MODEL,
    MODEL_PRICING,
} from '../config';
import { createGitHubRepo, validateGitHubRepo, initializeRepoLocally } from '../utils/github-repo-manager';
import { execSync } from 'child_process';
import type { ProjectStateType } from './state';
import type { PhaseName, TranscriptMessage, Bug, CodebaseAnalysis, GitContext } from '../agents/_shared/base-schemas';
import { tokenTracker, type TokenCallRecord } from '../utils/token-tracker';
import { extractTokenUsageFromMessages } from '../utils/token-usage-extractor';
import { generateTokenReport } from '../utils/token-report';
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

function gitExec(workspacePath: string, args: string): string {
    try {
        return execSync(`git ${args}`, {
            cwd: workspacePath, encoding: 'utf-8',
            timeout: 30_000, maxBuffer: 1024 * 1024 * 5,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: GIT_USER_NAME, GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
                GIT_COMMITTER_NAME: GIT_USER_NAME, GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
            },
        }).trim();
    } catch (err: any) {
        return `Error: ${err.stderr?.toString() ?? err.message}`.trim();
    }
}

function gitPush(workspacePath: string, branchName: string, gitContext?: GitContext | null): string {
    const token = gitContext?.token ?? GITHUB_TOKEN;
    const owner = gitContext?.owner ?? GITHUB_OWNER;
    const repo = gitContext?.repo ?? GITHUB_REPO;
    const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    return gitExec(workspacePath, `push ${authUrl} HEAD:refs/heads/${branchName}`);
}

function msg(agentId: string, phase: PhaseName, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase, message };
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
): Promise<{ output: any; tokenUsage: TokenCallRecord | null }> {
    return retryWithBackoff(async () => {
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `conductor-${threadSuffix}-${Date.now()}` }, recursionLimit: AGENT_RECURSION_LIMIT },
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
        // Walk up from workspacePath to find the nearest .git directory.
        let foundGitRoot: string | null = null;
        let search = workspacePath;
        while (true) {
            if (fs.existsSync(path.join(search, '.git'))) {
                foundGitRoot = search;
                break;
            }
            const parent = path.dirname(search);
            if (parent === search) break; // reached filesystem root
            search = parent;
        }
        if (!foundGitRoot) {
            throw new Error(
                `Workspace is not inside a Git repository: ${workspacePath}. ` +
                `Initialize with 'git init' in a parent directory and configure a GitHub remote before running.`
            );
        }
        gitRoot = foundGitRoot;
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
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'codebase-analyzer', 'codebase-analyzer', 'codebase-analyzer');

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
            output.architecture?.mermaidDiagram ? `\n\`\`\`mermaid\n${output.architecture.mermaidDiagram}\n\`\`\`` : '',
            `\n## Modules (${(output.modules ?? []).length})`,
            ...(output.modules ?? []).map((m: any) => `- **${m.name}** (\`${m.path}\`): ${m.responsibility}`),
            `\n## Known Issues (${(output.knownIssues ?? []).length})`,
            ...(output.knownIssues ?? []).map((i: string) => `- ${i}`),
        ].join('\n'),
    });

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
            output.architecture?.mermaidDiagram ? `\n## Architecture Diagram\n\n\`\`\`mermaid\n${output.architecture.mermaidDiagram}\n\`\`\`` : '',
        ].join('\n'),
    });

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
            output.dbDesign?.erdMermaid ? `\n## ERD\n\n\`\`\`mermaid\n${output.dbDesign.erdMermaid}\n\`\`\`` : '',
        ].join('\n'),
    });

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
    const apiKey = await getAccessToken();

    const devParts = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Existing File Changes\n\n${JSON.stringify(state.fileChanges, null, 2)}`,
    ];
    if (state.codebaseAnalysis) {
        devParts.unshift(`## Existing Codebase Analysis\n\n${JSON.stringify(state.codebaseAnalysis, null, 2)}`);
        devParts.push(`\n## NOTE: This is MAINTAIN mode. Modify existing files where appropriate rather than creating new ones.`);
    }
    const contextPrompt = devParts.join('\n');
    const projectSlug = state.systemBranch.replace(/^project\//, '');

    const result = await dispatchDevelopers(apiKey, state.assignments, state.workspacePath, contextPrompt, state.systemBranch, projectSlug, state.gitContext);

    devLog.info(`Development complete: ${result.fileChanges.length} file changes, ${result.pullRequests.length} PRs`);

    return {
        fileChanges: result.fileChanges,
        artifacts: result.artifacts,
        pullRequests: result.pullRequests,
        transcript: [
            ...result.transcript,
            msg('conductor', 'development', `Development phase complete: ${result.fileChanges.length} files changed, ${result.pullRequests.length} PRs merged`),
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

    // 7a. QA Lead — create test plan
    qaLog.info('QA Lead creating test plan...');
    const qaTokenUsage: TokenCallRecord[] = [];
    const qaLeadAgent = createQaLeadAgent(apiKey);
    const leadMsg = [
        `## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## User Stories\n\n${JSON.stringify(state.userStories, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
        `\n## DB Design\n\n${JSON.stringify(state.dbDesign, null, 2)}`,
    ].join('\n');
    const { output: leadOutput, tokenUsage: leadTokenUsage } = await invokeAgent(qaLeadAgent, leadMsg, 'qa-lead', 'qa-lead', 'qa');
    if (leadTokenUsage) qaTokenUsage.push(leadTokenUsage);
    qaLog.info(`Test plan: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`);

    const leadArtifact = writeArtifact({
        agentId: 'qa-lead', colorCode: 198, workspacePath: state.workspacePath,
        title: 'QA Lead — Test Plan',
        content: `## Test Plan\n\n${JSON.stringify(leadOutput.testPlan, null, 2)}`,
    });
    transcript.push(msg('qa-lead', 'qa', `Test plan created: ${leadOutput.testPlan?.unit?.length ?? 0} unit, ${leadOutput.testPlan?.e2e?.length ?? 0} e2e`));

    // 7b. QA Unit — write & run unit/integration tests
    qaLog.info('QA Unit writing and running tests...');
    const qaUnitAgent = createQaUnitAgent(apiKey, state.workspacePath);
    const unitMsg = [
        `## Test Plan (unit + integration)\n\n${JSON.stringify({ unit: leadOutput.testPlan?.unit, integration: leadOutput.testPlan?.integration }, null, 2)}`,
        `\n## Architecture\n\n${JSON.stringify(state.architecture, null, 2)}`,
        `\n## Tech Stack\n\n${JSON.stringify(state.techStack, null, 2)}`,
    ].join('\n');
    const { output: unitOutput, tokenUsage: unitTokenUsage } = await invokeAgent(qaUnitAgent, unitMsg, 'qa-unit', 'qa-unit', 'qa');
    if (unitTokenUsage) qaTokenUsage.push(unitTokenUsage);
    qaLog.info(`Unit tests: ${unitOutput.testReport?.passed ?? 0} passed, ${unitOutput.testReport?.failed ?? 0} failed`);
    if (unitOutput.bugs) allBugs.push(...unitOutput.bugs);

    const unitArtifact = writeArtifact({
        agentId: 'qa-unit', colorCode: 205, workspacePath: state.workspacePath,
        title: 'QA Unit — Test Report',
        content: `## Results\n\n${JSON.stringify(unitOutput.testReport, null, 2)}`,
    });
    transcript.push(msg('qa-unit', 'qa', `Unit tests: ${unitOutput.testReport?.passed ?? 0}/${unitOutput.testReport?.total ?? 0} passed`));

    // 7c. QA E2E — Playwright MCP testing (only if services are running)
    let e2eReport = null;
    let e2eArtifact = null;
    if (state.devopsPlan?.serviceUrls && state.devopsPlan.serviceUrls.length > 0) {
        qaLog.info('QA E2E running Playwright tests...');
        try {
            const mcpTools = await getPlaywrightMcpTools();
            const qaE2eAgent = createQaE2eAgent(apiKey, mcpTools);
            const e2eMsg = [
                `## Test Plan (e2e)\n\n${JSON.stringify(leadOutput.testPlan?.e2e, null, 2)}`,
                `\n## Service URLs\n\n${JSON.stringify(state.devopsPlan.serviceUrls, null, 2)}`,
            ].join('\n');
            const { output: e2eOutput, tokenUsage: e2eTokenUsage } = await invokeAgent(qaE2eAgent, e2eMsg, 'qa-e2e', 'qa-e2e', 'qa');
            if (e2eTokenUsage) qaTokenUsage.push(e2eTokenUsage);
            e2eReport = e2eOutput.testReport;
            if (e2eOutput.bugs) allBugs.push(...e2eOutput.bugs);
            qaLog.info(`E2E tests: ${e2eReport?.passed ?? 0} passed, ${e2eReport?.failed ?? 0} failed`);

            e2eArtifact = writeArtifact({
                agentId: 'qa-e2e', colorCode: 118, workspacePath: state.workspacePath,
                title: 'QA E2E — Test Report',
                content: `## Results\n\n${JSON.stringify(e2eReport, null, 2)}`,
            });
            transcript.push(msg('qa-e2e', 'qa', `E2E tests: ${e2eReport?.passed ?? 0}/${e2eReport?.total ?? 0} passed`));
            await closePlaywrightMcp();
        } catch (err: any) {
            qaLog.error(`E2E testing failed: ${err.message}`);
            transcript.push(msg('qa-e2e', 'qa', `E2E testing failed: ${err.message}`));
        }
    } else {
        qaLog.info('Skipping E2E tests — no running services');
        transcript.push(msg('qa-e2e', 'qa', 'Skipped — no running services'));
    }

    // B11: Commit QA-generated files to the system branch
    const systemSlug = path.basename(state.workspacePath);
    gitExec(state.workspacePath, 'add .');
    const qaStatus = gitExec(state.workspacePath, 'status --short');
    if (qaStatus && !qaStatus.includes('nothing to commit')) {
        gitExec(state.workspacePath, `commit -m "[${systemSlug}]-chore: QA unit test files"`);
        const currentBranch = gitExec(state.workspacePath, 'rev-parse --abbrev-ref HEAD');
        if (currentBranch && !currentBranch.startsWith('Error:')) {
            gitPush(state.workspacePath, currentBranch, state.gitContext);
            qaLog.info(`Committed and pushed QA test files on ${currentBranch}`);
        }
    }

    const testReports = [unitOutput.testReport, ...(e2eReport ? [e2eReport] : [])].filter(Boolean);
    const artifacts = [leadArtifact, unitArtifact, ...(e2eArtifact ? [e2eArtifact] : [])];

    return {
        testPlan: leadOutput.testPlan,
        testReports,
        bugs: allBugs,
        fileChanges: unitOutput.fileChanges ?? [],
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

    const openBugs = state.bugs.filter(b => b.severity === 'critical' || b.severity === 'major');
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
    bugLog.info(`Created ${output.assignments?.length ?? 0} bugfix assignments`);

    return {
        assignments: output.assignments ?? [],
        iteration: { bugfix: iteration },
        phase: 'development' as PhaseName,
        transcript: [msg('team-leader', 'bugfix-triage', `Iteration ${iteration}: reassigned ${output.assignments?.length ?? 0} bug fixes`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 9. DevOps ──────────────────────────────────────────────────────────────

const opsLog = getLogger('[DevOps]', 33);

export async function devopsNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    opsLog.info('Starting DevOps phase...');
    const apiKey = await getAccessToken();
    const agent = createDevOpsAgent(apiKey, state.workspacePath);

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

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'devops', 'devops', 'devops');
    opsLog.info(`Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`);

    const artifact = writeArtifact({
        agentId: 'devops', colorCode: 33, workspacePath: state.workspacePath,
        title: 'DevOps Mission Report',
        content: [
            `## Build Status: ${output.devops?.buildStatus}`,
            `## Run Status: ${output.devops?.runStatus}`,
            `\n## Services\n\n${(output.devops?.serviceUrls ?? []).map((s: any) => `- **${s.service}**: ${s.url}`).join('\n')}`,
            `\n## Health Checks\n\n${(output.devops?.healthChecks ?? []).map((h: any) => `- ${h.service}: ${h.status}`).join('\n')}`,
        ].join('\n'),
    });

    // B11: Commit DevOps-generated files to the system branch
    const devopsSlug = path.basename(state.workspacePath);
    gitExec(state.workspacePath, 'add .');
    const devopsStatus = gitExec(state.workspacePath, 'status --short');
    if (devopsStatus && !devopsStatus.includes('nothing to commit')) {
        gitExec(state.workspacePath, `commit -m "[${devopsSlug}]-chore: DevOps configuration files"`);
        const currentBranch = gitExec(state.workspacePath, 'rev-parse --abbrev-ref HEAD');
        if (currentBranch && !currentBranch.startsWith('Error:')) {
            gitPush(state.workspacePath, currentBranch, state.gitContext);
            opsLog.info(`Committed and pushed DevOps files on ${currentBranch}`);
        }
    }

    return {
        devopsPlan: output.devops,
        fileChanges: output.fileChanges ?? [],
        phase: 'finalize' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('devops', 'devops', `Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}

// ─── 10. Finalize ───────────────────────────────────────────────────────────

const finalLog = getLogger('[Finalize]', 46);

export async function finalizeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    finalLog.info('Finalizing run...');

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
    ].join('\n');

    finalLog.info(`\n${summary}`);

    // Write final summary artifact
    writeArtifact({
        agentId: 'conductor',
        colorCode: 46,
        workspacePath: state.workspacePath,
        title: 'Run Summary',
        content: summary,
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
    );
    finalLog.info(`Token usage JSON: ${jsonPath}`);
    finalLog.info(`Token usage HTML report: ${htmlPath}`);

    return {
        phase: 'finalize' as PhaseName,
        tokenUsage: usageSnapshot,
        transcript: [msg('conductor', 'finalize', `Run complete. Total tokens: ${usageSummary.totalTokens.toLocaleString()} across ${usageSummary.totalCalls} LLM calls. Reports: ${htmlPath}`)],
    };
}
