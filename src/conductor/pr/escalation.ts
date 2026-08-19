/**
 * Escalation — invoke a senior dev and reviewer when CRITICALs persist.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { getLogger } from '../../utils/logger';
import { buildDevAgent } from '../../agents/developers/dev-agent.builder';
import { buildReviewerAgent } from '../../agents/developers/reviewer-agent.builder';
import { getDevAgent } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import { getEffectiveLimits } from '../../utils/run-budget';
import {
    selectEscalationCandidate,
    type ReviewOutcome,
} from '../review-policy';
import { PR_EXHAUSTION_STRATEGY } from '../../config';
import { invokeDevAgent, invokeReviewerAgent, getModelForRank } from './agent-invoke';
import { commitWorktree } from './commit';
import { getReviewDiffContent } from './diff';
import { buildEscalationMessage } from './dev-prompts';
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

export interface EscalationInput {
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
    allReviews: PRReview[];
    reconcileClaims: (who: string, claimed?: FileChange[]) => FileChange[];
}

export interface EscalationResult {
    prStatus: 'open' | 'approved';
    newReviews: PRReview[];
    newOutcomes: ReviewOutcome[];
    newFileChanges: FileChange[];
    newTranscript: TranscriptMessage[];
    newTokenUsage: TokenCallRecord[];
}

/**
 * Run escalation: a senior dev fixes CRITICALs, then a senior reviewer evaluates.
 */
export async function runEscalation(input: EscalationInput): Promise<EscalationResult> {
    const {
        worktreeWorkspace, baseRef, branchName, baseBranch,
        projectSlug, primaryStoryId, assignments, reviewerAgentIds,
        contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
        prNumber, prTitle, prBody, respawnCtx, allReviews, reconcileClaims,
    } = input;

    const newReviews: PRReview[] = [];
    const newOutcomes: ReviewOutcome[] = [];
    const newFileChanges: FileChange[] = [];
    const newTranscript: TranscriptMessage[] = [];
    const newTokenUsage: TokenCallRecord[] = [];
    let prStatus: 'open' | 'approved' = 'open';

    // Only escalate if strategy allows and there are CRITICALs
    if (PR_EXHAUSTION_STRATEGY === 'fix-only') {
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    const finalIteration = allReviews.reduce((m, r) => Math.max(m, r.iteration), 0);
    const lastReviews = allReviews.filter(r => r.iteration === finalIteration);
    const hasCritical = lastReviews.some(r =>
        r.comments.some((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
    );

    if (!hasCritical) {
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    const reviewLimit = getEffectiveLimits().maxReviewIterations;
    log.warn(`PR #${prNumber} has unresolved CRITICALs after ${reviewLimit} iterations. Escalating developer...`);
    newTranscript.push(msg('conductor', `Escalating: unresolved CRITICALs after max iterations`));

    const originalDevId = assignments[0].devAgentId;
    const escalatedDevId = selectEscalationCandidate(
        originalDevId,
        [...reviewerAgentIds, originalDevId],
    );

    if (!escalatedDevId) {
        log.warn('No escalation candidate found — leaving PR open');
        newTranscript.push(msg('conductor', `No escalation candidate found — PR left open`));
        return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
    }

    const escalatedDevEntry = getDevAgent(escalatedDevId)!;
    log.info(`Escalated dev: ${escalatedDevEntry.name} (${escalatedDevId})`);

    const escalatedConventions = resolveConventionFiles(escalatedDevEntry.languages, techStack);
    const buildEscalatedFn = () => buildDevAgent(apiKey, escalatedDevEntry, worktreeWorkspace, gitContext, baseBranch, escalatedConventions, isMaintainMode);
    const escalatedDev = buildEscalatedFn();
    const criticalComments = lastReviews.flatMap(r =>
        r.comments.filter((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
    );
    const escalationMsg = buildEscalationMessage(contextPrompt, projectSlug, branchName, JSON.stringify(criticalComments, null, 2));

    try {
        const escModel = getModelForRank(escalatedDevEntry.rank as DevRank);
        const { output: fixOutput, tokenUsage: escTokenUsage } = await invokeDevAgent(escalatedDev, escalationMsg, `escalation-${escalatedDevId}`, escalatedDevId, escModel, buildEscalatedFn, respawnCtx);
        if (escTokenUsage) newTokenUsage.push(escTokenUsage);
        const escChanges = reconcileClaims(`${escalatedDevId} (escalation)`, fixOutput.fileChanges);
        newFileChanges.push(...escChanges);
        log.info(`Escalated dev ${escalatedDevId} completed fixes: ${escChanges.length} verified change(s)`);
        newTranscript.push(msg(escalatedDevId, `Escalated dev fixes applied`));

        // Find escalated reviewer (higher rank, not the originals)
        const escalatedReviewerId = selectEscalationCandidate(
            escalatedDevId,
            [...reviewerAgentIds, escalatedDevId, originalDevId],
        );

        if (escalatedReviewerId) {
            const escalatedReviewerEntry = getDevAgent(escalatedReviewerId)!;
            const escalatedReviewerLog = getLogger(`${escalatedReviewerEntry.tag} [ESCALATED REVIEW]`, escalatedReviewerEntry.colorCode);
            escalatedReviewerLog.info(`Escalated review of PR #${prNumber}`);

            const escalatedReviewerConventions = resolveConventionFiles(escalatedReviewerEntry.languages, techStack);
            const escalatedReviewer = buildReviewerAgent(apiKey, escalatedReviewerEntry, worktreeWorkspace, gitContext, baseBranch, escalatedReviewerConventions);
            const escalatedDiffContent = getReviewDiffContent(worktreeWorkspace, baseRef, branchName);

            const escalatedReviewMsg = [
                `## Escalated Review — Pull Request #${prNumber}: ${prTitle}`,
                `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                `\n## Diff\n\n${escalatedDiffContent}`,
                `\n## Context: This is an escalated review after ${reviewLimit} iterations. A higher-rank dev has already applied fixes.`,
            ].join('\n');

            try {
                const escRevModel = getModelForRank(escalatedReviewerEntry.rank as DevRank);
                const { outcome: escalatedOutcome, tokenUsage: escRevTokenUsage } = await invokeReviewerAgent(
                    escalatedReviewer, escalatedReviewMsg, `escalated-${escalatedReviewerId}-pr${prNumber}`,
                    `${escalatedReviewerId}-reviewer`, escRevModel,
                );
                if (escRevTokenUsage) newTokenUsage.push(escRevTokenUsage);
                newOutcomes.push(escalatedOutcome);

                const escalatedReviewOutput: ReviewOutput = escalatedOutcome.kind === 'abstained'
                    ? { status: 'changes_requested', summary: `Escalated reviewer abstained: ${escalatedOutcome.detail}`, comments: [], criteriaVerdicts: [] }
                    : escalatedOutcome.output;

                escalatedReviewerLog.info(`Escalated decision: ${escalatedOutcome.kind} (${escalatedReviewOutput.comments?.length ?? 0} comments)`);
                for (const c of escalatedReviewOutput.comments ?? []) {
                    escalatedReviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                }

                newReviews.push({
                    reviewerId: escalatedReviewerId,
                    status: escalatedOutcome.kind === 'approved' ? 'approved' : 'changes_requested',
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

                if (escalatedOutcome.kind === 'approved') {
                    log.info(`Escalated reviewer approved PR #${prNumber}`);
                    prStatus = 'approved';
                } else {
                    log.warn(`Escalated reviewer also requested changes for PR #${prNumber} — leaving open`);
                    newTranscript.push(msg('conductor', `Escalated reviewer rejected — PR left open`));
                }
            } catch (escRevErr: any) {
                log.error(`Escalated review failed: ${escRevErr.message}`);
            }
        } else {
            log.warn('No escalated reviewer available — leaving PR open for human intervention');
        }
    } catch (escErr: any) {
        log.error(`Escalated dev failed: ${escErr.message}`);
        newTranscript.push(msg('conductor', `Escalation failed: ${escErr.message}`));
    } finally {
        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
            `escalated dev fixes from ${escalatedDevId}`, gitContext);
    }

    return { prStatus, newReviews, newOutcomes, newFileChanges, newTranscript, newTokenUsage };
}
