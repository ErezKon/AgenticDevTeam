/**
 * PR Workflow Orchestrator
 *
 * Manages the full lifecycle of a pull request:
 *   branch creation → dev work → PR creation → review loop → merge
 *
 * Called by the dispatcher for each branch group of assignments.
 *
 * Split into focused modules in Sub-Plan 26-08. This file is the
 * top-level orchestrator (~300 lines) that delegates to:
 *   worktree.ts, pr-github.ts, pr-body.ts, dev-prompts.ts, diff.ts,
 *   agent-invoke.ts, commit.ts, gates.ts, review-loop.ts, escalation.ts,
 *   strong-fixer.ts, merge-ladder.ts
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec, gitPush } from '../../utils/git-exec';
import { writeArtifact } from '../../agents/_shared/artifact';
import { buildDevAgent } from '../../agents/developers/dev-agent.builder';
import { getDevAgent } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import {
    GITHUB_OWNER, GITHUB_REPO,
    SECURITY_GATE_IN_PR,
    SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_CHARS, RECONCILE_FILE_CHANGES,
    MAX_BRANCH_COST_USD, MAX_BRANCH_WALL_MS,
    REVIEW_MERGE_POLICY, REVIEW_QUORUM,
    GATE_INTEGRITY_MODE,
    PR_TEST_TIMEOUT_MS, PR_TEST_INSTALL_TIMEOUT_MS,
} from '../../config';
import { InvocationBudgetExceededError } from '../../utils/run-budget';
import { buildWorkspaceSnapshot } from '../workspace-snapshot';
import { reconcileFileChanges } from '../file-change-reconciliation';
import { emitRunEvent } from '../../utils/event-bus';
import { storiesForIds, tasksForIds } from '../context-builder';
import { decideMerge, type ReviewOutcome } from '../review-policy';
import { runQualityGates, gateReportToMarkdown, detectStackRoots } from '../quality-gates';
import { runProductVerification } from '../product-verify';
import { scanForSecrets, securityReportToMarkdown } from '../security-gates';
import { tamperFindingsToMarkdown, type TamperFinding } from '../gate-integrity';
import { mdTable } from '../../utils/markdown-table';
import { estimateCost } from '../../utils/cost';
import { ensureProjectGitignore, getGitignoreEntriesForStack } from '../../utils/workspace';
import type { CompletionEvidence } from '../assignment-policy';
import type { GateReport } from '../quality-gates';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage,
    PhaseName, PullRequest,
} from '../../agents/_shared/base-schemas';
import type { TokenCallRecord } from '../../utils/token-tracker';
import type { DevRank } from '../../agents/_shared/persona';

// Extracted modules
import { createBranchWorktree, disposeWorktree, salvageWorktree } from './worktree';
import { getOctokit, createOrReusePR, mergePr, postComment, PrIdentityMismatchError } from './pr-github';
import { buildPRTitle, buildPRDescription } from './pr-body';
import { buildRepairMessage } from './dev-prompts';
import { DIFF_EXCLUDE_SPECS } from './diff';
import { invokeDevAgent, getModelForRank, resolveBaseRef } from './agent-invoke';
import { commitWorktree } from './commit';
import { captureBaseline, runIntegrityGate } from './gates';
import { runReviewLoop } from './review-loop';
import { runEscalation } from './escalation';
import { runStrongFixer } from './strong-fixer';
import { integrateBase } from './merge-ladder';

const log = getLogger('[PR-Workflow]', 135);

function ts(): string { return new Date().toISOString(); }
function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase: 'development' as PhaseName, message };
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
    projectSlug: string;
    gitContext?: import('../../agents/_shared/base-schemas').GitContext | null;
    techStack?: import('../../agents/_shared/base-schemas').TechDecision[];
    /** User stories from the PM — when present, only the stories for this branch's
     *  assignments are injected into the dev prompt (fixes A8: every dev got all stories). */
    userStories?: import('../../agents/_shared/base-schemas').UserStory[];
    /** Tasks from the PM plan — when present, only the tasks for this branch's
     *  assignments are injected into the dev prompt (P11: task descriptions reach developers). */
    tasks?: import('../../agents/_shared/base-schemas').Task[];
    /** Whether we are operating on an existing codebase (maintain mode). */
    isMaintainMode?: boolean;
    /** Run output directory — used for salvage patch export (Sub-Plan 06 §3). */
    outputPath?: string;
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
}

// ─── Main PR workflow ────────────────────────────────────────────────────────

export async function executePRWorkflow(input: PRWorkflowInput): Promise<PRWorkflowResult> {
    const {
        branchName, baseBranch, assignments, reviewerAgentIds, taskType,
        workspacePath, apiKey, contextPrompt, currentState, projectSlug, gitContext,
        techStack, userStories, tasks, isMaintainMode, outputPath,
    } = input;

    const ghOwner = gitContext?.owner ?? GITHUB_OWNER;
    const ghRepo = gitContext?.repo ?? GITHUB_REPO;
    const primaryStoryId = assignments[0]?.storyId ?? 'CLEANUP';

    const allFileChanges: FileChange[] = [];
    const allPhantomFileChanges: FileChange[] = [];
    const allArtifacts: ArtifactRef[] = [];
    const allTranscript: TranscriptMessage[] = [];
    const allTokenUsage: TokenCallRecord[] = [];

    // ── Plan 24 D2: per-branch budget tracking ──────────────────────────
    const branchStartMs = Date.now();
    const estimateBranchCost = (): number => {
        let total = 0;
        for (const t of allTokenUsage) total += estimateCost(t.model, t.inputTokens, t.outputTokens);
        return total;
    };
    const checkBranchBudget = (checkpoint: string): string | null => {
        if (MAX_BRANCH_WALL_MS > 0) {
            const elapsedMs = Date.now() - branchStartMs;
            if (elapsedMs >= MAX_BRANCH_WALL_MS) return `wall time ${(elapsedMs / 1000).toFixed(0)}s >= cap ${(MAX_BRANCH_WALL_MS / 1000).toFixed(0)}s at ${checkpoint}`;
        }
        if (MAX_BRANCH_COST_USD > 0) {
            const cost = estimateBranchCost();
            if (cost >= MAX_BRANCH_COST_USD) return `cost $${cost.toFixed(4)} >= cap $${MAX_BRANCH_COST_USD} at ${checkpoint}`;
        }
        return null;
    };

    // ── 0. Create isolated worktree for this branch ─────────────────────
    const { worktreeDir, worktreeWorkspace, gitRoot } = createBranchWorktree(workspacePath, branchName, baseBranch);
    allTranscript.push(msg('conductor', `Created isolated worktree for branch: ${branchName} from ${baseBranch}`));

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
                allPhantomFileChanges.push(...recon.phantoms);
            }
            return [...recon.verified, ...recon.unreported];
        };

        // ── 0b. Ensure the worktree carries the stack-aware .gitignore ──
        try {
            ensureProjectGitignore(worktreeWorkspace, [
                ...getGitignoreEntriesForStack(techStack),
                '.conventions/', '.worktrees/', '.worktrees-failed/', '.agent/',
            ]);
        } catch (giErr: any) {
            log.warn(`Could not refresh .gitignore in worktree: ${giErr.message}`);
        }

        // ── 0a. Capture per-branch config baseline for tamper detection ──
        const branchBaseline = (GATE_INTEGRITY_MODE !== 'off') ? captureBaseline(worktreeWorkspace) : null;

        // ── 1. Run dev agent(s) on assignments ──────────────────────────
        const byDev = new Map<string, Assignment[]>();
        for (const a of assignments) {
            const existing = byDev.get(a.devAgentId) ?? [];
            existing.push(a);
            byDev.set(a.devAgentId, existing);
        }

        for (const [devId, devAssignments] of byDev) {
            const branchBudgetReason = checkBranchBudget(`before dev ${devId}`);
            if (branchBudgetReason) {
                log.warn(`Branch ${branchName} budget exceeded: ${branchBudgetReason} — stopping branch`);
                allTranscript.push(msg('conductor', `Branch budget exceeded: ${branchBudgetReason}`));
                emitRunEvent('branch:budget-exceeded', { branchName, reason: branchBudgetReason, checkpoint: `before dev ${devId}` });
                commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'chore', `partial work before budget stop`, gitContext);
                if (outputPath) salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, branchBudgetReason, outputPath);
                break;
            }

            const entry = getDevAgent(devId);
            if (!entry) { log.warn(`Unknown dev agent: ${devId}, skipping`); continue; }

            const devLog = getLogger(entry.tag, entry.colorCode);
            devLog.info(`Working on branch ${branchName}: ${devAssignments.length} assignment(s)`);

            const conventionFiles = resolveConventionFiles(entry.languages, techStack);
            const buildAgentFn = () => buildDevAgent(apiKey, entry, worktreeWorkspace, gitContext, baseBranch, conventionFiles, isMaintainMode);
            const agent = buildAgentFn();

            const assignmentText = devAssignments.map(a => `Assignment ${a.id} [${a.priority}/${a.complexity}]: ${a.description}`).join('\n\n');

            // Build per-branch story section
            const branchStoryIds = [...new Set(devAssignments.flatMap(a => [a.storyId, ...(a.additionalStoryIds ?? [])]).filter(Boolean))] as string[];
            let storySection = '';
            if (userStories?.length && branchStoryIds.length) {
                const { text: storyText, missing: missingStoryIds } = storiesForIds(userStories, branchStoryIds);
                storySection = `\n## User Stories for This Branch\n\n${storyText}`;
                if (missingStoryIds.length > 0) {
                    log.error(`Assignment(s) on branch ${branchName} reference unknown story id(s): ${missingStoryIds.join(', ')} — the developer will have NO acceptance criteria. This is a planning defect.`);
                }
            }

            const branchTaskIds = [...new Set(devAssignments.flatMap(a => a.taskIds ?? []))];
            const taskSection = (tasks?.length && branchTaskIds.length)
                ? `\n## Tasks for This Branch\n\n${tasksForIds(tasks, branchTaskIds)}`
                : '';

            let snapshotSection = '';
            try {
                snapshotSection = '\n' + buildWorkspaceSnapshot(worktreeWorkspace, { maxFiles: SNAPSHOT_MAX_FILES, maxChars: SNAPSHOT_MAX_CHARS });
            } catch (snapErr: any) { log.warn(`Workspace snapshot failed (non-fatal): ${snapErr.message}`); }

            const message = [
                contextPrompt, snapshotSection, storySection, taskSection,
                `\n## Project Slug: ${projectSlug}`, `\n## Your Branch: ${branchName}`,
                `\nYou are already on this branch. Do NOT create or switch branches — your workspace is isolated for this branch.`,
                `\n## IMPORTANT: Workspace Context`, `Your current working directory IS the project root.`,
                `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                `\n## Your Assignments\n\n${assignmentText}`,
            ].join('\n');

            try {
                const devModel = getModelForRank(entry.rank as DevRank);
                const { output, tokenUsage: devTokenUsage, allTokenUsage: devAllTokenUsage } = await invokeDevAgent(agent, message, `${entry.id}-${branchName}`, entry.id, devModel, buildAgentFn, respawnCtx);
                if (devTokenUsage) allTokenUsage.push(devTokenUsage);
                if (devAllTokenUsage) allTokenUsage.push(...devAllTokenUsage.slice(1));

                if (RECONCILE_FILE_CHANGES && output.fileChanges?.length) {
                    const recon = reconcileFileChanges(worktreeWorkspace, output.fileChanges);
                    if (recon.phantoms.length > 0 || recon.unreported.length > 0) {
                        log.warn(`${entry.id} claimed ${output.fileChanges.length} changes; ${recon.verified.length} verified, ${recon.phantoms.length} phantom, ${recon.unreported.length} unreported`);
                        allPhantomFileChanges.push(...recon.phantoms);
                    }
                    allFileChanges.push(...recon.verified, ...recon.unreported);
                } else if (output.fileChanges) {
                    allFileChanges.push(...output.fileChanges);
                }

                const artifact = writeArtifact({
                    agentId: entry.id, colorCode: entry.colorCode,
                    workspacePath: worktreeWorkspace, outputPath,
                    title: `${entry.name} Mission Report`,
                    content: [
                        `## Branch: ${branchName}\n`, `## Files Changed\n`,
                        ...(output.fileChanges ?? []).map(fc => `- **${fc.action}** \`${fc.path}\` — ${fc.summary}`),
                        output.notes ? `\n## Notes\n\n${output.notes}` : '',
                        output.mermaidDiagram ? `\n## Diagram\n\n\`\`\`mermaid\n${output.mermaidDiagram}\n\`\`\`` : '',
                    ].join('\n'),
                });
                allArtifacts.push(artifact);
                allTranscript.push(msg(entry.id, `Completed ${output.fileChanges?.length ?? 0} file changes on branch ${branchName}`));
                devLog.info(`Done: ${output.fileChanges?.length ?? 0} file changes`);
            } catch (err: any) {
                if (err instanceof InvocationBudgetExceededError) {
                    log.warn(`Dev agent ${devId} stopped: ${err.message}`);
                    allTranscript.push(msg(devId, `Stopped (invocation budget exceeded): ${err.message}`));
                } else {
                    log.error(`Dev agent ${devId} failed: ${err.message}`);
                    allTranscript.push(msg(devId, `Failed: ${err.message}`));
                }
            } finally {
                commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'feat',
                    `partial work from ${devId} (durable commit)`, gitContext);
            }
        }

        // Ensure everything is committed and pushed
        gitExec(worktreeWorkspace, 'add .');
        const statusOutput = gitExec(worktreeWorkspace, 'status --short');
        if (statusOutput && !statusOutput.includes('nothing to commit')) {
            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-[${primaryStoryId}]-chore: final cleanup for ${branchName}"`);
        }
        gitPush(worktreeWorkspace, branchName, gitContext);

        log.info(`All ${assignments.length} assignment(s) complete on ${branchName} — running quality gates before opening the PR`);
        emitRunEvent('branch:pr-pending', { branchName, assignments: assignments.length, reason: 'quality-gates' });

        // ── 1a. Post-development quality gates + repair ─────────────────
        let gateReport: GateReport | null = null;
        try {
            let productVerifyReport;
            try {
                const worktreeRoots = detectStackRoots(worktreeWorkspace);
                productVerifyReport = await runProductVerification(worktreeWorkspace, worktreeRoots, 'artifacts+resolve');
                log.info(`Product verification: artifacts=${productVerifyReport.artifacts.filter(a => a.passed).length}/${productVerifyReport.artifacts.length}, unresolved refs=${productVerifyReport.resolveIssues.length}`);
            } catch (pvErr: any) { log.warn(`Product verification error (non-fatal): ${pvErr.message}`); }

            gateReport = await runQualityGates(worktreeWorkspace, { timeoutMs: PR_TEST_TIMEOUT_MS, installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS, productVerify: productVerifyReport });

            if (gateReport && gateReport.results.length > 0 && !gateReport.passed) {
                const failingSteps = gateReport.results.filter(r => !r.passed && !r.skipped).map(r => `${r.step}: ${r.output.slice(0, 200)}`);
                log.warn(`Quality gates FAILED on branch ${branchName} — giving dev agent a repair attempt`);
                allTranscript.push(msg('conductor', `WARNING: Quality gates failed on branch ${branchName}:\n${failingSteps.join('\n').slice(0, 500)}`));

                const { prTestRepairAttempts } = require('../../utils/run-budget').getEffectiveLimits();
                if (prTestRepairAttempts > 0) {
                    for (let repair = 0; repair < prTestRepairAttempts; repair++) {
                        try {
                            const primaryDevId = assignments[0].devAgentId;
                            const primaryEntry = getDevAgent(primaryDevId);
                            if (!primaryEntry) break;

                            const repairConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                            const buildRepairAgentFn = () => buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, repairConventions, isMaintainMode);
                            const repairAgent = buildRepairAgentFn();

                            const failDetails = gateReport.results
                                .filter(r => !r.passed && !r.skipped)
                                .map(r => `### ${r.step} (\`${r.command}\`)\n\`\`\`\n${r.output.slice(-1000)}\n\`\`\``)
                                .join('\n\n');

                            const repairMsg = buildRepairMessage(contextPrompt, projectSlug, branchName, failDetails);
                            log.info(`Quality gate repair attempt ${repair + 1}/${prTestRepairAttempts}`);
                            const repairModel = getModelForRank(primaryEntry.rank as DevRank);
                            const { output: repairOutput, tokenUsage: repairTokenUsage } = await invokeDevAgent(
                                repairAgent, repairMsg, `repair-${primaryEntry.id}-${branchName}`, primaryEntry.id, repairModel, buildRepairAgentFn, respawnCtx);
                            if (repairTokenUsage) allTokenUsage.push(repairTokenUsage);
                            allFileChanges.push(...reconcileClaims(`${primaryEntry.id} (gate repair)`, repairOutput.fileChanges));
                        } catch (repairErr: any) { log.warn(`Quality gate repair attempt failed (non-fatal): ${repairErr.message}`); }
                        finally {
                            commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                                `repair failing quality gates (attempt ${repair + 1})`, gitContext);
                        }

                        try {
                            gateReport = await runQualityGates(worktreeWorkspace, { timeoutMs: PR_TEST_TIMEOUT_MS, installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS });
                            if (gateReport?.passed) { log.info(`Quality gates passed after repair attempt ${repair + 1}`); allTranscript.push(msg('conductor', `Quality gates passed after repair attempt ${repair + 1}`)); break; }
                        } catch (gateErr: any) { log.warn(`Quality gate re-run failed: ${gateErr.message}`); }
                    }
                }
            } else if (gateReport?.passed) {
                log.info(`Quality gates passed on branch ${branchName}`);
                allTranscript.push(msg('conductor', `Quality gates passed on branch ${branchName}`));
            }
        } catch (testErr: any) { log.warn(`Post-dev quality gate error: ${testErr.message}`); }

        // ── 1b. Gate integrity: tamper detection ─────────────────────────
        let integrityFindings: TamperFinding[] = [];
        if (GATE_INTEGRITY_MODE !== 'off' && branchBaseline) {
            const result = await runIntegrityGate(worktreeWorkspace, branchBaseline, branchName, projectSlug, gateReport, outputPath, gitContext);
            integrityFindings = result.integrityFindings;
            gateReport = result.gateReport;
            if (integrityFindings.length > 0) {
                allTranscript.push(msg('conductor', `Gate integrity: ${integrityFindings.length} finding(s) detected\n${integrityFindings.map(f => `- [${f.severity}] ${f.kind}: ${f.detail}`).join('\n')}`));
            }
        }

        // ── 1c. Check for actual commits before creating PR ─────────────
        const diffCheck = gitExec(worktreeWorkspace, `log ${baseRef}..HEAD --oneline`);
        if (!diffCheck || diffCheck.startsWith('Error:') || diffCheck.trim() === '') {
            log.warn(`No commits on branch ${branchName} relative to ${baseBranch} — skipping PR creation`);
            allTranscript.push(msg('conductor', `Skipped PR for ${branchName}: no commits (dev agent produced no changes)`));
            return {
                pullRequest: {
                    id: `PR-SKIPPED-${branchName}`, prNumber: 0, prUrl: '',
                    title: `[SKIPPED] No changes on ${branchName}`, description: 'Dev agent did not produce any commits.',
                    branchName, authorAgentId: assignments[0].devAgentId, reviewerAgentIds,
                    reviews: [], status: 'closed', assignmentIds: assignments.map(a => a.id), taskType, currentState,
                },
                fileChanges: allFileChanges, artifacts: allArtifacts, transcript: allTranscript, tokenUsage: allTokenUsage,
            };
        }

        // ── 2. Create GitHub PR ─────────────────────────────────────────
        const prTitle = buildPRTitle(assignments, taskType, projectSlug);
        let prBody = buildPRDescription(assignments, allFileChanges, taskType, currentState, assignments[0].devAgentId);
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
                    if (criticalCount > 0) { secretsBlockMerge = true; log.error(`Critical secrets detected — merge will be blocked`); allTranscript.push(msg('security-gates', `PR ${branchName}: BLOCKED — ${criticalCount} critical secret(s) detected`)); }
                }
            } catch (secErr: any) { log.warn(`PR secret scan error (non-fatal): ${secErr.message}`); }
        }

        log.info(`Creating PR: "${prTitle}"`);
        const octokit = getOctokit(gitContext);
        const ghPr = await createOrReusePR(octokit, ghOwner, ghRepo, branchName, baseBranch, prTitle, prBody, gitContext);

        if (!ghPr) {
            allTranscript.push(msg('conductor', `PR creation failed for ${branchName}`));
            return {
                pullRequest: {
                    id: `PR-FAILED-${branchName}`, prNumber: 0, prUrl: '',
                    title: prTitle, description: prBody.slice(0, 500), branchName,
                    authorAgentId: assignments[0].devAgentId, reviewerAgentIds,
                    reviews: [], status: 'pr-creation-failed', assignmentIds: assignments.map(a => a.id), taskType, currentState,
                },
                fileChanges: allFileChanges, artifacts: allArtifacts, transcript: allTranscript, tokenUsage: allTokenUsage,
            };
        }

        log.info(`PR #${ghPr.number} created: ${ghPr.html_url}`);
        emitRunEvent('pr:opened', { prNumber: ghPr.number, title: prTitle, branch: branchName, baseBranch });
        allTranscript.push(msg('conductor', `PR #${ghPr.number} created: ${prTitle}`));

        // Post review-request comment
        try {
            const authorEntry = getDevAgent(assignments[0].devAgentId);
            const reviewerNames = reviewerAgentIds.map(id => getDevAgent(id)).filter(Boolean).map(e => `${e!.name} (${e!.id})`);
            await postComment(octokit, ghOwner, ghRepo, ghPr.number,
                `[REVIEW_REQUEST] ${authorEntry?.name ?? assignments[0].devAgentId} requested review from ${reviewerNames.join(' and ')}.`);
        } catch { /* non-fatal */ }

        // ── 3. Review loop ──────────────────────────────────────────────
        const reviewResult = await runReviewLoop({
            worktreeWorkspace, baseRef, branchName, baseBranch,
            projectSlug, primaryStoryId, assignments, reviewerAgentIds,
            contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
            prNumber: ghPr.number, prTitle, prBody, respawnCtx,
            checkBranchBudget, reconcileClaims,
        });

        let prStatus = reviewResult.prStatus;
        const allReviews = reviewResult.allReviews;
        const allOutcomes = reviewResult.allOutcomes;
        allFileChanges.push(...reviewResult.allFileChanges);
        allPhantomFileChanges.push(...reviewResult.allPhantomFileChanges);
        allTranscript.push(...reviewResult.allTranscript);
        allTokenUsage.push(...reviewResult.allTokenUsage);

        // ── 3b. Escalation ──────────────────────────────────────────────
        if (prStatus === 'open') {
            const escResult = await runEscalation({
                worktreeWorkspace, baseRef, branchName, baseBranch,
                projectSlug, primaryStoryId, assignments, reviewerAgentIds,
                contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
                prNumber: ghPr.number, prTitle, prBody, respawnCtx,
                allReviews, reconcileClaims,
            });
            if (escResult.prStatus === 'approved') prStatus = 'approved';
            allReviews.push(...escResult.newReviews);
            allOutcomes.push(...escResult.newOutcomes);
            allFileChanges.push(...escResult.newFileChanges);
            allTranscript.push(...escResult.newTranscript);
            allTokenUsage.push(...escResult.newTokenUsage);
        }

        // ── 3c. Strong Model Fixer ──────────────────────────────────────
        if (prStatus === 'open') {
            const fixerResult = await runStrongFixer({
                worktreeWorkspace, baseRef, branchName, baseBranch,
                projectSlug, primaryStoryId, assignments, reviewerAgentIds,
                contextPrompt, apiKey, gitContext, techStack, isMaintainMode,
                prNumber: ghPr.number, prTitle, prBody, respawnCtx,
                gateReport, integrityFindings, allReviews, allOutcomes,
                reconcileClaims,
            });
            if (fixerResult.prStatus === 'approved') prStatus = 'approved';
            allReviews.push(...fixerResult.newReviews);
            allOutcomes.push(...fixerResult.newOutcomes);
            allFileChanges.push(...fixerResult.newFileChanges);
            allTranscript.push(...fixerResult.newTranscript);
            allTokenUsage.push(...fixerResult.newTokenUsage);

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

        // ── 4. Merge PR ─────────────────────────────────────────────────
        const allBlockingComments = allReviews.flatMap(r => r.comments).filter(c => !c.resolved && (c.severity === 'critical' || c.severity === 'major'));
        const diffStatForMerge = gitExec(worktreeWorkspace, `diff --name-only ${baseRef}...HEAD`);
        const filesChangedCount = (diffStatForMerge && !diffStatForMerge.startsWith('Error:')) ? diffStatForMerge.split('\n').filter(f => f.trim()).length : 0;
        const { getEffectiveLimits: getEL } = require('../../utils/run-budget');
        const unmetCriteriaCount = allOutcomes
            .filter((o: ReviewOutcome): o is Extract<ReviewOutcome, { kind: 'approved' | 'changes_requested' }> => o.kind !== 'abstained')
            .reduce((sum: number, o: any) => sum + (o.output.criteriaVerdicts ?? []).filter((v: any) => !v.met).length, 0);

        const mergeDecision = decideMerge({
            approvals: allOutcomes.filter(o => o.kind === 'approved').length,
            blockingComments: allBlockingComments,
            abstentions: allOutcomes.filter(o => o.kind === 'abstained').length,
            gateReport, integrityFindings,
            filesChanged: filesChangedCount, iterationsUsed: getEL().maxReviewIterations,
            policy: REVIEW_MERGE_POLICY, quorum: REVIEW_QUORUM, unmetCriteriaCount,
        });

        if (!mergeDecision.merge && REVIEW_MERGE_POLICY !== 'legacy') {
            log.warn(`PR #${ghPr.number} blocked: ${mergeDecision.reason}`);
            prStatus = 'blocked' as any;
            emitRunEvent('pr:blocked', { prNumber: ghPr.number, blockers: mergeDecision.blockers });
            allTranscript.push(msg('conductor', `PR #${ghPr.number} BLOCKED: ${mergeDecision.blockers.join('; ')}`));
            await postComment(octokit, ghOwner, ghRepo, ghPr.number,
                `:x: **[BLOCKED]** This PR cannot be merged.\n\n${mergeDecision.blockers.map(b => `- ${b}`).join('\n')}`);
        }

        if (prStatus === 'approved' || (prStatus === 'open' && REVIEW_MERGE_POLICY === 'legacy')) {
            if (prStatus === 'open') {
                log.warn(`Max review iterations reached. Merging PR #${ghPr.number} despite pending reviews (legacy policy).`);
                allTranscript.push(msg('conductor', `WARNING: Max review iterations reached, merging anyway (legacy policy)`));
            }

            // Integrate base changes
            const integration = await integrateBase(
                worktreeWorkspace, branchName, baseBranch, projectSlug, primaryStoryId,
                assignments, contextPrompt, apiKey, gitContext, techStack, isMaintainMode, respawnCtx,
            );

            if (!integration.resolved) {
                prStatus = 'open';
                allTranscript.push(msg('conductor', `Merge blocked: unresolvable conflicts on ${branchName}`));
            }

            // Merge blockers
            let mergeBlocked: string | null = null;
            const lsRemote = gitExec(worktreeWorkspace, `ls-remote --heads origin ${branchName}`);
            if (!lsRemote || lsRemote.startsWith('Error:')) mergeBlocked = 'branch not on remote';
            if (secretsBlockMerge) { mergeBlocked = 'critical secrets detected'; allTranscript.push(msg('security-gates', `Merge blocked for PR #${ghPr.number}: critical secrets detected`));
                await postComment(octokit, ghOwner, ghRepo, ghPr.number, ':x: **Merge blocked by security gate** — critical secrets detected in this PR. Remove hard-coded credentials before merging.');
            }
            const criticalIntegrity = integrityFindings.filter(f => f.severity === 'critical');
            if (criticalIntegrity.length > 0 && GATE_INTEGRITY_MODE === 'enforce') mergeBlocked = `${criticalIntegrity.length} critical integrity finding(s)`;
            const prHeadRef = ghPr.head?.ref;
            if (!mergeBlocked && prHeadRef && prHeadRef !== branchName) {
                const err = new PrIdentityMismatchError(ghPr.number, branchName, prHeadRef);
                log.error(err.message); allTranscript.push(msg('conductor', err.message)); mergeBlocked = err.message;
            }

            if (mergeBlocked === null && integration.resolved) {
                const merged = await mergePr(octokit, ghOwner, ghRepo, ghPr, branchName, baseBranch);
                if (merged) { prStatus = 'merged' as any; wasMerged = true; allTranscript.push(msg('conductor', `PR #${ghPr.number} merged to ${baseBranch}`)); }
                else { allTranscript.push(msg('conductor', `Merge failed`)); prStatus = 'open'; }
            } else if (mergeBlocked) { prStatus = 'open'; log.info(`Merge blocked: ${mergeBlocked}`); }
        }

        // Sub-Plan 06 §6: Compute evidence-based completion
        let completionEvidence: CompletionEvidence[] | undefined;
        let salvageBranch: string | undefined;
        if (prStatus === ('merged' as any)) {
            const diffNames = gitExec(worktreeWorkspace, `diff --name-only ${baseRef}..HEAD`);
            const changedFiles = (diffNames && !diffNames.startsWith('Error:'))
                ? diffNames.split('\n').filter(f => f.trim() && !f.startsWith('docs/') && !f.startsWith('.agent/') && !f.startsWith('.conventions/') && !f.endsWith('-mission.md'))
                : [];
            completionEvidence = assignments.map(a => {
                const moduleIds = a.moduleIds ?? [];
                let declaredPresent = 0;
                for (const modId of moduleIds) {
                    if (fs.existsSync(path.join(worktreeWorkspace, modId))) declaredPresent++;
                }
                return { assignmentId: a.id, filesChanged: changedFiles.length, declaredModulesPresent: declaredPresent, declaredModulesTotal: moduleIds.length, gatePassed: gateReport?.passed ?? false, merged: true };
            });
        } else if ((prStatus === 'open' || prStatus === ('blocked' as any)) && outputPath) {
            salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, `PR #${ghPr.number} not merged (status: ${prStatus})`, outputPath);
            salvageBranch = branchName;
        }

        const pullRequest: PullRequest = {
            id: `PR-${ghPr.number}`, prNumber: ghPr.number, prUrl: ghPr.html_url,
            title: prTitle, description: prBody, branchName,
            authorAgentId: assignments[0].devAgentId, reviewerAgentIds,
            reviews: allReviews, status: prStatus, assignmentIds: assignments.map(a => a.id), taskType, currentState,
            ...(integrityFindings.length > 0 ? { integrityFindings } : {}),
        };

        return {
            pullRequest, fileChanges: allFileChanges, artifacts: allArtifacts,
            transcript: allTranscript, tokenUsage: allTokenUsage,
            completionEvidence, salvageBranch,
            phantomFileChanges: allPhantomFileChanges.length > 0 ? allPhantomFileChanges : undefined,
        };
    } finally {
        disposeWorktree(gitRoot, worktreeDir, branchName, wasMerged);
    }
}
