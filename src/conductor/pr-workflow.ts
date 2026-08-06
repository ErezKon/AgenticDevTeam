/**
 * PR Workflow Orchestrator
 *
 * Manages the full lifecycle of a pull request:
 *   branch creation → dev work → PR creation → review loop → merge
 *
 * Called by the dispatcher for each branch group of assignments.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { getLogger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { writeArtifact } from '../agents/_shared/artifact';
import { buildDevAgent } from '../agents/developers/dev-agent.builder';
import { buildReviewerAgent } from '../agents/developers/reviewer-agent.builder';
import { getDevAgent, DEV_AGENTS } from '../agents/developers/registry';
import { resolveConventionFiles } from '../utils/coding-conventions';
import { gitExec, gitPush, findGitRoot } from '../utils/git-exec';
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    DEV_RECURSION_LIMIT, REVIEWER_RECURSION_LIMIT,
    GIT_USER_NAME, GIT_USER_EMAIL,
    PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL, JUNIOR_DEV_MODEL,
    PR_TEST_INSTALL_TIMEOUT_MS, PR_TEST_TIMEOUT_MS,
    CONTEXT_COMPACT,
    SECURITY_GATE_IN_PR,
} from '../config';
import { getEffectiveLimits } from '../utils/run-budget';
import { emitRunEvent } from '../utils/event-bus';
import { GITHUB_MODE, createLocalGitHub } from '../utils/github-local';
import { storiesForIds } from './context-builder';
import { isBlockingReview, evaluateProgress, MAX_NO_PROGRESS_ITERATIONS } from './review-policy';
import { runQualityGates, gateReportToMarkdown } from './quality-gates';
import { scanForSecrets, securityReportToMarkdown } from './security-gates';
import { parseAgentJson, validateAgentOutput } from '../utils/structured-output';
import { DeveloperOutputSchema } from '../agents/developers/schemas/dev-output.schema';
import { ReviewOutputSchema } from '../agents/developers/schemas/review-output.schema';
import type { GateReport } from './quality-gates';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage,
    PhaseName, PullRequest, PRReview, GitContext, TechDecision, UserStory,
} from '../agents/_shared/base-schemas';
import type { DeveloperOutput } from '../agents/developers/schemas/dev-output.schema';
import type { ReviewOutput } from '../agents/developers/schemas/review-output.schema';
import { extractTokenUsageFromMessages } from '../utils/token-usage-extractor';
import type { TokenCallRecord } from '../utils/token-tracker';
import type { DevRank } from '../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PRWorkflowInput {
    branchName: string;
    baseBranch: string;
    assignments: Assignment[];
    reviewerAgentIds: string[];
    taskType: 'feature' | 'bug' | 'fix' | 'refactor' | 'chore';
    workspacePath: string;
    apiKey: string;
    contextPrompt: string;
    currentState?: string;
    projectSlug: string;
    gitContext?: GitContext | null;
    techStack?: TechDecision[];
    /** User stories from the PM — when present, only the stories for this branch's
     *  assignments are injected into the dev prompt (fixes A8: every dev got all stories). */
    userStories?: UserStory[];
}

export interface PRWorkflowResult {
    pullRequest: PullRequest;
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
    tokenUsage: TokenCallRecord[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts(): string { return new Date().toISOString(); }

function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase: 'development' as PhaseName, message };
}

// gitExec, gitPush, findGitRoot imported from ../utils/git-exec

/** Local-mode bare repo path, resolved once per process from gitContext. */
let _localBareRepoPath: string | null = null;

/** Set the bare repo path for local GitHub mode (called by intakeNode). */
export function setLocalBareRepoPath(p: string): void {
    _localBareRepoPath = p;
}

function getOctokit(gitContext?: GitContext | null): Octokit {
    if (GITHUB_MODE === 'local') {
        // Return a local GitHub stand-in backed by a bare repo
        const bareRepoPath = _localBareRepoPath ?? gitContext?.repo ?? '';
        return createLocalGitHub(bareRepoPath) as unknown as Octokit;
    }
    const token = gitContext?.token ?? GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN is not set. Cannot perform GitHub API operations.');
    }
    return new Octokit({ auth: token });
}

/**
 * Create a GitHub PR using curl as a fallback when Octokit fails.
 * This avoids Node.js HTTP stack issues with corporate SSL proxies.
 */
function createPRViaCurl(title: string, body: string, head: string, base: string, gitContext?: GitContext | null): { number: number; html_url: string; node_id: string } {
    const token = gitContext?.token ?? GITHUB_TOKEN;
    const owner = gitContext?.owner ?? GITHUB_OWNER;
    const repo = gitContext?.repo ?? GITHUB_REPO;
    const payload = JSON.stringify({ title, body, head, base });
    const result = execSync(
        `curl -s -X POST "https://api.github.com/repos/${owner}/${repo}/pulls" `
        + `-H "Authorization: token ${token}" `
        + `-H "Accept: application/vnd.github+json" `
        + `-H "Content-Type: application/json" `
        + `--data-binary @-`,
        { encoding: 'utf-8', timeout: 30_000, input: payload },
    ).trim();
    const data = JSON.parse(result);
    if (data.message) {
        throw new Error(`GitHub API error: ${data.message} (${JSON.stringify(data.errors ?? [])})`);
    }
    return { number: data.number, html_url: data.html_url, node_id: data.node_id };
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

// ensureDepsAndRunTests removed — replaced by runQualityGates (fixes A6)

// findGitRoot imported from ../utils/git-exec

// ─── PR title & description builders ─────────────────────────────────────────

function buildPRTitle(assignments: Assignment[], taskType: string, projectSlug: string): string {
    const prefix = taskType === 'bug' ? 'fix' : taskType === 'refactor' ? 'refactor' : 'feat';
    let desc: string;
    if (assignments.length === 1) {
        desc = assignments[0].description.split('.')[0].trim();
    } else {
        // Multiple assignments — summarize
        const storyIds = [...new Set(assignments.map(a => a.storyId))];
        desc = `${assignments[0].description.split('.')[0].trim()} (${storyIds.join(', ')})`;
    }
    // Strip backticks and truncate to 80 chars on word boundary
    desc = desc.replace(/`/g, '');
    if (desc.length > 80) {
        desc = desc.slice(0, 77).replace(/\s+\S*$/, '') + '...';
    }
    return `[${projectSlug}] ${prefix}: ${desc}`;
}

function buildPRDescription(
    assignments: Assignment[],
    fileChanges: FileChange[],
    taskType: string,
    currentState?: string,
    authorAgentId?: string,
): string {
    const sections: string[] = [];

    // Author attribution
    if (authorAgentId) {
        const authorEntry = getDevAgent(authorAgentId);
        const authorLabel = authorEntry ? `${authorEntry.name} (${authorAgentId})` : authorAgentId;
        sections.push(`**Opened by ${authorLabel}**\n`);
    }

    // Task summary
    sections.push('## Task Summary\n');
    for (const a of assignments) {
        sections.push(`- **${a.id}** [${a.priority}/${a.complexity}]: ${a.description}`);
    }

    // Derived actions
    sections.push('\n## Derived Actions\n');
    const storyIds = [...new Set(assignments.map(a => a.storyId))];
    sections.push(`Stories covered: ${storyIds.join(', ')}`);
    sections.push(`Developers involved: ${[...new Set(assignments.map(a => a.devAgentId))].join(', ')}`);

    // Current state (for bug/fix/refactor)
    if (['bug', 'fix', 'refactor'].includes(taskType) && currentState) {
        sections.push('\n## Current State\n');
        sections.push(currentState);
    }

    // Changes made
    sections.push('\n## Changes Made\n');
    if (fileChanges.length > 0) {
        for (const fc of fileChanges) {
            sections.push(`- **${fc.action}** \`${fc.path}\` — ${fc.summary}`);
        }
    } else {
        sections.push('_(changes will be listed after development)_');
    }

    return sections.join('\n');
}

// ─── Agent invocation helpers ────────────────────────────────────────────────

/** Resolve the LLM model name for a developer/reviewer rank. */
function getModelForRank(rank: DevRank): string {
    switch (rank) {
        case 'principal': return PRINCIPAL_DEV_MODEL;
        case 'senior':    return SENIOR_DEV_MODEL;
        case 'junior':    return JUNIOR_DEV_MODEL;
    }
}

async function invokeDevAgent(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, model: string,
): Promise<{ output: DeveloperOutput; tokenUsage: TokenCallRecord | null }> {
    return retryWithBackoff(async () => {
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `dev-pr-${threadSuffix}-${Date.now()}` }, recursionLimit: DEV_RECURSION_LIMIT },
        );
        const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, 'development');

        // Guard against empty or missing messages array
        if (!result?.messages || result.messages.length === 0) {
            log.warn(`Dev agent ${agentId} returned no messages — returning empty output`);
            return { output: { fileChanges: [], notes: 'Agent returned no messages (possible tool loop or recursion limit).' }, tokenUsage };
        }

        const last = result.messages[result.messages.length - 1];
        if (!last || last.content == null) {
            log.warn(`Dev agent ${agentId} returned message with no content — returning empty output`);
            return { output: { fileChanges: [], notes: 'Agent returned empty content.' }, tokenUsage };
        }

        const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        const parseResult = parseAgentJson(raw);
        if (!parseResult.ok) {
            throw new Error(`Invalid JSON output from dev agent: ${parseResult.error}`);
        }

        // Validate against DeveloperOutputSchema — log issues but return the object
        const validation = validateAgentOutput(DeveloperOutputSchema, parseResult.value);
        if (!validation.ok) {
            log.warn(`Dev agent ${agentId} output schema issues:\n${validation.issues}`);
        }
        return { output: (validation.ok ? validation.value : parseResult.value) as DeveloperOutput, tokenUsage };
    }, `dev-${threadSuffix}`);
}

async function invokeReviewerAgent(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, model: string,
): Promise<{ output: ReviewOutput; tokenUsage: TokenCallRecord | null }> {
    return retryWithBackoff(async () => {
        let result: any;
        try {
            result = await agent.invoke(
                { messages: [{ role: 'user', content: userMessage }] },
                { configurable: { thread_id: `review-${threadSuffix}-${Date.now()}` }, recursionLimit: REVIEWER_RECURSION_LIMIT },
            );
        } catch (err: any) {
            const m = String(err?.message ?? err);
            if (m.includes('Recursion limit') || m.includes('recursion limit')) {
                log.warn(`Reviewer ${agentId} hit the recursion limit — abstaining (treated as approved).`);
                return {
                    output: { status: 'approved', summary: 'Reviewer abstained: tool-call budget exhausted.', comments: [] },
                    tokenUsage: null,
                };
            }
            throw err;   // rate limits stay retriable via retryWithBackoff
        }
        const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, 'review');

        // Guard against empty or missing messages
        if (!result?.messages || result.messages.length === 0) {
            log.warn(`Reviewer ${agentId} returned no messages — defaulting to approved`);
            return { output: { status: 'approved', summary: 'Reviewer returned no messages.', comments: [] }, tokenUsage };
        }

        const last = result.messages[result.messages.length - 1];
        if (!last || last.content == null) {
            log.warn(`Reviewer ${agentId} returned message with no content — defaulting to approved`);
            return { output: { status: 'approved', summary: 'Reviewer returned empty content.', comments: [] }, tokenUsage };
        }

        const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        const parseResult = parseAgentJson(raw);
        if (!parseResult.ok) {
            throw new Error(`Invalid JSON output from reviewer agent: ${parseResult.error}`);
        }

        // Validate against ReviewOutputSchema — log issues, default to approved on garbage
        const validation = validateAgentOutput(ReviewOutputSchema, parseResult.value);
        if (!validation.ok) {
            log.warn(`Reviewer ${agentId} output schema issues (defaulting to approved):\n${validation.issues}`);
            return { output: { status: 'approved', summary: `Reviewer returned invalid schema: ${validation.issues}`, comments: [] }, tokenUsage };
        }
        return { output: validation.value as ReviewOutput, tokenUsage };
    }, `review-${threadSuffix}`);
}

// ─── Escalation helper ──────────────────────────────────────────────────────

/**
 * Find a higher-rank agent for escalation.
 * Escalation path: junior → senior → principal → cross-domain principal.
 */
function findEscalationAgent(
    currentAgentId: string,
    excludeIds: string[],
): string | null {
    const current = getDevAgent(currentAgentId);
    if (!current) return null;

    const rankOrder: Record<string, number> = { junior: 0, senior: 1, principal: 2 };
    const minRank = rankOrder[current.rank] + 1;

    const candidates = DEV_AGENTS.filter(a => {
        if (excludeIds.includes(a.id) || a.id === currentAgentId) return false;
        if (a.domain !== current.domain && a.rank !== 'principal') return false;
        return rankOrder[a.rank] >= Math.min(minRank, 2);
    }).sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank]);

    return candidates[0]?.id ?? null;
}

// ─── Base-ref resolution ─────────────────────────────────────────────────────

/**
 * Resolve baseBranch to a ref that exists in the worktree.
 * Worktrees don't have local branches for the base — only origin/ remotes.
 */
function resolveBaseRef(worktreeDir: string, baseBranch: string): string {
    // Try local branch first
    const localCheck = gitExec(worktreeDir, `rev-parse --verify --quiet ${baseBranch}`);
    if (localCheck && !localCheck.startsWith('Error')) return baseBranch;
    // Fall back to origin/<baseBranch>
    const remoteCheck = gitExec(worktreeDir, `rev-parse --verify --quiet origin/${baseBranch}`);
    if (remoteCheck && !remoteCheck.startsWith('Error')) return `origin/${baseBranch}`;
    // Last resort: return as-is
    return baseBranch;
}

// ─── Main PR workflow ────────────────────────────────────────────────────────

export async function executePRWorkflow(input: PRWorkflowInput): Promise<PRWorkflowResult> {
    const {
        branchName, baseBranch, assignments, reviewerAgentIds, taskType,
        workspacePath, apiKey, contextPrompt, currentState, projectSlug, gitContext,
        techStack, userStories,
    } = input;

    // Resolve owner/repo from gitContext (falls back to config constants)
    const ghOwner = gitContext?.owner ?? GITHUB_OWNER;
    const ghRepo = gitContext?.repo ?? GITHUB_REPO;

    const primaryStoryId = assignments[0]?.storyId ?? 'CLEANUP';

    const allFileChanges: FileChange[] = [];
    const allArtifacts: ArtifactRef[] = [];
    const allTranscript: TranscriptMessage[] = [];
    const allTokenUsage: TokenCallRecord[] = [];

    // ── 0. Create isolated worktree for this branch ─────────────────────
    // Each branch gets its own working directory so parallel agents
    // never interfere with each other via git checkout races.
    const gitRoot = findGitRoot(workspacePath);
    const relativeWorkspace = path.relative(gitRoot, workspacePath);
    const worktreeSlug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');
    const worktreeDir = path.join(gitRoot, '.worktrees', worktreeSlug);
    const worktreeWorkspace = relativeWorkspace
        ? path.join(worktreeDir, relativeWorkspace)
        : worktreeDir;

    log.info(`Creating worktree for branch: ${branchName} (from ${baseBranch})`);

    // Prune stale worktree tracking entries (e.g. directories deleted but
    // git's internal worktree list not updated — prevents "already checked out" errors)
    gitExec(gitRoot, 'worktree prune');

    // Clean up stale worktree from a previous failed run
    if (fs.existsSync(worktreeDir)) {
        gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
    }
    // Delete stale local branch if it exists (ignore errors)
    gitExec(gitRoot, `branch -D ${branchName}`);
    // Fetch latest base branch from remote (may fail if not pushed yet)
    gitExec(gitRoot, `fetch origin ${baseBranch}`);
    // Create worktree with a new branch — try remote ref first, fall back to local.
    // Wrapped in try/catch so a failed creation cleans up the partial directory
    // before re-throwing (fixes A11 worktree leak).
    try {
        let wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -b ${branchName} origin/${baseBranch}`);
        if (wtResult.startsWith('Error:')) {
            log.warn(`Remote ref origin/${baseBranch} not found, falling back to local branch`);
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -b ${branchName} ${baseBranch}`);
        }
        if (wtResult.startsWith('Error:')) {
            throw new Error(`Failed to create worktree for ${branchName}: ${wtResult}`);
        }
        log.info(`Worktree created: ${wtResult}`);
        // Set git identity in the worktree so agent shell commands have valid author
        gitExec(worktreeDir, `config user.name "${GIT_USER_NAME}"`);
        gitExec(worktreeDir, `config user.email "${GIT_USER_EMAIL}"`);
        // Ensure the workspace sub-directory exists in the worktree
        fs.mkdirSync(worktreeWorkspace, { recursive: true });
        allTranscript.push(msg('conductor', `Created isolated worktree for branch: ${branchName} from ${baseBranch}`));
    } catch (wtCreateErr) {
        // Clean up any partial worktree directory so it does not leak (fixes A11)
        if (fs.existsSync(worktreeDir)) {
            gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
        }
        gitExec(gitRoot, 'worktree prune');
        throw wtCreateErr;
    }

    try {
        // Fetch base branch and resolve to a ref that exists in the worktree
        gitExec(worktreeWorkspace, `fetch origin ${baseBranch}`);
        const baseRef = resolveBaseRef(worktreeWorkspace, baseBranch);

        // ── 1. Run dev agent(s) on assignments ──────────────────────────
        // Group by developer agent
        const byDev = new Map<string, Assignment[]>();
        for (const a of assignments) {
            const existing = byDev.get(a.devAgentId) ?? [];
            existing.push(a);
            byDev.set(a.devAgentId, existing);
        }

        for (const [devId, devAssignments] of byDev) {
            const entry = getDevAgent(devId);
            if (!entry) {
                log.warn(`Unknown dev agent: ${devId}, skipping`);
                continue;
            }

            const devLog = getLogger(entry.tag, entry.colorCode);
            devLog.info(`Working on branch ${branchName}: ${devAssignments.length} assignment(s)`);

            const conventionFiles = resolveConventionFiles(entry.languages, techStack);
            const agent = buildDevAgent(apiKey, entry, worktreeWorkspace, gitContext, baseBranch, conventionFiles);

            const assignmentText = devAssignments.map(a =>
                `Assignment ${a.id} [${a.priority}/${a.complexity}]: ${a.description}`
            ).join('\n\n');

            // Build the per-branch story section (fixes A8: every dev got all stories)
            const branchStoryIds = [...new Set(devAssignments.map(a => a.storyId).filter(Boolean))] as string[];
            const storySection = (CONTEXT_COMPACT && userStories?.length && branchStoryIds.length)
                ? `\n## User Stories for This Branch\n\n${storiesForIds(userStories, branchStoryIds)}`
                : '';

            const message = [
                contextPrompt,
                storySection,
                `\n## Project Slug: ${projectSlug}`,
                `\n## Your Branch: ${branchName}`,
                `\nYou are already on this branch. Do NOT create or switch branches — your workspace is isolated for this branch.`,
                `\n## IMPORTANT: Workspace Context`,
                `Your current working directory IS the project root.`,
                `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                `\n## Your Assignments\n\n${assignmentText}`,
            ].join('\n');

            try {
                const devModel = getModelForRank(entry.rank as DevRank);
                const { output, tokenUsage: devTokenUsage } = await invokeDevAgent(agent, message, `${entry.id}-${branchName}`, entry.id, devModel);
                if (devTokenUsage) allTokenUsage.push(devTokenUsage);
                if (output.fileChanges) allFileChanges.push(...output.fileChanges);

                const artifact = writeArtifact({
                    agentId: entry.id,
                    colorCode: entry.colorCode,
                    workspacePath: worktreeWorkspace,
                    title: `${entry.name} Mission Report`,
                    content: [
                        `## Branch: ${branchName}\n`,
                        `## Files Changed\n`,
                        ...(output.fileChanges ?? []).map(fc =>
                            `- **${fc.action}** \`${fc.path}\` — ${fc.summary}`
                        ),
                        output.notes ? `\n## Notes\n\n${output.notes}` : '',
                        output.mermaidDiagram ? `\n## Diagram\n\n\`\`\`mermaid\n${output.mermaidDiagram}\n\`\`\`` : '',
                    ].join('\n'),
                });
                allArtifacts.push(artifact);
                allTranscript.push(msg(entry.id, `Completed ${output.fileChanges?.length ?? 0} file changes on branch ${branchName}`));
                devLog.info(`Done: ${output.fileChanges?.length ?? 0} file changes`);
            } catch (err: any) {
                log.error(`Dev agent ${devId} failed: ${err.message}`);
                allTranscript.push(msg(devId, `Failed: ${err.message}`));
            }
        }

        // Ensure everything is committed and pushed
        gitExec(worktreeWorkspace, 'add .');
        const statusOutput = gitExec(worktreeWorkspace, 'status --short');
        if (statusOutput && !statusOutput.includes('nothing to commit')) {
            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-chore: final cleanup for ${branchName}"`);
        }
        gitPush(worktreeWorkspace, branchName, gitContext);

        // ── 1a. Post-development quality gate verification (fixes A6) ──
        // Run multi-language quality gates (install/build/lint/test) to detect
        // failures early. If gates fail and effective prTestRepairAttempts > 0, give
        // the dev agent a repair attempt before opening the PR.
        let gateReport: GateReport | null = null;
        try {
            gateReport = runQualityGates(worktreeWorkspace, {
                timeoutMs: PR_TEST_TIMEOUT_MS,
                installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
            });
            if (gateReport && gateReport.results.length > 0) {
                if (gateReport.passed) {
                    log.info(`Quality gates passed on branch ${branchName}`);
                    allTranscript.push(msg('conductor', `Quality gates passed on branch ${branchName}`));
                } else {
                    const failingSteps = gateReport.results
                        .filter(r => !r.passed && !r.skipped)
                        .map(r => `${r.step}: ${r.output.slice(0, 200)}`);
                    log.warn(`Quality gates FAILED on branch ${branchName} — giving dev agent a repair attempt`);
                    allTranscript.push(msg('conductor', `WARNING: Quality gates failed on branch ${branchName}:\n${failingSteps.join('\n').slice(0, 500)}`));

                    // Automated repair: re-invoke the primary dev agent with failing step output
                    const effectiveRepairAttempts = getEffectiveLimits().prTestRepairAttempts;
                    if (effectiveRepairAttempts > 0) {
                        for (let repair = 0; repair < effectiveRepairAttempts; repair++) {
                            try {
                                const primaryDevId = assignments[0].devAgentId;
                                const primaryEntry = getDevAgent(primaryDevId);
                                if (!primaryEntry) break;

                                const repairConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                                const repairAgent = buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, repairConventions);

                                // Feed only the failing steps to the repair agent
                                const failDetails = gateReport.results
                                    .filter(r => !r.passed && !r.skipped)
                                    .map(r => `### ${r.step} (\`${r.command}\`)\n\`\`\`\n${r.output.slice(-1000)}\n\`\`\``)
                                    .join('\n\n');

                                const repairMsg = [
                                    contextPrompt,
                                    `\n## Project Slug: ${projectSlug}`,
                                    `\n## Your Branch: ${branchName}`,
                                    `\nYou are already on this branch. Do NOT switch branches.`,
                                    `\n## IMPORTANT: Workspace Context`,
                                    `Your current working directory IS the project root.`,
                                    `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                                    `\n## Failing Quality Gate Steps\n\n${failDetails}`,
                                    `\n## Instructions`,
                                    `Fix the failing tests. Do not disable or delete tests to make them pass. Do not weaken lint rules or skip build steps. Commit and push.`,
                                ].join('\n');

                                log.info(`Quality gate repair attempt ${repair + 1}/${effectiveRepairAttempts}`);
                                const repairModel = getModelForRank(primaryEntry.rank as DevRank);
                                const { output: repairOutput, tokenUsage: repairTokenUsage } = await invokeDevAgent(
                                    repairAgent, repairMsg, `repair-${primaryEntry.id}-${branchName}`, primaryEntry.id, repairModel,
                                );
                                if (repairTokenUsage) allTokenUsage.push(repairTokenUsage);
                                if (repairOutput.fileChanges) allFileChanges.push(...repairOutput.fileChanges);

                                // Commit and push repair changes
                                gitExec(worktreeWorkspace, 'add .');
                                const repairStatus = gitExec(worktreeWorkspace, 'status --short');
                                if (repairStatus && !repairStatus.includes('nothing to commit')) {
                                    gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-fix: repair failing quality gates"`);
                                }
                                gitPush(worktreeWorkspace, branchName, gitContext);

                                // Re-run quality gates
                                gateReport = runQualityGates(worktreeWorkspace, {
                                    timeoutMs: PR_TEST_TIMEOUT_MS,
                                    installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
                                });
                                if (gateReport?.passed) {
                                    log.info(`Quality gates passed after repair attempt ${repair + 1}`);
                                    allTranscript.push(msg('conductor', `Quality gates passed after repair attempt ${repair + 1}`));
                                    break;
                                }
                            } catch (repairErr: any) {
                                log.warn(`Quality gate repair attempt failed (non-fatal): ${repairErr.message}`);
                            }
                        }
                    }
                }
            }
        } catch (testErr: any) {
            log.warn(`Post-dev quality gate error: ${testErr.message}`);
        }

        // ── 1b. Check for actual commits before creating PR ─────────────
        // If no commits exist between base and this branch, skip PR creation
        // to avoid the "No commits between" GitHub API error.
        const diffCheck = gitExec(worktreeWorkspace, `log ${baseRef}..HEAD --oneline`);
        if (!diffCheck || diffCheck.startsWith('Error:') || diffCheck.trim() === '') {
            log.warn(`No commits on branch ${branchName} relative to ${baseBranch} — skipping PR creation`);
            allTranscript.push(msg('conductor', `Skipped PR for ${branchName}: no commits (dev agent produced no changes)`));

            const pullRequest: PullRequest = {
                id: `PR-SKIPPED-${branchName}`,
                prNumber: 0,
                prUrl: '',
                title: `[SKIPPED] No changes on ${branchName}`,
                description: 'Dev agent did not produce any commits.',
                branchName,
                authorAgentId: assignments[0].devAgentId,
                reviewerAgentIds,
                reviews: [],
                status: 'closed',
                assignmentIds: assignments.map(a => a.id),
                taskType,
                currentState,
            };
            return {
                pullRequest,
                fileChanges: allFileChanges,
                artifacts: allArtifacts,
                transcript: allTranscript,
                tokenUsage: allTokenUsage,
            };
        }

        // ── 2. Create GitHub PR ─────────────────────────────────────────
        const prTitle = buildPRTitle(assignments, taskType, projectSlug);
        let prBody = buildPRDescription(assignments, allFileChanges, taskType, currentState, assignments[0].devAgentId);
        // Append quality gate results to the PR description
        if (gateReport && gateReport.results.length > 0) {
            prBody += `\n\n## Quality Gates\n\n${gateReportToMarkdown(gateReport)}`;
        }

        // ── 1c. Secret scan before PR (when SECURITY_GATE_IN_PR=true) ────
        let secretsBlockMerge = false;
        if (SECURITY_GATE_IN_PR) {
            try {
                const secretFindings = scanForSecrets(worktreeWorkspace);
                if (secretFindings.length > 0) {
                    const criticalCount = secretFindings.filter(f => f.severity === 'critical').length;
                    log.warn(`Secret scan: ${secretFindings.length} finding(s), ${criticalCount} critical`);
                    prBody += `\n\n## Security Scan\n\n${securityReportToMarkdown({ findings: secretFindings, passed: criticalCount === 0 })}`;
                    // A critical secret finding blocks the merge
                    if (criticalCount > 0) {
                        secretsBlockMerge = true;
                        log.error(`Critical secrets detected — merge will be blocked`);
                        allTranscript.push(msg('security-gates', `PR ${branchName}: BLOCKED — ${criticalCount} critical secret(s) detected`));
                    }
                }
            } catch (secErr: any) {
                log.warn(`PR secret scan error (non-fatal): ${secErr.message}`);
            }
        }

        log.info(`Creating PR: "${prTitle}"`);
        const octokit = getOctokit(gitContext);
        let ghPr: { number: number; html_url: string; node_id: string };
        try {
            const { data } = await octokit.pulls.create({
                owner: ghOwner,
                repo: ghRepo,
                title: prTitle,
                body: prBody,
                head: branchName,
                base: baseBranch,
            });
            ghPr = { number: data.number, html_url: data.html_url, node_id: data.node_id };
        } catch (octokitErr: any) {
            if (GITHUB_MODE === 'local') {
                // In local mode, Octokit is a local stand-in — if it fails, do not fall back to curl
                throw octokitErr;
            }
            log.warn(`Octokit PR creation failed (${octokitErr.status ?? 'unknown'}), falling back to curl`);
            ghPr = createPRViaCurl(prTitle, prBody, branchName, baseBranch, gitContext);
        }
        log.info(`PR #${ghPr.number} created: ${ghPr.html_url}`);
        emitRunEvent('pr:opened', { prNumber: ghPr.number, title: prTitle, branch: branchName, baseBranch });
        allTranscript.push(msg('conductor', `PR #${ghPr.number} created: ${prTitle}`));

        // Post simulated review-request comment
        try {
            const authorEntry = getDevAgent(assignments[0].devAgentId);
            const reviewerNames = reviewerAgentIds
                .map(id => getDevAgent(id))
                .filter(Boolean)
                .map(e => `${e!.name} (${e!.id})`);
            const requestBody = `[REVIEW_REQUEST] ${authorEntry?.name ?? assignments[0].devAgentId} requested review from ${reviewerNames.join(' and ')}.`;
            await octokit.issues.createComment({
                owner: ghOwner, repo: ghRepo,
                issue_number: ghPr.number, body: requestBody,
            });
        } catch (reqErr: any) {
            log.warn(`Failed to post review-request comment: ${reqErr.message}`);
        }

        // ── 3. Review loop ──────────────────────────────────────────────
        const allReviews: PRReview[] = [];
        const seenCommentKeys = new Set<string>();
        let prStatus: 'open' | 'approved' | 'merged' | 'closed' | 'escalated_open' = 'open';

        /** SHA of the last commit that reviewers actually reviewed. */
        let lastReviewedSha = '';
        /** Consecutive iterations where the fix attempt produced no new commit. */
        let noProgressCount = 0;
        /** Rate-limit retries of the fix step (bounded; replaces the old `iteration--`). */
        let fixRateLimitRetries = 0;
        const MAX_FIX_RATE_LIMIT_RETRIES = 2;

        /** Max chars for inline diff before switching to stat-based fallback. */
        const MAX_DIFF_CHARS = 25_000;

        /** Generated-file exclusion pathspecs for git diff (mirrors git-tools.ts). */
        const DIFF_EXCLUDE_SPECS = [
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
            'composer.lock', 'Gemfile.lock', 'Pipfile.lock', 'poetry.lock',
            'go.sum', 'Cargo.lock',
            '*.min.js', '*.min.css', '*.map', '*.snap',
            'dist/*', 'build/*', '.next/*',
        ].map(p => `':!${p}'`).join(' ');

        for (let iteration = 1; iteration <= getEffectiveLimits().maxReviewIterations; iteration++) {
            const effectiveReviewLimit = getEffectiveLimits().maxReviewIterations;
            log.info(`Review iteration ${iteration}/${effectiveReviewLimit}`);

            // ── No-progress detection (Change 1) ────────────────────────
            // NOTE: the decision must be taken BEFORE `lastReviewedSha` is
            // updated, otherwise every iteration > 1 looks like no-progress and
            // reviewers are never re-invoked. `evaluateProgress` owns that order.
            const headSha = gitExec(worktreeWorkspace, 'rev-parse HEAD');
            const progress = evaluateProgress(iteration, headSha, lastReviewedSha, noProgressCount);
            lastReviewedSha = progress.lastReviewedSha;
            noProgressCount = progress.noProgressCount;
            const skipReviewPhase = progress.skipReview;
            if (skipReviewPhase) {
                log.warn(`No new commits since the last review (HEAD ${headSha.slice(0, 8)}) — skipping re-review (no-progress ${noProgressCount}/${MAX_NO_PROGRESS_ITERATIONS})`);
                if (progress.endLoop) {
                    log.warn(`${MAX_NO_PROGRESS_ITERATIONS} consecutive iterations with no progress — ending review loop.`);
                    break;
                }
                // Skip the review but still attempt a fix below
            }

            // Get the diff for reviewers (excluding generated files)
            const prDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);

            // ── Skip reviewers on empty diff (Change 4) ─────────────────
            if (!prDiff || prDiff.trim() === '' || prDiff.startsWith('Error:')) {
                log.warn('Empty or unavailable diff — skipping review iteration.');
                prStatus = 'approved';
                break;
            }

            // ── Review phase (skipped when no progress) ──────────────────
            const reviewResults: { reviewerId: string; output: ReviewOutput }[] = [];

            if (!skipReviewPhase) {
                // Truncate reviewer list to the budget-effective limit
                const { maxReviewers } = getEffectiveLimits();
                const activeReviewerIds = reviewerAgentIds.slice(0, Math.max(maxReviewers, 0));
                // Determine which reviewers need to (re-)review
                const pendingReviewers = iteration === 1
                    ? activeReviewerIds
                    : activeReviewerIds.filter(rid => {
                        const lastReview = allReviews
                            .filter(r => r.reviewerId === rid)
                            .sort((a, b) => b.iteration - a.iteration)[0];
                        return !lastReview || lastReview.status === 'changes_requested';
                    });

                if (pendingReviewers.length === 0) {
                    log.info('All reviewers have approved');
                    prStatus = 'approved';
                    break;
                }

                // ── Sequential per-reviewer passes: review → fix → next reviewer ──
                // Each reviewer sees the code after the previous reviewer's
                // comments have been addressed, avoiding duplicate observations
                // and saving tokens.
                for (const reviewerId of pendingReviewers) {
                    const reviewerEntry = getDevAgent(reviewerId);
                    if (!reviewerEntry) {
                        log.warn(`Unknown reviewer: ${reviewerId}, skipping`);
                        continue;
                    }

                    const reviewerLog = getLogger(`${reviewerEntry.tag} [REVIEW]`, reviewerEntry.colorCode);
                    reviewerLog.info(`Reviewing PR #${ghPr.number} (iteration ${iteration})`);

                    const reviewerConventions = resolveConventionFiles(reviewerEntry.languages, techStack);
                    const reviewerAgent = buildReviewerAgent(apiKey, reviewerEntry, worktreeWorkspace, gitContext, baseBranch, reviewerConventions);

                    // Refresh diff for each reviewer so they see code after prior fixes
                    const freshDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);

                    // B6: Context-aware diff truncation with stat fallback
                    let truncatedDiff: string;
                    if (freshDiff.length <= MAX_DIFF_CHARS) {
                        truncatedDiff = freshDiff;
                    } else {
                        // Diff too large — provide stat summary and instruct to use per-file tools
                        const diffStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                        truncatedDiff = [
                            `[DIFF TOO LARGE — ${freshDiff.length} chars. Showing file summary instead]\n`,
                            diffStat,
                            `\nUse the "git_diff_file" tool with a specific file path to review individual files.`,
                            `Use the "git_diff_stat" tool to see the full list of changed files.`,
                        ].join('\n');
                    }

                    // B6: Summarize previous reviews instead of full JSON
                    const prevReviewSummary = iteration > 1
                        ? allReviews.filter(r => r.reviewerId === reviewerId)
                            .map(r => `Iteration ${r.iteration}: ${r.status} (${r.comments.length} comments)`)
                            .join('\n')
                        : '';

                    // B3: Collect prior reviewer comments from this iteration to avoid duplicates
                    const priorIterComments = reviewResults
                        .flatMap(r => (r.output.comments ?? []).map((c: any) => ({
                            reviewer: r.reviewerId,
                            file: c.filePath,
                            line: c.line,
                            body: c.body,
                            severity: c.severity,
                        })));
                    const priorCommentsSection = priorIterComments.length > 0
                        ? `\n## Other Reviewer Comments This Iteration\nThe following comments have already been posted by other reviewers in this iteration. Do NOT repeat these. Only add NEW, UNIQUE observations.\n\n${JSON.stringify(priorIterComments, null, 2)}`
                        : '';

                    const reviewMsg = [
                        `## Pull Request #${ghPr.number}: ${prTitle}`,
                        `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                        `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                        `\n## Diff\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
                        `\n## Review Iteration: ${iteration}`,
                        prevReviewSummary ? `\n## Previous Review Summary\n\n${prevReviewSummary}` : '',
                        priorCommentsSection,
                    ].join('\n');

                    try {
                        const reviewerModel = getModelForRank(reviewerEntry.rank as DevRank);
                        const { output: reviewOutput, tokenUsage: revTokenUsage } = await invokeReviewerAgent(
                            reviewerAgent, reviewMsg, `${reviewerId}-pr${ghPr.number}-iter${iteration}`,
                            `${reviewerId}-reviewer`, reviewerModel,
                        );
                        if (revTokenUsage) allTokenUsage.push(revTokenUsage);
                        // B10: Fallback for undefined status
                        if (!reviewOutput.status) {
                            reviewerLog.warn('Reviewer returned undefined status — treating as approved');
                            reviewOutput.status = 'approved';
                        }

                        // ── Only blocking severities block (Change 3) ───────
                        if (reviewOutput.status === 'changes_requested' && !isBlockingReview(reviewOutput.comments ?? [])) {
                            reviewerLog.info('Only non-blocking comments (minor/suggestion) — recording as approved-with-comments.');
                            reviewOutput.status = 'approved';
                        }

                        reviewResults.push({ reviewerId, output: reviewOutput });
                        reviewerLog.info(`Decision: ${reviewOutput.status} (${reviewOutput.comments?.length ?? 0} comments)`);
                        emitRunEvent('pr:reviewed', { prNumber: ghPr.number, reviewerId, status: reviewOutput.status, comments: reviewOutput.comments?.length ?? 0 });

                        // B2: Log individual review comments to the run log
                        for (const c of reviewOutput.comments ?? []) {
                            reviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                        }

                        // Post simulated review as an issue comment (avoids "Can not request changes on your own pull request")
                        const ghComments = (reviewOutput.comments ?? [])
                            .filter((c: any) => c.filePath && c.body)
                            .map((c: any) => ({
                                path: c.filePath,
                                line: c.line ?? 1,
                                body: `**[${c.severity?.toUpperCase() ?? 'INFO'}]** ${c.body}`,
                            }));

                        const statusTag = reviewOutput.status === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
                        const commentParts = [
                            `[REVIEW: ${statusTag} by ${reviewerEntry.name} (${reviewerEntry.id})] — iteration ${iteration}`,
                            '',
                            `**Summary:** ${reviewOutput.summary}`,
                        ];
                        if (ghComments.length > 0) {
                            commentParts.push('', '### Comments', '');
                            for (const c of ghComments) {
                                commentParts.push(`- **\`${c.path}\`${c.line ? `:${c.line}` : ''}** — ${c.body}`);
                            }
                        }

                        try {
                            await octokit.issues.createComment({
                                owner: ghOwner, repo: ghRepo,
                                issue_number: ghPr.number, body: commentParts.join('\n'),
                            });
                        } catch (commentErr: any) {
                            log.warn(`Failed to post review comment to GitHub: ${commentErr.message}`);
                        }

                        // Record review
                        allReviews.push({
                            reviewerId,
                            status: reviewOutput.status === 'approved' ? 'approved' : 'changes_requested',
                            comments: (reviewOutput.comments ?? []).map((c: any, idx: number) => ({
                                id: `${reviewerId}-iter${iteration}-${idx}`,
                                reviewerId,
                                filePath: c.filePath ?? '',
                                line: c.line,
                                body: c.body ?? '',
                                severity: c.severity ?? 'info',
                                resolved: false,
                            })),
                            iteration,
                        });

                        allTranscript.push(msg(reviewerId, `Review: ${reviewOutput.status} — ${reviewOutput.summary?.slice(0, 100)}`));

                        // ── Sequential fix: address this reviewer's comments
                        //    before the next reviewer sees the code ────────────
                        if (reviewOutput.status === 'changes_requested' && iteration < effectiveReviewLimit) {
                            const thisReviewerComments = (reviewOutput.comments ?? [])
                                .map((c: any) => ({
                                    reviewer: reviewerId,
                                    file: c.filePath,
                                    line: c.line,
                                    comment: c.body,
                                    severity: c.severity,
                                }))
                                .filter((c: any) => {
                                    const key = `${(c.file ?? '').toLowerCase()}::${(c.comment ?? '').slice(0, 100).toLowerCase()}`;
                                    if (seenCommentKeys.has(key)) return false;
                                    seenCommentKeys.add(key);
                                    return true;
                                });

                            if (thisReviewerComments.length > 0) {
                                const primaryDevId = assignments[0].devAgentId;
                                const primaryEntry = getDevAgent(primaryDevId);
                                if (primaryEntry) {
                                    const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
                                    devLog.info(`Fixing ${thisReviewerComments.length} review comments from ${reviewerId}...`);

                                    const fixConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                                    const fixAgent = buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, fixConventions);
                                    const fixMsg = [
                                        contextPrompt,
                                        `\n## Project Slug: ${projectSlug}`,
                                        `\n## Your Branch: ${branchName}`,
                                        `\nYou are already on this branch. Do NOT switch branches. Fix the review comments below.`,
                                        `\n## IMPORTANT: Workspace Context`,
                                        `Your current working directory IS the project root.`,
                                        `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                                        `\n## Review Comments to Fix\n\n${JSON.stringify(thisReviewerComments, null, 2)}`,
                                        `\n## Instructions`,
                                        `Address ALL review comments. For each comment:`,
                                        `1. Read the file and understand the issue.`,
                                        `2. Make the fix.`,
                                        `3. Commit with a message like "fix: address review comment — <description>".`,
                                        `4. Push when done.`,
                                    ].join('\n');

                                    try {
                                        const fixModel = getModelForRank(primaryEntry.rank as DevRank);
                                        const { output: fixOutput, tokenUsage: fixTokenUsage } = await invokeDevAgent(
                                            fixAgent, fixMsg, `fix-${primaryEntry.id}-${reviewerId}-iter${iteration}`,
                                            primaryEntry.id, fixModel,
                                        );
                                        if (fixTokenUsage) allTokenUsage.push(fixTokenUsage);
                                        if (fixOutput.fileChanges) allFileChanges.push(...fixOutput.fileChanges);
                                        devLog.info(`Fix complete: ${fixOutput.fileChanges?.length ?? 0} changes (from ${reviewerId})`);
                                        allTranscript.push(msg(primaryDevId, `Fixed ${fixOutput.fileChanges?.length ?? 0} files from ${reviewerId}'s review`));

                                        // Ensure pushed
                                        gitExec(worktreeWorkspace, 'add .');
                                        const fixStatus = gitExec(worktreeWorkspace, 'status --short');
                                        if (fixStatus && !fixStatus.includes('nothing to commit')) {
                                            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-fix: address ${reviewerId} review (iteration ${iteration})"`);
                                        }
                                        gitPush(worktreeWorkspace, branchName, gitContext);
                                    } catch (fixErr: any) {
                                        log.error(`Fix attempt for ${reviewerId}'s comments failed: ${fixErr.message}`);
                                        allTranscript.push(msg(primaryDevId, `Fix failed for ${reviewerId}: ${fixErr.message}`));
                                        // Rate-limit handling
                                        if (fixErr.message?.includes('429') || fixErr.message?.includes('rate limit') || fixErr.message?.includes('Rate limit') || fixErr.message?.includes('Request limit')) {
                                            if (fixRateLimitRetries < MAX_FIX_RATE_LIMIT_RETRIES) {
                                                fixRateLimitRetries++;
                                                log.warn(`Rate-limited fix (retry ${fixRateLimitRetries}/${MAX_FIX_RATE_LIMIT_RETRIES}) — waiting`);
                                                await new Promise(r => setTimeout(r, 30_000));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        log.error(`Reviewer ${reviewerId} failed: ${err.message}`);
                        allTranscript.push(msg(reviewerId, `Review failed: ${err.message}`));
                    }
                }

                // Check if all reviewers approved
                const allApproved = reviewerAgentIds.every(rid => {
                    const latest = allReviews
                        .filter(r => r.reviewerId === rid)
                        .sort((a, b) => b.iteration - a.iteration)[0];
                    return latest?.status === 'approved';
                });

                if (allApproved) {
                    log.info('All reviewers approved!');
                    prStatus = 'approved';
                    break;
                }
            } // end if (!skipReviewPhase)

            // ── Fix requested changes (skipReviewPhase fallback) ─────────
            // When skipReviewPhase is true, re-use the comments from the most
            // recent iteration that actually produced reviews — the previous
            // iteration may itself have been a skipped one.
            // In normal flow, fixes already happen per-reviewer above; this block
            // only runs for no-progress retries.
            if (skipReviewPhase) {
                const lastReviewedIteration = allReviews.reduce((m, r) => Math.max(m, r.iteration), 0);
                const changesRequested = allReviews
                    .filter(r => r.iteration === lastReviewedIteration && r.status === 'changes_requested')
                    .map(r => ({ reviewerId: r.reviewerId, output: { status: 'changes_requested' as const, summary: '', comments: r.comments } }));
                if (changesRequested.length > 0 && iteration < effectiveReviewLimit) {
                    log.info(`${changesRequested.length} reviewer(s) requested changes (no-progress retry). Re-invoking dev agent(s)...`);

                    // On a no-progress retry the comments are deliberately the same
                    // ones the failed fix attempt was given, so dedup is skipped.
                    const requestedComments = changesRequested.flatMap(r =>
                        (r.output.comments ?? []).map((c: any) => ({
                            reviewer: r.reviewerId,
                            file: c.filePath,
                            line: c.line,
                            comment: c.body,
                            severity: c.severity,
                        }))
                    );

                    if (requestedComments.length > 0) {
                        const primaryDevId = assignments[0].devAgentId;
                        const primaryEntry = getDevAgent(primaryDevId);
                        if (primaryEntry) {
                            const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
                            devLog.info(`Fixing ${requestedComments.length} review comments (no-progress retry)...`);

                            const fixConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                            const fixAgent = buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, fixConventions);
                            const fixMsg = [
                                contextPrompt,
                                `\n## Project Slug: ${projectSlug}`,
                                `\n## Your Branch: ${branchName}`,
                                `\nYou are already on this branch. Do NOT switch branches. Fix the review comments below.`,
                                `\n## IMPORTANT: Workspace Context`,
                                `Your current working directory IS the project root.`,
                                `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                                `\n## Review Comments to Fix\n\n${JSON.stringify(requestedComments, null, 2)}`,
                                `\n## Instructions`,
                                `Address ALL review comments. For each comment:`,
                                `1. Read the file and understand the issue.`,
                                `2. Make the fix.`,
                                `3. Commit with a message like "fix: address review comment — <description>".`,
                                `4. Push when done.`,
                            ].join('\n');

                            try {
                                const fixModel = getModelForRank(primaryEntry.rank as DevRank);
                                const { output: fixOutput, tokenUsage: fixTokenUsage } = await invokeDevAgent(fixAgent, fixMsg, `fix-${primaryEntry.id}-iter${iteration}`, primaryEntry.id, fixModel);
                                if (fixTokenUsage) allTokenUsage.push(fixTokenUsage);
                                if (fixOutput.fileChanges) allFileChanges.push(...fixOutput.fileChanges);
                                devLog.info(`Fix complete: ${fixOutput.fileChanges?.length ?? 0} changes`);
                                allTranscript.push(msg(primaryDevId, `Fixed ${fixOutput.fileChanges?.length ?? 0} files based on review comments`));

                                // Ensure pushed
                                gitExec(worktreeWorkspace, 'add .');
                                const fixStatus = gitExec(worktreeWorkspace, 'status --short');
                                if (fixStatus && !fixStatus.includes('nothing to commit')) {
                                    gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-fix: address review comments (iteration ${iteration})"`);
                                }
                                gitPush(worktreeWorkspace, branchName, gitContext);
                            } catch (err: any) {
                                log.error(`Fix attempt failed: ${err.message}`);
                                if (err.message?.includes('429') || err.message?.includes('rate limit') || err.message?.includes('Rate limit') || err.message?.includes('Request limit')) {
                                    if (fixRateLimitRetries < MAX_FIX_RATE_LIMIT_RETRIES) {
                                        fixRateLimitRetries++;
                                        log.warn(`Rate-limited fix (retry ${fixRateLimitRetries}/${MAX_FIX_RATE_LIMIT_RETRIES}) — waiting before the next iteration`);
                                        await new Promise(r => setTimeout(r, 30_000));
                                    } else {
                                        log.warn('Fix step exhausted its rate-limit retries — ending review loop.');
                                        break;
                                    }
                                }
                                if (err.message?.includes('recursion limit') || err.message?.includes('Recursion limit')) {
                                    log.warn(`Recursion limit hit in fix attempt — will retry with fresh agent next iteration`);
                                    allTranscript.push(msg(primaryDevId, `Fix hit recursion limit (iteration ${iteration}), will retry`));
                                }
                                if (err.message?.includes('Already borrowed')) {
                                    log.warn(`Non-retriable error in fix attempt — skipping remaining fix iterations`);
                                    allTranscript.push(msg(primaryDevId, `Fix skipped (non-retriable): ${err.message}`));
                                    break;
                                }
                                allTranscript.push(msg(primaryDevId, `Fix failed: ${err.message}`));
                            }
                        }
                    }
                }
            }
        }

        // ── 3b. Escalation check ────────────────────────────────────────
        if (prStatus === 'open') {
            // Use the last iteration that actually produced reviews — the loop can
            // now end early (no-progress / rate-limit exhaustion), in which case
            // there are no reviews at the effective limit to escalate on.
            const finalIteration = allReviews.reduce((m, r) => Math.max(m, r.iteration), 0);
            const lastReviews = allReviews.filter(r => r.iteration === finalIteration);
            const hasCritical = lastReviews.some(r =>
                r.comments.some((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
            );

            if (hasCritical) {
                const reviewLimit = getEffectiveLimits().maxReviewIterations;
                log.warn(`PR #${ghPr.number} has unresolved CRITICALs after ${reviewLimit} iterations. Escalating developer...`);
                allTranscript.push(msg('conductor', `Escalating: unresolved CRITICALs after max iterations`));

                // Find escalated dev (higher rank than original dev)
                const originalDevId = assignments[0].devAgentId;
                const escalatedDevId = findEscalationAgent(
                    originalDevId,
                    [...reviewerAgentIds, originalDevId],
                );

                if (escalatedDevId) {
                    const escalatedDevEntry = getDevAgent(escalatedDevId)!;
                    log.info(`Escalated dev: ${escalatedDevEntry.name} (${escalatedDevId})`);

                    // Escalated dev fixes CRITICALs + reviews overall quality
                    const escalatedConventions = resolveConventionFiles(escalatedDevEntry.languages, techStack);
                    const escalatedDev = buildDevAgent(apiKey, escalatedDevEntry, worktreeWorkspace, gitContext, baseBranch, escalatedConventions);
                    const criticalComments = lastReviews.flatMap(r =>
                        r.comments.filter((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
                    );
                    const escalationMsg = [
                        contextPrompt,
                        `\n## Project Slug: ${projectSlug}`,
                        `\n## Your Branch: ${branchName}`,
                        `\n## IMPORTANT: Workspace Context`,
                        `Your current working directory IS the project root.`,
                        `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                        `\n## Escalation: You are a SENIOR developer taking over from a lower-rank developer.`,
                        `\n## Unresolved CRITICAL Comments\n\n${JSON.stringify(criticalComments, null, 2)}`,
                        `\n## Instructions`,
                        `1. Fix ALL CRITICAL review comments listed above.`,
                        `2. Review the ENTIRE codebase on this branch for quality issues.`,
                        `3. Fix any additional issues you find.`,
                        `4. Commit all changes when done.`,
                    ].join('\n');

                    try {
                        const escModel = getModelForRank(escalatedDevEntry.rank as DevRank);
                        const { output: fixOutput, tokenUsage: escTokenUsage } = await invokeDevAgent(escalatedDev, escalationMsg, `escalation-${escalatedDevId}`, escalatedDevId, escModel);
                        if (escTokenUsage) allTokenUsage.push(escTokenUsage);
                        if (fixOutput.fileChanges) allFileChanges.push(...fixOutput.fileChanges);
                        gitExec(worktreeWorkspace, 'add .');
                        const st = gitExec(worktreeWorkspace, 'status --short');
                        if (st && !st.includes('nothing to commit')) {
                            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-fix: escalated dev fixes"`);
                        }
                        gitPush(worktreeWorkspace, branchName, gitContext);
                        log.info(`Escalated dev ${escalatedDevId} completed fixes`);
                        allTranscript.push(msg(escalatedDevId, `Escalated dev fixes applied`));

                        // Find escalated reviewer (higher rank, not the originals)
                        const escalatedReviewerId = findEscalationAgent(
                            escalatedDevId,
                            [...reviewerAgentIds, escalatedDevId, originalDevId],
                        );

                        if (escalatedReviewerId) {
                            const escalatedReviewerEntry = getDevAgent(escalatedReviewerId)!;
                            const escalatedReviewerLog = getLogger(`${escalatedReviewerEntry.tag} [ESCALATED REVIEW]`, escalatedReviewerEntry.colorCode);
                            escalatedReviewerLog.info(`Escalated review of PR #${ghPr.number}`);

                            const escalatedReviewerConventions = resolveConventionFiles(escalatedReviewerEntry.languages, techStack);
                            const escalatedReviewer = buildReviewerAgent(apiKey, escalatedReviewerEntry, worktreeWorkspace, gitContext, baseBranch, escalatedReviewerConventions);
                            const escalatedDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                            let escalatedDiffContent: string;
                            if (escalatedDiff.length <= MAX_DIFF_CHARS) {
                                escalatedDiffContent = `\`\`\`diff\n${escalatedDiff}\n\`\`\``;
                            } else {
                                const escalatedStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                                escalatedDiffContent = [
                                    `[DIFF TOO LARGE — ${escalatedDiff.length} chars. Showing file summary instead]\n`,
                                    escalatedStat,
                                    `\nUse "git_diff_file" to review individual files.`,
                                ].join('\n');
                            }
                            const escalatedReviewMsg = [
                                `## Escalated Review — Pull Request #${ghPr.number}: ${prTitle}`,
                                `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                                `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                                `\n## Diff\n\n${escalatedDiffContent}`,
                                `\n## Context: This is an escalated review after ${reviewLimit} iterations. A higher-rank dev has already applied fixes.`,
                            ].join('\n');

                            try {
                                const escRevModel = getModelForRank(escalatedReviewerEntry.rank as DevRank);
                                const { output: escalatedReviewOutput, tokenUsage: escRevTokenUsage } = await invokeReviewerAgent(
                                    escalatedReviewer, escalatedReviewMsg, `escalated-${escalatedReviewerId}-pr${ghPr.number}`,
                                    `${escalatedReviewerId}-reviewer`, escRevModel,
                                );
                                if (escRevTokenUsage) allTokenUsage.push(escRevTokenUsage);

                                if (!escalatedReviewOutput.status) {
                                    escalatedReviewOutput.status = 'approved';
                                }

                                escalatedReviewerLog.info(`Escalated decision: ${escalatedReviewOutput.status} (${escalatedReviewOutput.comments?.length ?? 0} comments)`);
                                for (const c of escalatedReviewOutput.comments ?? []) {
                                    escalatedReviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                                }

                                allReviews.push({
                                    reviewerId: escalatedReviewerId,
                                    status: escalatedReviewOutput.status === 'approved' ? 'approved' : 'changes_requested',
                                    comments: (escalatedReviewOutput.comments ?? []).map((c: any, idx: number) => ({
                                        id: `${escalatedReviewerId}-escalated-${idx}`,
                                        reviewerId: escalatedReviewerId,
                                        filePath: c.filePath ?? '',
                                        line: c.line,
                                        body: c.body ?? '',
                                        severity: c.severity ?? 'info',
                                        resolved: false,
                                    })),
                                    iteration: reviewLimit + 1,
                                });

                                if (escalatedReviewOutput.status === 'approved') {
                                    log.info(`Escalated reviewer approved PR #${ghPr.number}`);
                                    prStatus = 'approved';
                                } else {
                                    log.warn(`Escalated reviewer also requested changes for PR #${ghPr.number} — leaving open for human intervention`);
                                    prStatus = 'open';
                                    allTranscript.push(msg('conductor', `Escalated reviewer rejected — PR left open for human intervention`));
                                }
                            } catch (escRevErr: any) {
                                log.error(`Escalated review failed: ${escRevErr.message}`);
                            }
                        } else {
                            log.warn('No escalated reviewer available — leaving PR open for human intervention');
                        }
                    } catch (escErr: any) {
                        log.error(`Escalated dev failed: ${escErr.message}`);
                        allTranscript.push(msg('conductor', `Escalation failed: ${escErr.message}`));
                    }
                } else {
                    log.warn('No escalation candidate found — proceeding with merge despite CRITICALs');
                }
            }
        }

        // ── 4. Merge PR ─────────────────────────────────────────────────
        if (prStatus === 'approved' || prStatus === 'open') {
            if (prStatus === 'open') {
                log.warn(`Max review iterations reached. Merging PR #${ghPr.number} despite pending reviews.`);
                allTranscript.push(msg('conductor', `WARNING: Max review iterations reached, merging anyway`));
            }

            // B4: Rebase onto latest base branch before merging to prevent conflicts
            gitExec(worktreeWorkspace, `fetch origin ${baseBranch}`);
            const rebaseResult = gitExec(worktreeWorkspace, `rebase origin/${baseBranch}`);
            if (rebaseResult.startsWith('Error:')) {
                log.warn(`Rebase failed for ${branchName}, attempting merge commit instead`);
                gitExec(worktreeWorkspace, 'rebase --abort');
                const mergeLocalResult = gitExec(worktreeWorkspace, `merge origin/${baseBranch} --no-edit`);
                if (mergeLocalResult.startsWith('Error:')) {
                    log.error(`Cannot resolve conflicts for ${branchName}: ${mergeLocalResult}`);
                    prStatus = 'open';
                    allTranscript.push(msg('conductor', `Merge blocked: unresolvable conflicts on ${branchName}`));
                } else {
                    gitPush(worktreeWorkspace, branchName, gitContext);
                }
            } else {
                gitPush(worktreeWorkspace, branchName, gitContext);
            }

            // Verify branch exists on remote before merging
            const lsRemote = gitExec(worktreeWorkspace, `ls-remote --heads origin ${branchName}`);
            if (!lsRemote || lsRemote.startsWith('Error:')) {
                log.error(`Branch ${branchName} not found on remote — skipping merge`);
                prStatus = 'open';
            }

            // Block merge when critical secrets were detected
            if (secretsBlockMerge) {
                log.error(`Merge blocked for PR #${ghPr.number}: critical secrets detected`);
                prStatus = 'open';
                allTranscript.push(msg('security-gates', `Merge blocked for PR #${ghPr.number}: critical secrets detected`));
                try {
                    await octokit.issues.createComment({
                        owner: ghOwner, repo: ghRepo,
                        issue_number: ghPr.number,
                        body: ':x: **Merge blocked by security gate** — critical secrets detected in this PR. Remove hard-coded credentials before merging.',
                    });
                } catch (commentErr: any) {
                    log.warn(`Failed to post security block comment: ${commentErr.message}`);
                }
            }

            if (!secretsBlockMerge && (prStatus === 'approved' || prStatus === 'open')) {
                try {
                    await octokit.pulls.merge({
                        owner: ghOwner,
                        repo: ghRepo,
                        pull_number: ghPr.number,
                        merge_method: 'squash',
                    });
                    prStatus = 'merged';
                    log.info(`PR #${ghPr.number} merged to ${baseBranch}`);
                    emitRunEvent('pr:merged', { prNumber: ghPr.number, branch: branchName, baseBranch });
                    allTranscript.push(msg('conductor', `PR #${ghPr.number} merged to ${baseBranch}`));

                    // Delete the remote feature branch
                    try {
                        await octokit.git.deleteRef({
                            owner: ghOwner,
                            repo: ghRepo,
                            ref: `heads/${branchName}`,
                        });
                        log.info(`Deleted remote branch: ${branchName}`);
                    } catch (delErr: any) {
                        log.warn(`Failed to delete remote branch ${branchName}: ${delErr.message}`);
                    }
                } catch (err: any) {
                    log.error(`Merge failed: ${err.message}`);
                    allTranscript.push(msg('conductor', `Merge failed: ${err.message}`));
                    prStatus = 'open';
                }
            }
        }

        // ── 5. Build result ─────────────────────────────────────────────
        const pullRequest: PullRequest = {
            id: `PR-${ghPr.number}`,
            prNumber: ghPr.number,
            prUrl: ghPr.html_url,
            title: prTitle,
            description: prBody,
            branchName,
            authorAgentId: assignments[0].devAgentId,
            reviewerAgentIds,
            reviews: allReviews,
            status: prStatus,
            assignmentIds: assignments.map(a => a.id),
            taskType,
            currentState,
        };

        return {
            pullRequest,
            fileChanges: allFileChanges,
            artifacts: allArtifacts,
            transcript: allTranscript,
            tokenUsage: allTokenUsage,
        };
    } finally {
        // ── Cleanup worktree and local branch ───────────────────────────
        // (gitExec swallows errors internally, so this won't throw)
        if (fs.existsSync(worktreeDir)) {
            gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
            log.info(`Cleaned up worktree: ${worktreeSlug}`);
        }
        // Prune any dangling worktree tracking entries (fixes A11 leak-proofing)
        gitExec(gitRoot, 'worktree prune');
        gitExec(gitRoot, `branch -D ${branchName}`);
    }
}
