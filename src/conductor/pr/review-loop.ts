/**
 * Review loop — sequential reviewer passes with interleaved fix attempts.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { getLogger } from '../../utils/logger';
import { gitExec } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import { buildDevAgent } from '../../agents/developers/dev-agent.builder';
import { buildReviewerAgent } from '../../agents/developers/reviewer-agent.builder';
import { getDevAgent } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import { getEffectiveLimits } from '../../utils/run-budget';
import {
    isBlockingReview, evaluateProgress, MAX_NO_PROGRESS_ITERATIONS,
    type ReviewOutcome, evaluateQuorum, enforceCriteriaVerdicts,
} from '../review-policy';
import { REVIEW_QUORUM } from '../../config';
import { invokeDevAgent, invokeReviewerAgent, getModelForRank } from './agent-invoke';
import { commitWorktree } from './commit';
import { getReviewDiff, DIFF_EXCLUDE_SPECS, MAX_DIFF_CHARS } from './diff';
import { buildFixMessage } from './dev-prompts';
import type {
    Assignment, FileChange, TranscriptMessage,
    PhaseName, PRReview, GitContext, TechDecision,
} from '../../agents/_shared/base-schemas';
import type { ReviewOutput } from '../../agents/developers/schemas/review-output.schema';
import type { TokenCallRecord } from '../../utils/token-tracker';
import type { DevRank } from '../../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

function ts(): string { return new Date().toISOString(); }
function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase: 'development' as PhaseName, message };
}

export interface ReviewLoopInput {
    worktreeWorkspace: string;
    baseRef: string;
    branchName: string;
    baseBranch: string;
    projectSlug: string;
    primaryStoryId: string;
    assignments: Assignment[];
    reviewerAgentIds: string[];
    contextPrompt: string;
    apiKey: string;
    gitContext?: GitContext | null;
    techStack?: TechDecision[];
    isMaintainMode?: boolean;
    prNumber: number;
    prTitle: string;
    prBody: string;
    respawnCtx: { worktreeDir: string; baseRef: string };
    checkBranchBudget: (checkpoint: string) => string | null;
    reconcileClaims: (who: string, claimed?: FileChange[]) => FileChange[];
}

export interface ReviewLoopResult {
    prStatus: 'open' | 'approved';
    allReviews: PRReview[];
    allOutcomes: ReviewOutcome[];
    allFileChanges: FileChange[];
    allPhantomFileChanges: FileChange[];
    allTranscript: TranscriptMessage[];
    allTokenUsage: TokenCallRecord[];
}

/**
 * Run the review loop: sequential reviewer passes with interleaved fixes.
 */
export async function runReviewLoop(input: ReviewLoopInput): Promise<ReviewLoopResult> {
    const {
        worktreeWorkspace, baseRef, branchName, baseBranch,
        projectSlug, primaryStoryId, assignments, reviewerAgentIds,
        contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
        prNumber, prTitle, prBody, respawnCtx,
        checkBranchBudget, reconcileClaims,
    } = input;

    const ghOwner = gitContext?.owner ?? '';
    const ghRepo = gitContext?.repo ?? '';

    const allReviews: PRReview[] = [];
    const allOutcomes: ReviewOutcome[] = [];
    const allFileChanges: FileChange[] = [];
    const allPhantomFileChanges: FileChange[] = [];
    const allTranscript: TranscriptMessage[] = [];
    const allTokenUsage: TokenCallRecord[] = [];
    const seenCommentKeys = new Set<string>();
    let prStatus: 'open' | 'approved' = 'open';

    /** SHA of the last commit that reviewers actually reviewed. */
    let lastReviewedSha = '';
    /** Consecutive iterations where the fix attempt produced no new commit. */
    let noProgressCount = 0;
    /** Rate-limit retries of the fix step (bounded; replaces the old `iteration--`). */
    let fixRateLimitRetries = 0;
    const MAX_FIX_RATE_LIMIT_RETRIES = 2;

    for (let iteration = 1; iteration <= getEffectiveLimits().maxReviewIterations; iteration++) {
        // Plan 24 D2: check branch budget before each review iteration
        // Plan 26, A3: guarantee at least ONE review iteration runs regardless of budget
        const reviewBudgetReason = checkBranchBudget(`before review iteration ${iteration}`);
        if (reviewBudgetReason) {
            if (iteration > 1) {
                log.warn(`Branch ${branchName} budget exceeded: ${reviewBudgetReason} — ending review loop`);
                allTranscript.push(msg('conductor', `Branch budget exceeded during review: ${reviewBudgetReason}`));
                emitRunEvent('branch:budget-exceeded', { branchName, reason: reviewBudgetReason, checkpoint: `review iteration ${iteration}` });
                break;
            }
            log.warn(`Branch ${branchName} budget exceeded: ${reviewBudgetReason} — proceeding with mandatory first review`);
            allTranscript.push(msg('conductor', `Budget exceeded but proceeding with mandatory first review iteration`));
        }

        const effectiveReviewLimit = getEffectiveLimits().maxReviewIterations;
        log.info(`Review iteration ${iteration}/${effectiveReviewLimit}`);

        // ── No-progress detection (Change 1) ────────────────────────────
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
        }

        // Get the diff for reviewers (excluding generated files)
        const prDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);

        // ── Skip reviewers on empty diff (Change 4) ─────────────────────
        if (!prDiff || prDiff.trim() === '' || prDiff.startsWith('Error:')) {
            log.warn('Empty or unavailable diff — no production code produced.');
            allOutcomes.push({
                kind: 'changes_requested',
                reviewerId: 'automated-verification',
                output: {
                    status: 'changes_requested',
                    summary: 'No changes were produced for this assignment',
                    comments: [{ filePath: '.', body: 'No changes were produced for this assignment', severity: 'critical' }],
                    criteriaVerdicts: [],
                },
            });
            break;
        }

        // ── Review phase (skipped when no progress) ─────────────────────
        const reviewResults: { reviewerId: string; output: ReviewOutput }[] = [];

        if (!skipReviewPhase) {
            const { maxReviewers } = getEffectiveLimits();
            const activeReviewerIds = reviewerAgentIds.slice(0, Math.max(maxReviewers, 0));
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

            // Sequential per-reviewer passes
            for (const reviewerId of pendingReviewers) {
                const reviewerEntry = getDevAgent(reviewerId);
                if (!reviewerEntry) {
                    log.warn(`Unknown reviewer: ${reviewerId}, skipping`);
                    continue;
                }

                const reviewerLog = getLogger(`${reviewerEntry.tag} [REVIEW]`, reviewerEntry.colorCode);
                reviewerLog.info(`Reviewing PR #${prNumber} (iteration ${iteration})`);

                const reviewerConventions = resolveConventionFiles(reviewerEntry.languages, techStack);
                const reviewerAgent = buildReviewerAgent(apiKey, reviewerEntry, worktreeWorkspace, gitContext, baseBranch, reviewerConventions);

                // Refresh diff for each reviewer so they see code after prior fixes
                const freshDiff = getReviewDiff(worktreeWorkspace, baseRef, branchName);

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

                // Wrap diff in fenced block only if not already truncated
                const diffBlock = freshDiff.startsWith('[DIFF TOO LARGE')
                    ? freshDiff
                    : `\`\`\`diff\n${freshDiff}\n\`\`\``;

                const reviewMsg = [
                    `## Pull Request #${prNumber}: ${prTitle}`,
                    `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                    `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                    `\n## Diff\n\n${diffBlock}`,
                    `\n## Review Iteration: ${iteration}`,
                    prevReviewSummary ? `\n## Previous Review Summary\n\n${prevReviewSummary}` : '',
                    priorCommentsSection,
                ].join('\n');

                try {
                    const reviewerModel = getModelForRank(reviewerEntry.rank as DevRank);
                    const { outcome: rawOutcome, tokenUsage: revTokenUsage } = await invokeReviewerAgent(
                        reviewerAgent, reviewMsg, `${reviewerId}-pr${prNumber}-iter${iteration}`,
                        `${reviewerId}-reviewer`, reviewerModel,
                    );
                    if (revTokenUsage) allTokenUsage.push(revTokenUsage);

                    // Sub-Plan 07 §5.3: enforce criteriaVerdicts consistency
                    const assignmentHasCriteria = assignments.some(a =>
                        (a.acIndexes ?? []).length > 0 || (a.additionalStoryIds ?? []).length > 0,
                    );
                    const outcome = enforceCriteriaVerdicts(rawOutcome, assignmentHasCriteria);
                    allOutcomes.push(outcome);

                    const reviewOutput: ReviewOutput = outcome.kind === 'abstained'
                        ? { status: 'changes_requested', summary: `Abstained: ${outcome.detail}`, comments: [], criteriaVerdicts: [] }
                        : outcome.output;

                    // Only blocking severities block (Change 3)
                    if (outcome.kind === 'changes_requested' && !isBlockingReview(reviewOutput.comments ?? [])) {
                        reviewerLog.info('Only non-blocking comments (minor/suggestion) — recording as approved-with-comments.');
                        allOutcomes[allOutcomes.length - 1] = { kind: 'approved', reviewerId, output: { ...reviewOutput, status: 'approved' } };
                    }

                    reviewResults.push({ reviewerId, output: reviewOutput });
                    const effectiveStatus = allOutcomes[allOutcomes.length - 1].kind;
                    reviewerLog.info(`Decision: ${effectiveStatus} (${reviewOutput.comments?.length ?? 0} comments)`);
                    emitRunEvent('pr:reviewed', { prNumber, reviewerId, status: effectiveStatus, comments: reviewOutput.comments?.length ?? 0 });

                    // B2: Log individual review comments to the run log
                    for (const c of reviewOutput.comments ?? []) {
                        reviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
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

                    // Sequential fix: address this reviewer's comments
                    const lastOutcome = allOutcomes[allOutcomes.length - 1];
                    if (lastOutcome.kind === 'changes_requested' && iteration < effectiveReviewLimit) {
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
                            await runFixAttempt(thisReviewerComments, `fix for ${reviewerId}`, {
                                assignments, contextPrompt, projectSlug, branchName,
                                primaryStoryId, apiKey, gitContext, techStack, isMaintainMode,
                                worktreeWorkspace, respawnCtx, iteration, reviewerId,
                                allTokenUsage, allFileChanges, allTranscript,
                                reconcileClaims, fixRateLimitRetries,
                                updateFixRetries: (n) => { fixRateLimitRetries = n; },
                            });
                        }
                    }
                } catch (err: any) {
                    log.error(`Reviewer ${reviewerId} failed: ${err.message}`);
                    allTranscript.push(msg(reviewerId, `Review failed: ${err.message}`));
                }
            }

            // Check if quorum met
            const iterationOutcomes = allOutcomes.filter(o => {
                const rid = o.reviewerId;
                return allOutcomes.filter(oo => oo.reviewerId === rid).pop() === o;
            });
            const quorumResult = evaluateQuorum(iterationOutcomes, REVIEW_QUORUM);
            if (quorumResult.met) {
                log.info(`All reviewers approved (quorum ${quorumResult.approvals}/${REVIEW_QUORUM} met)!`);
                prStatus = 'approved';
                break;
            }

            if (quorumResult.allAbstained) {
                log.warn(`All ${quorumResult.abstentions} reviewer(s) abstained — will retry`);
            }
        } // end if (!skipReviewPhase)

        // ── Fix requested changes (skipReviewPhase fallback) ─────────────
        if (skipReviewPhase) {
            const effectiveReviewLimit = getEffectiveLimits().maxReviewIterations;
            const lastReviewedIteration = allReviews.reduce((m, r) => Math.max(m, r.iteration), 0);
            const changesRequested = allReviews
                .filter(r => r.iteration === lastReviewedIteration && r.status === 'changes_requested')
                .map(r => ({ reviewerId: r.reviewerId, output: { status: 'changes_requested' as const, summary: '', comments: r.comments } }));
            if (changesRequested.length > 0 && iteration < effectiveReviewLimit) {
                log.info(`${changesRequested.length} reviewer(s) requested changes (no-progress retry). Re-invoking dev agent(s)...`);

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
                    await runFixAttempt(requestedComments, 'no-progress fix', {
                        assignments, contextPrompt, projectSlug, branchName,
                        primaryStoryId, apiKey, gitContext, techStack, isMaintainMode,
                        worktreeWorkspace, respawnCtx, iteration, reviewerId: undefined,
                        allTokenUsage, allFileChanges, allTranscript,
                        reconcileClaims, fixRateLimitRetries,
                        updateFixRetries: (n) => { fixRateLimitRetries = n; },
                    });
                }
            }
        }
    }

    return {
        prStatus,
        allReviews,
        allOutcomes,
        allFileChanges,
        allPhantomFileChanges,
        allTranscript,
        allTokenUsage,
    };
}

// ─── Internal fix attempt helper ────────────────────────────────────────────

interface FixAttemptContext {
    assignments: Assignment[];
    contextPrompt: string;
    projectSlug: string;
    branchName: string;
    primaryStoryId: string;
    apiKey: string;
    gitContext?: GitContext | null;
    techStack?: TechDecision[];
    isMaintainMode?: boolean;
    worktreeWorkspace: string;
    respawnCtx: { worktreeDir: string; baseRef: string };
    iteration: number;
    reviewerId: string | undefined;
    allTokenUsage: TokenCallRecord[];
    allFileChanges: FileChange[];
    allTranscript: TranscriptMessage[];
    reconcileClaims: (who: string, claimed?: FileChange[]) => FileChange[];
    fixRateLimitRetries: number;
    updateFixRetries: (n: number) => void;
}

async function runFixAttempt(
    comments: any[],
    label: string,
    ctx: FixAttemptContext,
): Promise<void> {
    const MAX_FIX_RATE_LIMIT_RETRIES = 2;
    const primaryDevId = ctx.assignments[0].devAgentId;
    const primaryEntry = getDevAgent(primaryDevId);
    if (!primaryEntry) return;

    const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
    devLog.info(`Fixing ${comments.length} review comments (${label})...`);

    const fixConventions = resolveConventionFiles(primaryEntry.languages, ctx.techStack);
    const buildFixAgentFn = () => buildDevAgent(ctx.apiKey, primaryEntry, ctx.worktreeWorkspace, ctx.gitContext, ctx.branchName, fixConventions, ctx.isMaintainMode);
    const fixAgent = buildFixAgentFn();
    const fixMsg = buildFixMessage(ctx.contextPrompt, ctx.projectSlug, ctx.branchName, JSON.stringify(comments, null, 2));

    try {
        const fixModel = getModelForRank(primaryEntry.rank as DevRank);
        const threadSuffix = ctx.reviewerId
            ? `fix-${primaryEntry.id}-${ctx.reviewerId}-iter${ctx.iteration}`
            : `fix-${primaryEntry.id}-iter${ctx.iteration}`;
        const { output: fixOutput, tokenUsage: fixTokenUsage } = await invokeDevAgent(
            fixAgent, fixMsg, threadSuffix,
            primaryEntry.id, fixModel,
            buildFixAgentFn, ctx.respawnCtx,
        );
        if (fixTokenUsage) ctx.allTokenUsage.push(fixTokenUsage);
        const fixChanges = ctx.reconcileClaims(`${primaryDevId} (${label})`, fixOutput.fileChanges);
        ctx.allFileChanges.push(...fixChanges);
        devLog.info(`Fix complete: ${fixChanges.length} verified change(s) (${label})`);
        ctx.allTranscript.push(msg(primaryDevId, `Fixed ${fixChanges.length} files (${label})`));
    } catch (err: any) {
        log.error(`Fix attempt (${label}) failed: ${err.message}`);
        ctx.allTranscript.push(msg(primaryDevId, `Fix failed (${label}): ${err.message}`));
        // Rate-limit handling
        if (err.message?.includes('429') || err.message?.includes('rate limit') || err.message?.includes('Rate limit') || err.message?.includes('Request limit')) {
            if (ctx.fixRateLimitRetries < MAX_FIX_RATE_LIMIT_RETRIES) {
                ctx.updateFixRetries(ctx.fixRateLimitRetries + 1);
                log.warn(`Rate-limited fix (retry ${ctx.fixRateLimitRetries + 1}/${MAX_FIX_RATE_LIMIT_RETRIES}) — waiting`);
                await new Promise(r => setTimeout(r, 30_000));
            }
        }
        if (err.message?.includes('recursion limit') || err.message?.includes('Recursion limit')) {
            log.warn(`Recursion limit hit in fix attempt — will retry with fresh agent next iteration`);
            ctx.allTranscript.push(msg(primaryDevId, `Fix hit recursion limit (iteration ${ctx.iteration}), will retry`));
        }
        if (err.message?.includes('Already borrowed')) {
            log.warn(`Non-retriable error in fix attempt — skipping remaining fix iterations`);
            ctx.allTranscript.push(msg(primaryDevId, `Fix skipped (non-retriable): ${err.message}`));
        }
    } finally {
        commitWorktree(ctx.worktreeWorkspace, ctx.branchName, ctx.projectSlug, ctx.primaryStoryId, 'fix',
            `address review comments (${label}, iteration ${ctx.iteration})`, ctx.gitContext);
    }
}
