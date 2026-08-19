/**
 * Strong model fixer — comprehensive fix pass with a powerful model.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { getLogger } from '../../utils/logger';
import { gitExec } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import { buildStrongFixerAgent } from '../../agents/developers/dev-agent.builder';
import { buildReviewerAgent } from '../../agents/developers/reviewer-agent.builder';
import { getDevAgent } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import { getEffectiveLimits } from '../../utils/run-budget';
import { runQualityGates } from '../quality-gates';
import type { GateReport } from '../quality-gates';
import type { TamperFinding } from '../gate-integrity';
import { gateReportToMarkdown } from '../quality-gates';
import { tamperFindingsToMarkdown } from '../gate-integrity';
import { selectEscalationCandidate, type ReviewOutcome } from '../review-policy';
import {
    STRONG_FIXER_MODEL, STRONG_FIXER_ENABLED, STRONG_FIXER_MAX_TOOL_CALLS, STRONG_FIXER_MAX_INPUT_TOKENS,
    PRINCIPAL_DEV_MODEL, PR_EXHAUSTION_STRATEGY, REVIEW_QUORUM,
    PR_TEST_TIMEOUT_MS, PR_TEST_INSTALL_TIMEOUT_MS,
} from '../../config';
import { invokeDevAgent, invokeReviewerAgent, getModelForRank } from './agent-invoke';
import { commitWorktree } from './commit';
import { getReviewDiffContent, DIFF_EXCLUDE_SPECS } from './diff';
import { buildStrongFixerMessage } from './dev-prompts';
import type {
    Assignment, FileChange, TranscriptMessage,
    PhaseName, PRReview, GitContext, TechDecision,
} from '../../agents/_shared/base-schemas';
import type { ReviewOutput } from '../../agents/developers/schemas/review-output.schema';
import type { TokenCallRecord } from '../../utils/token-tracker';
import type { DevRank } from '../../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

/**
 * Plan 24 B2: branches that have already had a zero-write strong fixer pass.
 * One shot per branch — if the fixer produced nothing, re-running it is waste.
 */
const strongFixerZeroWriteBranches = new Set<string>();

function ts(): string { return new Date().toISOString(); }
function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase: 'development' as PhaseName, message };
}

export interface StrongFixerInput {
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
    gateReport: GateReport | null;
    integrityFindings: TamperFinding[];
    allReviews: PRReview[];
    allOutcomes: ReviewOutcome[];
    reconcileClaims: (who: string, claimed?: FileChange[]) => FileChange[];
}

export interface StrongFixerResult {
    prStatus: 'open' | 'approved';
    newReviews: PRReview[];
    newOutcomes: ReviewOutcome[];
    newFileChanges: FileChange[];
    newTranscript: TranscriptMessage[];
    newTokenUsage: TokenCallRecord[];
}

/**
 * Run the strong model fixer.
 */
export async function runStrongFixer(input: StrongFixerInput): Promise<StrongFixerResult> {
    const {
        worktreeWorkspace, baseRef, branchName, baseBranch,
        projectSlug, primaryStoryId, assignments, reviewerAgentIds,
        contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
        prNumber, prTitle, prBody, respawnCtx,
        gateReport, integrityFindings, allReviews, allOutcomes,
        reconcileClaims,
    } = input;

    const newReviews: PRReview[] = [];
    const newOutcomes: ReviewOutcome[] = [];
    const newFileChanges: FileChange[] = [];
    const newTranscript: TranscriptMessage[] = [];
    const newTokenUsage: TokenCallRecord[] = [];
    let prStatus: 'open' | 'approved' = 'open';

    if (!STRONG_FIXER_ENABLED || PR_EXHAUSTION_STRATEGY === 'escalate-only') {
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    // Budget check — do not run if budget is exhausted
    const { maxReviewIterations: budgetCheck } = getEffectiveLimits();
    if (budgetCheck <= 0) {
        log.warn('Strong fixer skipped: run budget exhausted');
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    if (strongFixerZeroWriteBranches.has(branchName)) {
        log.info(`Strong fixer: skipped (zero-write pass already attempted on ${branchName})`);
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    // Plan 24 B2: precondition check
    const hasReviewComments = allReviews.some(r => r.comments.length > 0);
    const hasRepairableGateFailure = gateReport && !gateReport.passed && gateReport.results?.some(
        (r: any) => !r.passed && !r.skipped && /typecheck|lint|test|build/i.test(r.step),
    );
    const productVerifyFailed = gateReport?.productVerify && !gateReport.productVerify.passed;
    const criticalLayoutOnly = integrityFindings.length > 0
        && integrityFindings.every(f => f.severity === 'critical');
    const quorumNotMet = allOutcomes.filter(o => o.kind === 'approved').length < REVIEW_QUORUM
        && !hasReviewComments;
    const onlyNonRepairable = !hasReviewComments && !hasRepairableGateFailure
        && (productVerifyFailed || criticalLayoutOnly || quorumNotMet);

    const fixerBlockerSummary = [
        ...(hasReviewComments ? ['review-comments'] : []),
        ...(hasRepairableGateFailure ? ['repairable-gate-failure'] : []),
        ...(productVerifyFailed ? ['product-verify-failed'] : []),
        ...(quorumNotMet ? ['quorum-not-met'] : []),
    ].join(', ') || 'none';

    if (onlyNonRepairable) {
        log.info(`Strong fixer: skipped (blockers not fixer-repairable: ${fixerBlockerSummary})`);
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    const fixerModel = STRONG_FIXER_MODEL || PRINCIPAL_DEV_MODEL;
    log.info(`Strong fixer: running (${STRONG_FIXER_MAX_TOOL_CALLS} turns, ${Math.round(STRONG_FIXER_MAX_INPUT_TOKENS / 1000)}k tokens, blockers: ${fixerBlockerSummary || 'review-comments-only'})`);
    newTranscript.push(msg('conductor', `Strong fixer invoked (model: ${fixerModel})`));
    emitRunEvent('pr:strong-fixer', { prNumber, model: fixerModel, branch: branchName });

    // Collect ALL review comments from all iterations
    const allComments = allReviews.flatMap(r => r.comments);

    // Get the current full diff
    const fullDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...HEAD -- . ${DIFF_EXCLUDE_SPECS}`);
    const maxDiffChars = 30_000;
    const truncatedFixerDiff = fullDiff.length <= maxDiffChars
        ? fullDiff
        : fullDiff.slice(0, maxDiffChars) + `\n\n[... TRUNCATED — ${fullDiff.length - maxDiffChars} chars omitted ...]`;

    // Build gate and integrity sections for the fixer message
    const gateMarkdown = gateReport ? `\n## Quality Gate Results\n${gateReportToMarkdown(gateReport)}` : '';
    const criticalFindings = integrityFindings.filter(f => f.severity === 'critical');
    const majorFindings = integrityFindings.filter(f => f.severity === 'major');
    const integrityMarkdown = [
        criticalFindings.length > 0 ? `\n## Integrity Findings\n${tamperFindingsToMarkdown(criticalFindings)}` : '',
        majorFindings.length > 0 ? `\n## Heuristic findings (informational)\n${tamperFindingsToMarkdown(majorFindings)}` : '',
    ].join('');

    // Build the strong fixer agent
    const fixerConventions = resolveConventionFiles(['typescript', 'javascript'], techStack);
    const buildFixerFn = () => buildStrongFixerAgent(apiKey, worktreeWorkspace, gitContext, baseBranch, fixerConventions, isMaintainMode);
    const fixerAgent = buildFixerFn();

    const fixerMsg = buildStrongFixerMessage(
        contextPrompt, projectSlug, branchName,
        prNumber, prTitle, prBody,
        JSON.stringify(allComments, null, 2),
        truncatedFixerDiff,
        gateMarkdown, integrityMarkdown,
    );

    try {
        const { output: fixerOutput, tokenUsage: fixerTokenUsage } = await invokeDevAgent(
            fixerAgent, fixerMsg, `strong-fixer-pr${prNumber}`,
            'strong-fixer', fixerModel,
            buildFixerFn, respawnCtx,
        );
        if (fixerTokenUsage) newTokenUsage.push(fixerTokenUsage);
        const fixerChanges = reconcileClaims('strong-fixer', fixerOutput.fileChanges);
        newFileChanges.push(...fixerChanges);
        log.info(`Strong fixer completed: ${fixerChanges.length} verified file change(s)`);
        newTranscript.push(msg('strong-fixer', `Strong fixer applied ${fixerChanges.length} file changes`));

        // Plan 24 B2: track zero-write passes so we don't retry
        if (fixerChanges.length === 0) {
            strongFixerZeroWriteBranches.add(branchName);
            log.info(`Strong fixer: zero writes on ${branchName} — branch marked for skip on retry`);
        }

        // Run quality gates after the fixer's changes
        let fixerGateReport: GateReport | null = null;
        try {
            fixerGateReport = await runQualityGates(worktreeWorkspace, {
                timeoutMs: PR_TEST_TIMEOUT_MS,
                installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
            });
            log.info(`Quality gates after strong fixer: ${fixerGateReport?.passed ? 'passed' : 'failed'}`);
        } catch (gateErr: any) {
            log.warn(`Quality gates after strong fixer failed: ${gateErr.message}`);
        }

        // Final review with a principal-rank reviewer
        const finalReviewerId = selectEscalationCandidate(
            assignments[0].devAgentId,
            [...reviewerAgentIds, assignments[0].devAgentId],
        );

        if (finalReviewerId) {
            const finalReviewerEntry = getDevAgent(finalReviewerId)!;
            const finalReviewerLog = getLogger(`${finalReviewerEntry.tag} [STRONG-FIXER REVIEW]`, finalReviewerEntry.colorCode);
            finalReviewerLog.info(`Final review of PR #${prNumber} after strong fixer`);

            const finalReviewerConventions = resolveConventionFiles(finalReviewerEntry.languages, techStack);
            const finalReviewer = buildReviewerAgent(apiKey, finalReviewerEntry, worktreeWorkspace, gitContext, baseBranch, finalReviewerConventions);
            const fixerDiffContent = getReviewDiffContent(worktreeWorkspace, baseRef, branchName);

            const finalReviewMsg = [
                `## Final Review — Pull Request #${prNumber}: ${prTitle}`,
                `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                `\n## Diff\n\n${fixerDiffContent}`,
                `\n## Context: This is a final review after a strong model fixer has addressed all review comments.`,
                fixerGateReport ? `\n## Quality Gate Results\n${gateReportToMarkdown(fixerGateReport)}` : '',
            ].join('\n');

            try {
                const finalRevModel = getModelForRank(finalReviewerEntry.rank as DevRank);
                const { outcome: finalOutcome, tokenUsage: finalRevTokenUsage } = await invokeReviewerAgent(
                    finalReviewer, finalReviewMsg, `strong-fixer-review-${finalReviewerId}-pr${prNumber}`,
                    `${finalReviewerId}-reviewer`, finalRevModel,
                );
                if (finalRevTokenUsage) newTokenUsage.push(finalRevTokenUsage);
                newOutcomes.push(finalOutcome);

                const finalReviewOutput: ReviewOutput = finalOutcome.kind === 'abstained'
                    ? { status: 'changes_requested', summary: `Final reviewer abstained: ${finalOutcome.detail}`, comments: [], criteriaVerdicts: [] }
                    : finalOutcome.output;

                finalReviewerLog.info(`Final review decision: ${finalOutcome.kind} (${finalReviewOutput.comments?.length ?? 0} comments)`);
                for (const c of finalReviewOutput.comments ?? []) {
                    finalReviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                }

                const reviewIterForFixer = (allReviews.reduce((m, r) => Math.max(m, r.iteration), 0)) + 1;
                newReviews.push({
                    reviewerId: finalReviewerId,
                    status: finalOutcome.kind === 'approved' ? 'approved' : 'changes_requested',
                    comments: (finalReviewOutput.comments ?? []).map((c: any, idx: number) => ({
                        id: `${finalReviewerId}-strong-fixer-${idx}`,
                        reviewerId: finalReviewerId,
                        filePath: c.filePath ?? '',
                        line: c.line,
                        body: c.body ?? '',
                        severity: c.severity ?? 'info',
                        resolved: false,
                    })),
                    iteration: reviewIterForFixer,
                });

                if (finalOutcome.kind === 'approved') {
                    log.info(`Final reviewer approved PR #${prNumber} after strong fixer`);
                    prStatus = 'approved';
                } else {
                    log.warn(`Final reviewer still requested changes for PR #${prNumber} after strong fixer — leaving as-is`);
                    newTranscript.push(msg('conductor', `Strong fixer final review: still requesting changes — PR left open`));
                }
            } catch (finalRevErr: any) {
                log.error(`Strong fixer final review failed: ${finalRevErr.message}`);
            }
        } else {
            log.warn('No reviewer available for strong fixer final review — leaving PR as-is');
        }
    } catch (fixerErr: any) {
        log.error(`Strong fixer failed: ${fixerErr.message}`);
        newTranscript.push(msg('conductor', `Strong fixer failed: ${fixerErr.message}`));
    } finally {
        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
            `strong fixer pass (model: ${STRONG_FIXER_MODEL || PRINCIPAL_DEV_MODEL})`, gitContext);
    }

    return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
}
