/**
 * PR Workflow Orchestrator
 *
 * Manages the full lifecycle of a pull request:
 *   branch creation → dev work → PR creation → review loop → merge
 *
 * Called by the dispatcher for each branch group of assignments.
 */
import { execSync } from 'child_process';
import { Octokit } from '@octokit/rest';
import { getLogger } from '../utils/logger';
import { writeArtifact } from '../agents/_shared/artifact';
import { buildDevAgent } from '../agents/developers/dev-agent.builder';
import { buildReviewerAgent } from '../agents/developers/reviewer-agent.builder';
import { getDevAgent } from '../agents/developers/registry';
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    MAX_REVIEW_ITERATIONS,
} from '../config';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage,
    PhaseName, PullRequest, PRReview,
} from '../agents/_shared/base-schemas';
import type { DeveloperOutput } from '../agents/developers/schemas/dev-output.schema';
import type { ReviewOutput } from '../agents/developers/schemas/review-output.schema';

const log = getLogger('[PR-Workflow]', 135);

// ─── Rate-limit retry helper ─────────────────────────────────────────────────

const RETRY_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 10_000;

async function retryWithBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            const is429 = err?.status === 429
                || err?.message?.includes('429')
                || err?.message?.includes('Rate limit')
                || err?.message?.includes('Request limit');
            if (is429 && attempt < RETRY_ATTEMPTS) {
                const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
                log.warn(`${label}: rate-limited (attempt ${attempt}/${RETRY_ATTEMPTS}), retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw new Error(`${label}: unreachable`);
}

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
        }).trim();
    } catch (err: any) {
        return `Error: ${err.stderr?.toString() ?? err.message}`.trim();
    }
}

function getOctokit(): Octokit {
    return new Octokit({ auth: GITHUB_TOKEN });
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

// ─── PR title & description builders ─────────────────────────────────────────

function buildPRTitle(assignments: Assignment[], taskType: string): string {
    const prefix = taskType === 'bug' ? 'fix' : taskType === 'refactor' ? 'refactor' : 'feat';
    if (assignments.length === 1) {
        const desc = assignments[0].description.split('.')[0].trim();
        return `${prefix}: ${desc}`;
    }
    // Multiple assignments — summarize
    const storyIds = [...new Set(assignments.map(a => a.storyId))];
    const firstDesc = assignments[0].description.split('.')[0].trim();
    return `${prefix}: ${firstDesc} (${storyIds.join(', ')})`;
}

function buildPRDescription(
    assignments: Assignment[],
    fileChanges: FileChange[],
    taskType: string,
    currentState?: string,
): string {
    const sections: string[] = [];

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
            { configurable: { thread_id: `dev-pr-${threadSuffix}-${Date.now()}` }, recursionLimit: 75 },
        );
        const last = result.messages[result.messages.length - 1];
        return typeof last.content === 'string' ? JSON.parse(last.content) : last.content;
    }, `dev-${threadSuffix}`);
}

async function invokeReviewerAgent(
    agent: any, userMessage: string, threadSuffix: string,
): Promise<ReviewOutput> {
    return retryWithBackoff(async () => {
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `review-${threadSuffix}-${Date.now()}` }, recursionLimit: 75 },
        );
        const last = result.messages[result.messages.length - 1];
        return typeof last.content === 'string' ? JSON.parse(last.content) : last.content;
    }, `review-${threadSuffix}`);
}

// ─── Main PR workflow ────────────────────────────────────────────────────────

export async function executePRWorkflow(input: PRWorkflowInput): Promise<PRWorkflowResult> {
    const {
        branchName, baseBranch, assignments, reviewerAgentIds, taskType,
        workspacePath, apiKey, contextPrompt, currentState,
    } = input;

    const allFileChanges: FileChange[] = [];
    const allArtifacts: ArtifactRef[] = [];
    const allTranscript: TranscriptMessage[] = [];

    // ── 1. Create feature branch from system branch ─────────────────────
    log.info(`Creating branch: ${branchName} (from ${baseBranch})`);
    gitExec(workspacePath, `checkout ${baseBranch}`);
    gitExec(workspacePath, `pull origin ${baseBranch} --ff-only`);
    const branchResult = gitExec(workspacePath, `checkout -b ${branchName}`);
    log.info(`Branch result: ${branchResult}`);
    allTranscript.push(msg('conductor', `Created branch: ${branchName} from ${baseBranch}`));

    // ── 2. Run dev agent(s) on assignments ───────────────────────────────
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

        const agent = buildDevAgent(apiKey, entry, workspacePath);

        const assignmentText = devAssignments.map(a =>
            `Assignment ${a.id} [${a.priority}/${a.complexity}]: ${a.description}`
        ).join('\n\n');

        const message = [
            contextPrompt,
            `\n## Your Branch: ${branchName}`,
            `\nSwitch to this branch using git_checkout_branch or git_switch_branch before making changes.`,
            `\n## Your Assignments\n\n${assignmentText}`,
        ].join('\n');

        try {
            const output = await invokeDevAgent(agent, message, `${entry.id}-${branchName}`);
            if (output.fileChanges) allFileChanges.push(...output.fileChanges);

            const artifact = writeArtifact({
                agentId: entry.id,
                colorCode: entry.colorCode,
                workspacePath,
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
    gitExec(workspacePath, 'add .');
    const statusOutput = gitExec(workspacePath, 'status --short');
    if (statusOutput && !statusOutput.includes('nothing to commit')) {
        gitExec(workspacePath, `commit -m "chore: final cleanup for ${branchName}"`);
    }
    gitExec(workspacePath, `push -u origin ${branchName}`);

    // ── 3. Create GitHub PR ──────────────────────────────────────────────
    const prTitle = buildPRTitle(assignments, taskType);
    const prBody = buildPRDescription(assignments, allFileChanges, taskType, currentState);

    log.info(`Creating PR: "${prTitle}"`);
    const octokit = getOctokit();
    const { data: ghPr } = await octokit.pulls.create({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        title: prTitle,
        body: prBody,
        head: branchName,
        base: baseBranch,
    });
    log.info(`PR #${ghPr.number} created: ${ghPr.html_url}`);
    allTranscript.push(msg('conductor', `PR #${ghPr.number} created: ${prTitle}`));

    // ── 4. Review loop ───────────────────────────────────────────────────
    const allReviews: PRReview[] = [];
    let prStatus: 'open' | 'approved' | 'merged' | 'closed' = 'open';

    for (let iteration = 1; iteration <= MAX_REVIEW_ITERATIONS; iteration++) {
        log.info(`Review iteration ${iteration}/${MAX_REVIEW_ITERATIONS}`);

        // Get the diff for reviewers
        const prDiff = gitExec(workspacePath, `diff ${baseBranch}...${branchName}`);

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

            const reviewerAgent = buildReviewerAgent(apiKey, reviewerEntry, workspacePath);

            const reviewMsg = [
                `## Pull Request #${ghPr.number}: ${prTitle}`,
                `\n## PR Description\n\n${prBody}`,
                `\n## Diff\n\n\`\`\`diff\n${prDiff.slice(0, 50000)}\n\`\`\``,
                `\n## Review Iteration: ${iteration}`,
                iteration > 1 ? `\n## Previous Reviews\n\n${JSON.stringify(allReviews.filter(r => r.reviewerId === reviewerId), null, 2)}` : '',
            ].join('\n');

            try {
                const reviewOutput = await invokeReviewerAgent(
                    reviewerAgent, reviewMsg, `${reviewerId}-pr${ghPr.number}-iter${iteration}`
                );
                reviewResults.push({ reviewerId, output: reviewOutput });
                reviewerLog.info(`Decision: ${reviewOutput.status} (${reviewOutput.comments?.length ?? 0} comments)`);

                // Post review to GitHub
                const ghEvent = reviewOutput.status === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
                const ghComments = (reviewOutput.comments ?? [])
                    .filter((c: any) => c.filePath && c.body)
                    .map((c: any) => ({
                        path: c.filePath,
                        line: c.line ?? 1,
                        body: `**[${c.severity?.toUpperCase() ?? 'INFO'}]** ${c.body}`,
                    }));

                try {
                    const reviewParams: any = {
                        owner: GITHUB_OWNER,
                        repo: GITHUB_REPO,
                        pull_number: ghPr.number,
                        body: `**${reviewerEntry.name}** (${reviewerEntry.tag}): ${reviewOutput.summary}`,
                        event: ghEvent,
                    };

                    if (ghComments.length > 0) {
                        const { data: prData } = await octokit.pulls.get({
                            owner: GITHUB_OWNER, repo: GITHUB_REPO, pull_number: ghPr.number,
                        });
                        reviewParams.commit_id = prData.head.sha;
                        reviewParams.comments = ghComments;
                    }

                    await octokit.pulls.createReview(reviewParams);
                } catch (ghErr: any) {
                    log.warn(`Failed to post review to GitHub: ${ghErr.message}`);
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

        // ── Fix requested changes ────────────────────────────────────────
        const changesRequested = reviewResults.filter(r => r.output.status === 'changes_requested');
        if (changesRequested.length > 0 && iteration < MAX_REVIEW_ITERATIONS) {
            log.info(`${changesRequested.length} reviewer(s) requested changes. Re-invoking dev agent(s)...`);

            // Collect all review comments
            const allComments = changesRequested.flatMap(r =>
                (r.output.comments ?? []).map((c: any) => ({
                    reviewer: r.reviewerId,
                    file: c.filePath,
                    line: c.line,
                    comment: c.body,
                    severity: c.severity,
                }))
            );

            // Re-invoke the primary dev agent with the review comments
            const primaryDevId = assignments[0].devAgentId;
            const primaryEntry = getDevAgent(primaryDevId);
            if (primaryEntry) {
                const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
                devLog.info(`Fixing ${allComments.length} review comments...`);

                // Make sure we're on the right branch
                gitExec(workspacePath, `checkout ${branchName}`);

                const fixAgent = buildDevAgent(apiKey, primaryEntry, workspacePath);
                const fixMsg = [
                    contextPrompt,
                    `\n## Your Branch: ${branchName}`,
                    `\nYou are already on this branch. Fix the review comments below.`,
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
                    gitExec(workspacePath, 'add .');
                    const fixStatus = gitExec(workspacePath, 'status --short');
                    if (fixStatus && !fixStatus.includes('nothing to commit')) {
                        gitExec(workspacePath, `commit -m "fix: address review comments (iteration ${iteration})"`);
                    }
                    gitExec(workspacePath, `push origin ${branchName}`);
                } catch (err: any) {
                    log.error(`Fix attempt failed: ${err.message}`);
                    allTranscript.push(msg(primaryDevId, `Fix failed: ${err.message}`));
                }
            }
        }
    }

    // ── 5. Merge PR ──────────────────────────────────────────────────────
    if (prStatus === 'approved' || prStatus === 'open') {
        if (prStatus === 'open') {
            log.warn(`Max review iterations reached. Merging PR #${ghPr.number} despite pending reviews.`);
            allTranscript.push(msg('conductor', `WARNING: Max review iterations reached, merging anyway`));
        }

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

            // Switch back to system branch and pull
            gitExec(workspacePath, `checkout ${baseBranch}`);
            gitExec(workspacePath, `pull origin ${baseBranch}`);

            // Delete the dev feature branch (local + remote)
            gitExec(workspacePath, `branch -D ${branchName}`);
            try {
                await octokit.git.deleteRef({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    ref: `heads/${branchName}`,
                });
                log.info(`Deleted branch: ${branchName}`);
            } catch (delErr: any) {
                log.warn(`Failed to delete remote branch ${branchName}: ${delErr.message}`);
            }
        } catch (err: any) {
            log.error(`Merge failed: ${err.message}`);
            allTranscript.push(msg('conductor', `Merge failed: ${err.message}`));
            prStatus = 'open';
        }
    }

    // ── 6. Build result ──────────────────────────────────────────────────
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
}
