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
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    MAX_REVIEW_ITERATIONS, AGENT_RECURSION_LIMIT,
    GIT_USER_NAME, GIT_USER_EMAIL,
} from '../config';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage,
    PhaseName, PullRequest, PRReview,
} from '../agents/_shared/base-schemas';
import type { DeveloperOutput } from '../agents/developers/schemas/dev-output.schema';
import type { ReviewOutput } from '../agents/developers/schemas/review-output.schema';

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
}

export interface PRWorkflowResult {
    pullRequest: PullRequest;
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts(): string { return new Date().toISOString(); }

function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase: 'development' as PhaseName, message };
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

function gitPush(workspacePath: string, branchName: string): string {
    const authUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
    const result = gitExec(workspacePath, `push ${authUrl} HEAD:refs/heads/${branchName}`);
    if (result.startsWith('Error:')) {
        log.error(`Push failed for ${branchName}: ${result}`);
    } else {
        log.info(`Pushed branch ${branchName}`);
    }
    return result;
}

function getOctokit(): Octokit {
    if (!GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN is not set. Cannot perform GitHub API operations.');
    }
    return new Octokit({ auth: GITHUB_TOKEN });
}

/**
 * Create a GitHub PR using curl as a fallback when Octokit fails.
 * This avoids Node.js HTTP stack issues with corporate SSL proxies.
 */
function createPRViaCurl(title: string, body: string, head: string, base: string): { number: number; html_url: string; node_id: string } {
    const payload = JSON.stringify({ title, body, head, base });
    const result = execSync(
        `curl -s -X POST "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls" `
        + `-H "Authorization: token ${GITHUB_TOKEN}" `
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

function findGitRoot(startPath: string): string {
    let dir = path.resolve(startPath);
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`Not inside a git repository: ${startPath}`);
        dir = parent;
    }
}

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

async function invokeDevAgent(
    agent: any, userMessage: string, threadSuffix: string,
): Promise<DeveloperOutput> {
    return retryWithBackoff(async () => {
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `dev-pr-${threadSuffix}-${Date.now()}` }, recursionLimit: AGENT_RECURSION_LIMIT },
        );
        const last = result.messages[result.messages.length - 1];
        const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        try {
            return JSON.parse(raw);
        } catch {
            // Try extracting JSON from markdown code fence
            const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) return JSON.parse(match[1].trim());
            throw new Error(`Invalid JSON output from dev agent: ${raw.slice(0, 200)}`);
        }
    }, `dev-${threadSuffix}`);
}

async function invokeReviewerAgent(
    agent: any, userMessage: string, threadSuffix: string,
): Promise<ReviewOutput> {
    return retryWithBackoff(async () => {
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `review-${threadSuffix}-${Date.now()}` }, recursionLimit: AGENT_RECURSION_LIMIT },
        );
        const last = result.messages[result.messages.length - 1];
        const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        try {
            return JSON.parse(raw);
        } catch {
            const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) return JSON.parse(match[1].trim());
            throw new Error(`Invalid JSON output from reviewer agent: ${raw.slice(0, 200)}`);
        }
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

// ─── Main PR workflow ────────────────────────────────────────────────────────

export async function executePRWorkflow(input: PRWorkflowInput): Promise<PRWorkflowResult> {
    const {
        branchName, baseBranch, assignments, reviewerAgentIds, taskType,
        workspacePath, apiKey, contextPrompt, currentState, projectSlug,
    } = input;

    const primaryStoryId = assignments[0]?.storyId ?? 'CLEANUP';

    const allFileChanges: FileChange[] = [];
    const allArtifacts: ArtifactRef[] = [];
    const allTranscript: TranscriptMessage[] = [];

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

    // Clean up stale worktree from a previous failed run
    if (fs.existsSync(worktreeDir)) {
        gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
    }
    // Delete stale local branch if it exists (ignore errors)
    gitExec(gitRoot, `branch -D ${branchName}`);
    // Fetch latest base branch from remote (may fail if not pushed yet)
    gitExec(gitRoot, `fetch origin ${baseBranch}`);
    // Create worktree with a new branch — try remote ref first, fall back to local
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

    try {
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

            const agent = buildDevAgent(apiKey, entry, worktreeWorkspace);

            const assignmentText = devAssignments.map(a =>
                `Assignment ${a.id} [${a.priority}/${a.complexity}]: ${a.description}`
            ).join('\n\n');

            const message = [
                contextPrompt,
                `\n## Project Slug: ${projectSlug}`,
                `\n## Your Branch: ${branchName}`,
                `\nYou are already on this branch. Do NOT create or switch branches — your workspace is isolated for this branch.`,
                `\n## IMPORTANT: Workspace Context`,
                `Your current working directory IS the project root.`,
                `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                `\n## Your Assignments\n\n${assignmentText}`,
            ].join('\n');

            try {
                const output = await invokeDevAgent(agent, message, `${entry.id}-${branchName}`);
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
        gitPush(worktreeWorkspace, branchName);

        // ── 2. Create GitHub PR ─────────────────────────────────────────
        const prTitle = buildPRTitle(assignments, taskType, projectSlug);
        const prBody = buildPRDescription(assignments, allFileChanges, taskType, currentState, assignments[0].devAgentId);

        log.info(`Creating PR: "${prTitle}"`);
        const octokit = getOctokit();
        let ghPr: { number: number; html_url: string; node_id: string };
        try {
            const { data } = await octokit.pulls.create({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                title: prTitle,
                body: prBody,
                head: branchName,
                base: baseBranch,
            });
            ghPr = { number: data.number, html_url: data.html_url, node_id: data.node_id };
        } catch (octokitErr: any) {
            log.warn(`Octokit PR creation failed (${octokitErr.status ?? 'unknown'}), falling back to curl`);
            ghPr = createPRViaCurl(prTitle, prBody, branchName, baseBranch);
        }
        log.info(`PR #${ghPr.number} created: ${ghPr.html_url}`);
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
                owner: GITHUB_OWNER, repo: GITHUB_REPO,
                issue_number: ghPr.number, body: requestBody,
            });
        } catch (reqErr: any) {
            log.warn(`Failed to post review-request comment: ${reqErr.message}`);
        }

        // ── 3. Review loop ──────────────────────────────────────────────
        const allReviews: PRReview[] = [];
        const seenCommentKeys = new Set<string>();
        let prStatus: 'open' | 'approved' | 'merged' | 'closed' | 'escalated_open' = 'open';

        for (let iteration = 1; iteration <= MAX_REVIEW_ITERATIONS; iteration++) {
            log.info(`Review iteration ${iteration}/${MAX_REVIEW_ITERATIONS}`);

            // Get the diff for reviewers
            const prDiff = gitExec(worktreeWorkspace, `diff ${baseBranch}...${branchName}`);

            // Determine which reviewers need to (re-)review
            const pendingReviewers = iteration === 1
                ? reviewerAgentIds
                : reviewerAgentIds.filter(rid => {
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

            // Run each reviewer
            const reviewResults: { reviewerId: string; output: ReviewOutput }[] = [];

            for (const reviewerId of pendingReviewers) {
                const reviewerEntry = getDevAgent(reviewerId);
                if (!reviewerEntry) {
                    log.warn(`Unknown reviewer: ${reviewerId}, skipping`);
                    continue;
                }

                const reviewerLog = getLogger(`${reviewerEntry.tag} [REVIEW]`, reviewerEntry.colorCode);
                reviewerLog.info(`Reviewing PR #${ghPr.number} (iteration ${iteration})`);

                const reviewerAgent = buildReviewerAgent(apiKey, reviewerEntry, worktreeWorkspace);

                // B6: Context-aware diff truncation
                const MAX_DIFF_CHARS = 30_000;
                const truncatedDiff = prDiff.length > MAX_DIFF_CHARS
                    ? prDiff.slice(0, MAX_DIFF_CHARS) + '\n\n... [DIFF TRUNCATED — review the files directly using git tools] ...'
                    : prDiff;

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
                    `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                    `\n## Diff\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
                    `\n## Review Iteration: ${iteration}`,
                    prevReviewSummary ? `\n## Previous Review Summary\n\n${prevReviewSummary}` : '',
                    priorCommentsSection,
                ].join('\n');

                try {
                    const reviewOutput = await invokeReviewerAgent(
                        reviewerAgent, reviewMsg, `${reviewerId}-pr${ghPr.number}-iter${iteration}`
                    );
                    // B10: Fallback for undefined status
                    if (!reviewOutput.status) {
                        reviewerLog.warn('Reviewer returned undefined status — treating as approved');
                        reviewOutput.status = 'approved';
                    }

                    reviewResults.push({ reviewerId, output: reviewOutput });
                    reviewerLog.info(`Decision: ${reviewOutput.status} (${reviewOutput.comments?.length ?? 0} comments)`);

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
                            owner: GITHUB_OWNER, repo: GITHUB_REPO,
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

            // ── Fix requested changes ───────────────────────────────────
            const changesRequested = reviewResults.filter(r => r.output.status === 'changes_requested');
            if (changesRequested.length > 0 && iteration < MAX_REVIEW_ITERATIONS) {
                log.info(`${changesRequested.length} reviewer(s) requested changes. Re-invoking dev agent(s)...`);

                // Collect all review comments, deduplicating across iterations
                const allComments = changesRequested.flatMap(r =>
                    (r.output.comments ?? []).map((c: any) => ({
                        reviewer: r.reviewerId,
                        file: c.filePath,
                        line: c.line,
                        comment: c.body,
                        severity: c.severity,
                    }))
                ).filter(c => {
                    const key = `${(c.file ?? '').toLowerCase()}::${(c.comment ?? '').slice(0, 100).toLowerCase()}`;
                    if (seenCommentKeys.has(key)) return false;
                    seenCommentKeys.add(key);
                    return true;
                });

                // If all comments are duplicates of prior iterations, treat as approved
                if (allComments.length === 0) {
                    log.info('All review comments are duplicates of prior iterations — treating as approved');
                    prStatus = 'approved';
                    break;
                }

                // Re-invoke the primary dev agent with the review comments
                const primaryDevId = assignments[0].devAgentId;
                const primaryEntry = getDevAgent(primaryDevId);
                if (primaryEntry) {
                    const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
                    devLog.info(`Fixing ${allComments.length} review comments...`);

                    const fixAgent = buildDevAgent(apiKey, primaryEntry, worktreeWorkspace);
                    const fixMsg = [
                        contextPrompt,
                        `\n## Project Slug: ${projectSlug}`,
                        `\n## Your Branch: ${branchName}`,
                        `\nYou are already on this branch. Do NOT switch branches. Fix the review comments below.`,
                        `\n## IMPORTANT: Workspace Context`,
                        `Your current working directory IS the project root.`,
                        `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                        `\n## Review Comments to Fix\n\n${JSON.stringify(allComments, null, 2)}`,
                        `\n## Instructions`,
                        `Address ALL review comments. For each comment:`,
                        `1. Read the file and understand the issue.`,
                        `2. Make the fix.`,
                        `3. Commit with a message like "fix: address review comment — <description>".`,
                        `4. Push when done.`,
                    ].join('\n');

                    try {
                        const fixOutput = await invokeDevAgent(fixAgent, fixMsg, `fix-${primaryEntry.id}-iter${iteration}`);
                        if (fixOutput.fileChanges) allFileChanges.push(...fixOutput.fileChanges);
                        devLog.info(`Fix complete: ${fixOutput.fileChanges?.length ?? 0} changes`);
                        allTranscript.push(msg(primaryDevId, `Fixed ${fixOutput.fileChanges?.length ?? 0} files based on review comments`));

                        // Ensure pushed
                        gitExec(worktreeWorkspace, 'add .');
                        const fixStatus = gitExec(worktreeWorkspace, 'status --short');
                        if (fixStatus && !fixStatus.includes('nothing to commit')) {
                            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-fix: address review comments (iteration ${iteration})"`);
                        }
                        gitPush(worktreeWorkspace, branchName);
                    } catch (err: any) {
                        log.error(`Fix attempt failed: ${err.message}`);
                        // B5: Don't consume the iteration if rate-limited
                        if (err.message?.includes('429') || err.message?.includes('rate limit') || err.message?.includes('Rate limit') || err.message?.includes('Request limit')) {
                            log.warn('Rate-limited fix — will retry this iteration');
                            iteration--;
                            await new Promise(r => setTimeout(r, 30_000));
                        }
                        allTranscript.push(msg(primaryDevId, `Fix failed: ${err.message}`));
                    }
                }
            }
        }

        // ── 3b. Escalation check ────────────────────────────────────────
        if (prStatus === 'open') {
            const lastReviews = allReviews.filter(r => r.iteration === MAX_REVIEW_ITERATIONS);
            const hasCritical = lastReviews.some(r =>
                r.comments.some((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
            );

            if (hasCritical) {
                log.warn(`PR #${ghPr.number} has unresolved CRITICALs after ${MAX_REVIEW_ITERATIONS} iterations. Escalating developer...`);
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
                    const escalatedDev = buildDevAgent(apiKey, escalatedDevEntry, worktreeWorkspace);
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
                        const fixOutput = await invokeDevAgent(escalatedDev, escalationMsg, `escalation-${escalatedDevId}`);
                        if (fixOutput.fileChanges) allFileChanges.push(...fixOutput.fileChanges);
                        gitExec(worktreeWorkspace, 'add .');
                        const st = gitExec(worktreeWorkspace, 'status --short');
                        if (st && !st.includes('nothing to commit')) {
                            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-fix: escalated dev fixes"`);
                        }
                        gitPush(worktreeWorkspace, branchName);
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

                            const escalatedReviewer = buildReviewerAgent(apiKey, escalatedReviewerEntry, worktreeWorkspace);
                            const escalatedDiff = gitExec(worktreeWorkspace, `diff ${baseBranch}...${branchName}`);
                            const escalatedReviewMsg = [
                                `## Escalated Review — Pull Request #${ghPr.number}: ${prTitle}`,
                                `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                                `\n## Diff\n\n\`\`\`diff\n${escalatedDiff.slice(0, 30_000)}\n\`\`\``,
                                `\n## Context: This is an escalated review after ${MAX_REVIEW_ITERATIONS} iterations. A higher-rank dev has already applied fixes.`,
                            ].join('\n');

                            try {
                                const escalatedReviewOutput = await invokeReviewerAgent(
                                    escalatedReviewer, escalatedReviewMsg, `escalated-${escalatedReviewerId}-pr${ghPr.number}`
                                );

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
                                    iteration: MAX_REVIEW_ITERATIONS + 1,
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
                    gitPush(worktreeWorkspace, branchName);
                }
            } else {
                gitPush(worktreeWorkspace, branchName);
            }

            // Verify branch exists on remote before merging
            const lsRemote = gitExec(worktreeWorkspace, `ls-remote --heads origin ${branchName}`);
            if (!lsRemote || lsRemote.startsWith('Error:')) {
                log.error(`Branch ${branchName} not found on remote — skipping merge`);
                prStatus = 'open';
            }

            if (prStatus === 'approved' || prStatus === 'open') {
                try {
                    await octokit.pulls.merge({
                        owner: GITHUB_OWNER,
                        repo: GITHUB_REPO,
                        pull_number: ghPr.number,
                        merge_method: 'squash',
                    });
                    prStatus = 'merged';
                    log.info(`PR #${ghPr.number} merged to ${baseBranch}`);
                    allTranscript.push(msg('conductor', `PR #${ghPr.number} merged to ${baseBranch}`));

                    // Delete the remote feature branch
                    try {
                        await octokit.git.deleteRef({
                            owner: GITHUB_OWNER,
                            repo: GITHUB_REPO,
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
        };
    } finally {
        // ── Cleanup worktree and local branch ───────────────────────────
        // (gitExec swallows errors internally, so this won't throw)
        if (fs.existsSync(worktreeDir)) {
            gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
            log.info(`Cleaned up worktree: ${worktreeSlug}`);
        }
        gitExec(gitRoot, `branch -D ${branchName}`);
    }
}
