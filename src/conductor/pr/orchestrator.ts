/**
 * PR Workflow Orchestrator
 *
 * Manages the full lifecycle of a pull request:
 *   worktree (new, or resumed from the branch's remote head) → dev work →
 *   gates → PR (created or reused) → review loop → merge
 *
 * Called by the dispatcher for each planned branch.
 *
 * Split into focused modules in Sub-Plan 25-08 and Plan 30-02. This file is
 * the top-level orchestrator that delegates to:
 *   worktree.ts, worktree-deps.ts (Plan 30-07), assignment-runner.ts, gates.ts,
 *   pr-github.ts, pr-body.ts, review-loop.ts, escalation.ts, strong-fixer.ts,
 *   merge-decision.ts, merge-ladder.ts, commit.ts
 *
 * Plan 30-02 outcomes besides merged / blocked / open:
 *   deferred       the branch budget ran out before every assignment ran — the
 *                  executed work is pushed, no gates/PR/review run, the next round
 *                  resumes the branch from its remote head
 *   push-rejected  the branch could not be pushed — no PR, review or merge (status closed)
 */
import { getLogger } from '../../utils/logger';
import { gitExec } from '../../utils/git-exec';
import { getDevAgent } from '../../agents/developers/registry';
import {
    GITHUB_OWNER, GITHUB_REPO,
    SECURITY_GATE_IN_PR, RECONCILE_FILE_CHANGES, GATE_INTEGRITY_MODE,
} from '../../config';
import { reconcileFileChanges } from '../file-change-reconciliation';
import { emitRunEvent } from '../../utils/event-bus';
import { gateReportToMarkdown } from '../quality-gates';
import { scanForSecrets, securityReportToMarkdown } from '../security-gates';
import { tamperFindingsToMarkdown, type TamperFinding } from '../gate-integrity';
import { mdTable } from '../../utils/markdown-table';
import { ensureProjectGitignore, managedGitignoreEntries } from '../../utils/workspace';
import type { CompletionEvidence } from '../assignment-policy';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage, PullRequest,
    GitContext, TechDecision, UserStory, Task, RepoContract,
} from '../../agents/_shared/base-schemas';
import type { TokenCallRecord } from '../../utils/token-tracker';

// Extracted modules
import { createBranchWorktree, disposeWorktree, salvageWorktree } from './worktree';
import { preinstallWorktreeDeps } from './worktree-deps';
import { getOctokit, createOrReusePR, findExistingPR, postComment } from './pr-github';
import { buildPRTitle, buildPRDescription } from './pr-body';
import { resolveBaseRef } from './agent-invoke';
import { commitWorktree, pushBranch, executedAssignmentIds, headSha } from './commit';
import { captureBaseline, failedGateOf, runIntegrityGate, runGatesWithRepair } from './gates';
import { runAssignments, makeBranchBudget, partitionByExecution, type BranchAccumulators } from './assignment-runner';
import { runReviewLoop } from './review-loop';
import { runEscalation } from './escalation';
import { runStrongFixer } from './strong-fixer';
import { integrateBase } from './merge-ladder';
import { runMergeStage, type MergeEvidence } from './merge-decision';
import { msg } from './transcript';

const log = getLogger('[PR-Workflow]', 135);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PRWorkflowInput {
    branchName: string;
    baseBranch: string;
    /** In the dispatch plan's intra-branch dependency order (buildDispatchPlan). */
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
    /** Tasks from the PM plan — when present, only the tasks for this branch's
     *  assignments are injected into the dev prompt (P11: task descriptions reach developers). */
    tasks?: Task[];
    /** Whether we are operating on an existing codebase (maintain mode). */
    isMaintainMode?: boolean;
    /** Run output directory — used for salvage patch export (Sub-Plan 06 §3). */
    outputPath?: string;
    /** Repo contract — completion evidence resolves declared module ids through it (Plan 30-02). */
    repoContract?: RepoContract | null;
}

export interface PRWorkflowResult {
    pullRequest: PullRequest;
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
    tokenUsage: TokenCallRecord[];
    /** Evidence of assignment completion with real file changes (Sub-Plan 06 §6). */
    completionEvidence?: CompletionEvidence[];
    /** Branch salvaged to outputPath/salvage/ (Sub-Plan 06 §3). */
    salvageBranch?: string;
    /** Phantom file changes: claimed by agents but not found on disk (Sub-Plan 08 §7). */
    phantomFileChanges?: FileChange[];
    /** Assignments never started because the branch budget ran out (Plan 30-02) — they stay pending. */
    deferredAssignmentIds?: string[];
}

// ─── Main PR workflow ────────────────────────────────────────────────────────

export async function executePRWorkflow(input: PRWorkflowInput): Promise<PRWorkflowResult> {
    const {
        branchName, baseBranch, assignments, reviewerAgentIds, taskType,
        workspacePath, apiKey, contextPrompt, currentState, projectSlug, gitContext,
        techStack, userStories, tasks, isMaintainMode, outputPath, repoContract,
    } = input;

    const ghOwner = gitContext?.owner ?? GITHUB_OWNER;
    const ghRepo = gitContext?.repo ?? GITHUB_REPO;
    const primaryStoryId = assignments[0]?.storyId ?? 'CLEANUP';
    const authorAgentId = assignments[0]?.devAgentId ?? 'unknown';
    // Plan 24 D2: the branch budget clock starts with the workflow
    const branchStartMs = Date.now();

    const sink: BranchAccumulators = { fileChanges: [], phantomFileChanges: [], artifacts: [], transcript: [], tokenUsage: [] };
    const collected = (): Omit<PRWorkflowResult, 'pullRequest'> => ({
        fileChanges: sink.fileChanges, artifacts: sink.artifacts, transcript: sink.transcript, tokenUsage: sink.tokenUsage,
        phantomFileChanges: sink.phantomFileChanges.length > 0 ? sink.phantomFileChanges : undefined,
    });
    const pr = (fields: Pick<PullRequest, 'id' | 'title' | 'description' | 'status' | 'assignmentIds'> & Partial<PullRequest>): PullRequest => ({
        prNumber: 0, prUrl: '', branchName, authorAgentId, reviewerAgentIds, reviews: [], taskType, currentState, ...fields,
    });

    // ── 0. Create the isolated worktree — resumed from origin/<branch> when it was pushed before ──
    const { worktreeDir, worktreeWorkspace, gitRoot, resumedFrom } = createBranchWorktree(workspacePath, branchName, baseBranch);
    sink.transcript.push(msg('conductor', resumedFrom
        ? `Resumed branch ${branchName} from ${resumedFrom} in an isolated worktree`
        : `Created isolated worktree for branch: ${branchName} from ${baseBranch}`));

    let wasMerged = false;

    try {
        // Fetch base branch and resolve to a ref that exists in the worktree
        gitExec(worktreeWorkspace, `fetch origin ${baseBranch}`);
        const baseRef = resolveBaseRef(worktreeWorkspace, baseBranch);
        const respawnCtx = { worktreeDir: worktreeWorkspace, baseRef };

        const reconcileClaims = (who: string, claimed?: FileChange[]): FileChange[] => {
            if (!claimed?.length) return [];
            if (!RECONCILE_FILE_CHANGES) return claimed;
            const recon = reconcileFileChanges(worktreeWorkspace, claimed);
            if (recon.phantoms.length > 0 || recon.unreported.length > 0) {
                log.warn(`${who} claimed ${claimed.length} changes; ${recon.verified.length} verified, ${recon.phantoms.length} phantom, ${recon.unreported.length} unreported`);
                sink.phantomFileChanges.push(...recon.phantoms);
            }
            return [...recon.verified, ...recon.unreported];
        };

        // ── 0a. Plan 30-02: a resumed branch skips what already ran and takes in the latest base first ──
        const { previouslyExecuted, toRun } = partitionByExecution(
            assignments, resumedFrom ? executedAssignmentIds(worktreeWorkspace, baseRef) : new Set<string>());
        if (resumedFrom) {
            log.info(`Resumed ${branchName}: ${previouslyExecuted.length} assignment(s) already executed `
                + `[${previouslyExecuted.map(a => a.id).join(', ')}], ${toRun.length} to run [${toRun.map(a => a.id).join(', ')}]`);
            const integration = await integrateBase(
                worktreeWorkspace, branchName, baseBranch, projectSlug, primaryStoryId,
                assignments, contextPrompt, apiKey, gitContext, techStack, isMaintainMode, respawnCtx,
            );
            if (!integration.resolved) {
                gitExec(worktreeWorkspace, 'merge --abort');
                const reason = `Unresolvable merge conflicts with ${baseBranch} when resuming ${branchName}`;
                let existing: Awaited<ReturnType<typeof findExistingPR>> = null;
                try {
                    existing = await findExistingPR(getOctokit(gitContext), ghOwner, ghRepo, branchName);
                } catch (ghErr: any) { log.warn(`Could not look up the open PR of ${branchName}: ${ghErr.message}`); }
                log.error(`${reason} — no dev work, gates or review this round`);
                sink.transcript.push(msg('conductor', `BLOCKED: ${reason}`));
                emitRunEvent('pr:blocked', { prNumber: existing?.number ?? 0, blockers: [reason] });
                if (outputPath) salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, reason, outputPath);
                return {
                    ...collected(),
                    pullRequest: pr({
                        id: existing ? `PR-${existing.number}` : `PR-RESUME-CONFLICT-${branchName}`,
                        prNumber: existing?.number ?? 0, prUrl: existing?.html_url ?? '',
                        title: `[BLOCKED] ${reason}`, description: reason, status: 'blocked', blockers: [reason],
                        assignmentIds: previouslyExecuted.map(a => a.id),
                    }),
                    salvageBranch: outputPath ? branchName : undefined,
                };
            }
        }

        // ── 0b. Ensure the worktree carries the stack-aware .gitignore ──
        try {
            ensureProjectGitignore(worktreeWorkspace, managedGitignoreEntries(techStack));
        } catch (giErr: any) {
            log.warn(`Could not refresh .gitignore in worktree: ${giErr.message}`);
        }

        // ── 0b'. Plan 30-07: install dependencies once, so no agent spends turns on `npm install` ──
        await preinstallWorktreeDeps(worktreeWorkspace);

        // ── 0c. Capture per-branch config baseline for tamper detection (after the base is in) ──
        const branchBaseline = (GATE_INTEGRITY_MODE !== 'off') ? captureBaseline(worktreeWorkspace) : null;

        // ── 1. Dev work: one invocation per not-yet-executed assignment (Plan 26 B3, Plan 30-02) ──
        const checkBranchBudget = makeBranchBudget(toRun.length, sink.tokenUsage, branchStartMs);
        const run = await runAssignments({
            branchName, baseBranch, projectSlug, primaryStoryId,
            assignments: toRun, previouslyExecuted, worktreeWorkspace, apiKey, contextPrompt,
            gitContext, techStack, userStories, tasks, isMaintainMode, outputPath,
            respawnCtx, checkBranchBudget, sink,
        });
        // A PR claims only the assignments whose agent actually ran on this branch.
        const claimedIds = assignments.map(a => a.id)
            .filter(id => previouslyExecuted.some(a => a.id === id) || run.executedIds.includes(id));
        const claimed = assignments.filter(a => claimedIds.includes(a.id));

        /** No PR, review or merge: the branch could not be pushed. */
        const pushRejected = (error: string | undefined, extra: Partial<PRWorkflowResult> = {}): PRWorkflowResult => {
            const reason = `push-rejected: ${(error ?? 'unknown error').slice(0, 300)}`;
            sink.transcript.push(msg('conductor', `Branch ${branchName} could not be pushed — no PR, review or merge (${reason})`));
            if (outputPath) salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, reason, outputPath);
            return {
                ...collected(),
                pullRequest: pr({ id: `PR-PUSH-REJECTED-${branchName}`, title: `[PUSH-REJECTED] ${branchName}`, description: reason, status: 'closed', assignmentIds: claimedIds }),
                salvageBranch: outputPath ? branchName : undefined,
                ...extra,
            };
        };

        // ── 1a. Plan 30-02: the branch budget ran out — push the executed work, defer the rest ──
        if (run.deferredIds.length > 0) {
            commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'chore', `partial work before budget stop`, gitContext);
            const push = pushBranch(worktreeWorkspace, branchName, gitContext);
            if (!push.pushed) return pushRejected(push.error, { deferredAssignmentIds: run.deferredIds });
            const description = `Branch budget reached (${run.budgetStop}) before [${run.deferredIds.join(', ')}] ran. `
                + `Executed: [${claimedIds.join(', ') || 'none'}], pushed to origin/${branchName}; the next round resumes the branch. `
                + `Gates, PR and review were skipped.`;
            sink.transcript.push(msg('conductor', `DEFERRED ${branchName}: ${description}`));
            return {
                ...collected(),
                pullRequest: pr({
                    id: `PR-DEFERRED-${branchName}`, title: `[DEFERRED] ${run.deferredIds.length} assignment(s) on ${branchName}`,
                    description, status: 'deferred', assignmentIds: claimedIds,
                }),
                deferredAssignmentIds: run.deferredIds,
            };
        }

        // Ensure everything is committed (pushed and verified right before the PR)
        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'chore', `final cleanup for ${branchName}`, gitContext);
        emitRunEvent('branch:pr-pending', { branchName, assignments: claimedIds.length, reason: 'quality-gates' });

        // ── 2. Post-development quality gates + repair (gates.ts) ───────
        const gates = await runGatesWithRepair({
            worktreeWorkspace, branchName, baseBranch, projectSlug, primaryStoryId,
            primaryDevId: authorAgentId, contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
            respawnCtx, reconcileClaims,
        });
        sink.fileChanges.push(...gates.fileChanges);
        sink.transcript.push(...gates.transcript);
        sink.tokenUsage.push(...gates.tokenUsage);
        let gateReport = gates.gateReport;

        // ── 2a. Gate integrity: tamper detection ─────────────────────────
        let integrityFindings: TamperFinding[] = [];
        const preIntegrityHead = headSha(worktreeWorkspace);
        if (GATE_INTEGRITY_MODE !== 'off' && branchBaseline) {
            const result = await runIntegrityGate(worktreeWorkspace, branchBaseline, branchName, projectSlug, gateReport, outputPath, gitContext);
            integrityFindings = result.integrityFindings;
            gateReport = result.gateReport;
            if (integrityFindings.length > 0) {
                sink.transcript.push(msg('conductor', `Gate integrity: ${integrityFindings.length} finding(s) detected\n${integrityFindings.map(f => `- [${f.severity}] ${f.kind}: ${f.detail}`).join('\n')}`));
            }
        }
        // Plan 30-02: remember the HEAD each part of the evidence was produced at. An
        // enforce-mode revert commits and re-runs the gates, so then both describe the new HEAD.
        const integritySha = headSha(worktreeWorkspace);
        let evidence: MergeEvidence = {
            gateReport, integrityFindings, integritySha,
            gateSha: integritySha === preIntegrityHead ? gates.gateSha : integritySha,
        };

        // ── 2b. Plan 26, A4: Block PR when critical gates (typecheck/build) still fail ──
        const criticalFailures = (gateReport && !gateReport.passed)
            ? gateReport.results.filter(r => !r.passed && !r.skipped && ['typecheck', 'build'].includes(r.step))
            : [];
        if (criticalFailures.length > 0) {
            const failedSteps = criticalFailures.map(f => f.step).join(', ');
            log.error(`Critical gates still failing on ${branchName}: ${failedSteps} — skipping PR`);
            sink.transcript.push(msg('conductor', `BLOCKED: ${failedSteps} still failing after repair`));
            emitRunEvent('branch:gates-blocked', { branchName, failedSteps });
            if (outputPath) salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, 'critical-gates-failed', outputPath);
            return {
                ...collected(),
                pullRequest: pr({
                    id: `PR-GATES-FAILED-${branchName}`, title: `[GATES-FAILED] ${failedSteps} on ${branchName}`,
                    description: `Critical quality gates (${failedSteps}) still failing after repair attempts.`,
                    status: 'closed', assignmentIds: claimedIds,
                    // Plan 30-05: triage turns this into one fix assignment on the branch
                    blockers: [`critical quality gates still failing after repair: ${failedSteps}`],
                    failedGate: failedGateOf(criticalFailures),
                }),
                salvageBranch: branchName,
            };
        }

        // ── 2c. Check for actual commits before creating PR ─────────────
        const diffCheck = gitExec(worktreeWorkspace, `log ${baseRef}..HEAD --oneline`);
        if (!diffCheck || diffCheck.startsWith('Error:') || diffCheck.trim() === '') {
            log.warn(`No commits on branch ${branchName} relative to ${baseBranch} — skipping PR creation`);
            sink.transcript.push(msg('conductor', `Skipped PR for ${branchName}: no commits (dev agent produced no changes)`));
            return {
                ...collected(),
                pullRequest: pr({
                    id: `PR-SKIPPED-${branchName}`, title: `[SKIPPED] No changes on ${branchName}`,
                    description: 'Dev agent did not produce any commits.', status: 'closed', assignmentIds: claimedIds,
                }),
            };
        }

        // ── 2d. Plan 30-02: the PR must show this HEAD — a failed push gets no PR, review or merge ──
        const push = pushBranch(worktreeWorkspace, branchName, gitContext);
        if (!push.pushed) return pushRejected(push.error);

        // ── 3. Create (or reuse) the GitHub PR ──────────────────────────
        const prAssignments = claimed.length > 0 ? claimed : assignments;
        const prTitle = buildPRTitle(prAssignments, taskType, projectSlug);
        let prBody = buildPRDescription(prAssignments, sink.fileChanges, taskType, currentState, authorAgentId);
        // Plan 26, A4: warn in PR body when dev agents crashed
        if (run.failedIds.length > 0) {
            prBody += `\n\n## Dev Agent Failures\n\n`;
            prBody += `**Warning:** The following agent(s) crashed during development: ${run.failedAgentIds.join(', ')}.\n`;
            prBody += `Failed assignment(s): ${run.failedIds.join(', ')}. Some work may be incomplete.\n`;
        }
        if (gateReport && gateReport.results.length > 0) prBody += `\n\n## Quality Gates\n\n${gateReportToMarkdown(gateReport)}`;
        if (integrityFindings.length > 0) {
            const criticals = integrityFindings.filter(f => f.severity === 'critical');
            const majors = integrityFindings.filter(f => f.severity === 'major');
            if (criticals.length > 0) prBody += `\n\n${tamperFindingsToMarkdown(criticals)}`;
            if (majors.length > 0) prBody += `\n\n## Heuristic findings (informational)\n\n` + mdTable(['Severity', 'Kind', 'File', 'Detail'], majors.map(f => [f.severity.toUpperCase(), f.kind, `\`${f.file}\``, f.detail]));
        }

        // Secret scan before PR
        let secretsBlockMerge = false;
        if (SECURITY_GATE_IN_PR) {
            try {
                const secretFindings = scanForSecrets(worktreeWorkspace);
                if (secretFindings.length > 0) {
                    const criticalCount = secretFindings.filter(f => f.severity === 'critical').length;
                    log.warn(`Secret scan: ${secretFindings.length} finding(s), ${criticalCount} critical`);
                    prBody += `\n\n## Security Scan\n\n${securityReportToMarkdown({ findings: secretFindings, passed: criticalCount === 0 })}`;
                    if (criticalCount > 0) { secretsBlockMerge = true; log.error(`Critical secrets detected — merge will be blocked`); sink.transcript.push(msg('security-gates', `PR ${branchName}: BLOCKED — ${criticalCount} critical secret(s) detected`)); }
                }
            } catch (secErr: any) { log.warn(`PR secret scan error (non-fatal): ${secErr.message}`); }
        }

        log.info(`Creating PR: "${prTitle}"`);
        const octokit = getOctokit(gitContext);
        // A resumed branch reuses its open PR; createOrReusePR refreshes the body.
        const ghPr = await createOrReusePR(octokit, ghOwner, ghRepo, branchName, baseBranch, prTitle, prBody, gitContext);

        if (!ghPr) {
            sink.transcript.push(msg('conductor', `PR creation failed for ${branchName}`));
            return {
                ...collected(),
                pullRequest: pr({ id: `PR-FAILED-${branchName}`, title: prTitle, description: prBody.slice(0, 500), status: 'pr-creation-failed', assignmentIds: claimedIds }),
            };
        }

        log.info(`PR #${ghPr.number} for ${branchName}: ${ghPr.html_url}`);
        emitRunEvent('pr:opened', { prNumber: ghPr.number, title: prTitle, branch: branchName, baseBranch });
        sink.transcript.push(msg('conductor', `PR #${ghPr.number} open for review: ${prTitle}`));

        // Post review-request comment
        try {
            const authorEntry = getDevAgent(authorAgentId);
            const reviewerNames = reviewerAgentIds.map(id => getDevAgent(id)).filter(Boolean).map(e => `${e!.name} (${e!.id})`);
            await postComment(octokit, ghOwner, ghRepo, ghPr.number,
                `[REVIEW_REQUEST] ${authorEntry?.name ?? authorAgentId} requested review from ${reviewerNames.join(' and ')}.`);
        } catch { /* non-fatal */ }

        // ── 4. Review loop ──────────────────────────────────────────────
        const stage = {
            worktreeWorkspace, baseRef, branchName, baseBranch,
            projectSlug, primaryStoryId, assignments: prAssignments, reviewerAgentIds,
            contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
            prNumber: ghPr.number, prTitle, prBody, respawnCtx, reconcileClaims,
        };
        const reviewResult = await runReviewLoop({ ...stage, checkBranchBudget });

        let prStatus = reviewResult.prStatus;
        const allReviews = reviewResult.allReviews;
        const allOutcomes = reviewResult.allOutcomes;
        sink.fileChanges.push(...reviewResult.allFileChanges);
        sink.phantomFileChanges.push(...reviewResult.allPhantomFileChanges);
        sink.transcript.push(...reviewResult.allTranscript);
        sink.tokenUsage.push(...reviewResult.allTokenUsage);

        // ── 4b. Escalation ──────────────────────────────────────────────
        if (prStatus === 'open') {
            const escResult = await runEscalation({ ...stage, allReviews, iterationsRun: reviewResult.iterationsRun });
            if (escResult.prStatus === 'approved') prStatus = 'approved';
            allReviews.push(...escResult.newReviews);
            allOutcomes.push(...escResult.newOutcomes);
            sink.fileChanges.push(...escResult.newFileChanges);
            sink.transcript.push(...escResult.newTranscript);
            sink.tokenUsage.push(...escResult.newTokenUsage);
        }

        // ── 4c. Strong Model Fixer ──────────────────────────────────────
        if (prStatus === 'open') {
            const fixerResult = await runStrongFixer({ ...stage, gateReport, integrityFindings, allReviews, allOutcomes });
            if (fixerResult.prStatus === 'approved') prStatus = 'approved';
            allReviews.push(...fixerResult.newReviews);
            allOutcomes.push(...fixerResult.newOutcomes);
            sink.fileChanges.push(...fixerResult.newFileChanges);
            sink.transcript.push(...fixerResult.newTranscript);
            sink.tokenUsage.push(...fixerResult.newTokenUsage);
            // The fixer gated its committed work — reuse that report if HEAD is still there.
            if (fixerResult.gateEvidence) {
                evidence = { ...evidence, gateReport: fixerResult.gateEvidence.report, gateSha: fixerResult.gateEvidence.sha };
            }

            // Post strong-fixer review comment
            if (fixerResult.newReviews.length > 0) {
                const lastReview = fixerResult.newReviews[fixerResult.newReviews.length - 1];
                const lastOutcome = fixerResult.newOutcomes[fixerResult.newOutcomes.length - 1];
                const reviewerEntry = getDevAgent(lastReview.reviewerId);
                if (reviewerEntry) {
                    const statusTag = lastReview.status === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
                    const commentBody = [
                        `[REVIEW: ${statusTag} by ${reviewerEntry.name} (${reviewerEntry.id})] — strong-fixer final review`,
                        '', `**Summary:** ${lastOutcome.kind === 'abstained' ? 'Abstained' : (lastOutcome as any).output?.summary ?? ''}`,
                        ...lastReview.comments.map((c: any) =>
                            `- **\`${c.filePath}\`${c.line ? `:${c.line}` : ''}** — **[${(c.severity ?? 'INFO').toUpperCase()}]** ${c.body}`),
                    ].join('\n');
                    await postComment(octokit, ghOwner, ghRepo, ghPr.number, commentBody);
                }
            }
        }

        // ── 5. Merge: fresh evidence, decision, merge guard (merge-decision.ts) ──
        const merge = await runMergeStage({
            octokit, ghOwner, ghRepo, pr: ghPr,
            evidenceCtx: { worktreeWorkspace, branchName, projectSlug, outputPath, gitContext, branchBaseline },
            evidence, reviewStatus: prStatus, allReviews, allOutcomes, iterationsUsed: reviewResult.iterationsRun,
            secretsBlockMerge, baseRef, baseBranch, primaryStoryId, assignments: prAssignments,
            contextPrompt, apiKey, techStack, isMaintainMode, respawnCtx, repoContract, transcript: sink.transcript,
        });
        wasMerged = merge.merged;

        let salvageBranch: string | undefined;
        if ((merge.prStatus === 'open' || merge.prStatus === 'blocked') && outputPath) {
            salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, `PR #${ghPr.number} not merged (status: ${merge.prStatus})`, outputPath);
            salvageBranch = branchName;
        }

        const finalFindings = merge.evidence.integrityFindings;
        const failedGate = merge.merged ? undefined : failedGateOf(merge.evidence.gateReport?.results);
        return {
            ...collected(),
            pullRequest: pr({
                id: `PR-${ghPr.number}`, prNumber: ghPr.number, prUrl: ghPr.html_url,
                title: prTitle, description: prBody, reviews: allReviews, status: merge.prStatus, assignmentIds: claimedIds,
                ...(merge.blockers.length > 0 ? { blockers: merge.blockers } : {}),
                ...(failedGate ? { failedGate } : {}),
                ...(finalFindings.length > 0 ? { integrityFindings: finalFindings } : {}),
            }),
            completionEvidence: merge.completionEvidence, salvageBranch,
        };
    } finally {
        disposeWorktree(gitRoot, worktreeDir, branchName, wasMerged);
    }
}
