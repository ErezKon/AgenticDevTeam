/**
 * Merge stage of the PR workflow (Plan 30-02).
 *
 * - Fresh evidence: the gate report and integrity findings that reach
 *   `decideMerge()` are produced again whenever HEAD moved after they were
 *   computed — review fixes, escalation and the strong fixer all commit. The
 *   claudeopus5 merge decision used the gate report from before the review.
 * - `decideMerge()` gets the review iterations that actually ran.
 * - Merge guard: the head GitHub would merge must be the local HEAD.
 * - Completion evidence resolves declared module ids through the repo contract.
 * - Each PR gets one `merge` ledger entry with the decision and its blockers.
 *
 * Extracted from orchestrator.ts.
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import { appendLedger } from '../../utils/run-ledger';
import { REVIEW_MERGE_POLICY, REVIEW_QUORUM, GATE_INTEGRITY_MODE } from '../../config';
import { decideMerge, type ReviewOutcome } from '../review-policy';
import type { GateReport } from '../quality-gates';
import type { ConfigBaseline, TamperFinding } from '../gate-integrity';
import type { CompletionEvidence } from '../assignment-policy';
import type {
    Assignment, GitContext, PRReview, PullRequest, RepoContract, TechDecision, TranscriptMessage,
} from '../../agents/_shared/base-schemas';
import { headSha } from './commit';
import { runBranchGates, runIntegrityGate } from './gates';
import { integrateBase } from './merge-ladder';
import { checkPrHeadCurrent, mergePr, postComment, PrIdentityMismatchError } from './pr-github';
import { msg } from './transcript';

const log = getLogger('[PR-Workflow]', 135);

const short = (sha: string): string => (sha ? sha.slice(0, 8) : 'unknown');

// ─── Fresh evidence ─────────────────────────────────────────────────────────

/** Gate evidence and the HEAD each part was produced at ('' = unknown, so always stale). */
export interface MergeEvidence {
    gateReport: GateReport | null;
    gateSha: string;
    integrityFindings: TamperFinding[];
    integritySha: string;
    /** Set when fresh gates could not run — a merge blocker, never a silent pass. */
    refreshError?: string;
}

export interface EvidenceContext {
    worktreeWorkspace: string;
    branchName: string;
    projectSlug: string;
    outputPath?: string;
    gitContext?: GitContext | null;
    /** Config baseline for tamper detection; null when the integrity gate is off. */
    branchBaseline: ConfigBaseline | null;
}

/**
 * Re-run whatever evidence is older than HEAD: the quality gates when HEAD moved
 * after the last gate run, the integrity gate when it moved after the last
 * integrity run. A HEAD that cannot be read counts as moved.
 */
export async function refreshMergeEvidence(ctx: EvidenceContext, evidence: MergeEvidence): Promise<MergeEvidence> {
    const fresh: MergeEvidence = { ...evidence };
    const head = headSha(ctx.worktreeWorkspace);
    if (!head || fresh.gateSha !== head) {
        log.info(`HEAD moved since the last gate run (${short(fresh.gateSha)} → ${short(head)}) — re-running the quality gates before the merge decision`);
        try {
            fresh.gateReport = await runBranchGates(ctx.worktreeWorkspace);
            fresh.gateSha = head;
        } catch (err: any) {
            log.error(`Quality gates could not be re-run on ${short(head)}: ${err.message}`);
            fresh.refreshError = `Quality gates could not be re-run on HEAD ${short(head)}: ${err.message}`;
        }
    }
    if (ctx.branchBaseline && (!head || fresh.integritySha !== head)) {
        const integrity = await runIntegrityGate(
            ctx.worktreeWorkspace, ctx.branchBaseline, ctx.branchName, ctx.projectSlug,
            fresh.gateReport, ctx.outputPath, ctx.gitContext,
        );
        fresh.integrityFindings = integrity.integrityFindings;
        fresh.gateReport = integrity.gateReport;
        // An enforce-mode revert commits and re-runs the gates, so both describe the new HEAD.
        fresh.integritySha = headSha(ctx.worktreeWorkspace);
        if (!fresh.refreshError) fresh.gateSha = fresh.integritySha;
    }
    return fresh;
}

// ─── Completion evidence (Sub-Plan 06 §6) ───────────────────────────────────

/** Workspace-relative paths that count as delivered source, not docs or pipeline metadata. */
function isDeliveredSource(file: string): boolean {
    return !!file.trim() && !file.startsWith('docs/') && !file.startsWith('.agent/')
        && !file.startsWith('.conventions/') && !file.endsWith('-mission.md');
}

/**
 * Evidence for merged assignments. Plan 30-02: declared module ids are resolved
 * to paths through `repoContract.modules`. They used to be checked as file
 * paths, so the module check was always 0/N; when the contract does not know
 * an id the check is now "n/a" (total 0, the ids in `unresolvedModuleIds`).
 */
export function computeCompletionEvidence(
    worktreeWorkspace: string,
    baseRef: string,
    assignments: Assignment[],
    gateReport: GateReport | null,
    repoContract?: RepoContract | null,
): CompletionEvidence[] {
    const diff = gitExec(worktreeWorkspace, `diff --name-only --relative ${baseRef}..HEAD`);
    const changedFiles = diff.startsWith('Error:') ? [] : diff.split('\n').filter(isDeliveredSource);
    const modulePaths = new Map((repoContract?.modules ?? []).map(m => [m.id, m.path] as const));
    return assignments.map(a => {
        const moduleIds = a.moduleIds ?? [];
        const unresolved = moduleIds.filter(id => !modulePaths.has(id));
        const checked = unresolved.length > 0 ? [] : moduleIds;
        return {
            assignmentId: a.id,
            filesChanged: changedFiles.length,
            declaredModulesPresent: checked.filter(id => fs.existsSync(path.join(worktreeWorkspace, modulePaths.get(id)!))).length,
            declaredModulesTotal: checked.length,
            ...(unresolved.length > 0 ? { unresolvedModuleIds: unresolved } : {}),
            gatePassed: gateReport?.passed ?? false,
            merged: true,
        };
    });
}

// ─── Merge stage ────────────────────────────────────────────────────────────

export interface MergeStageInput {
    octokit: any;
    ghOwner: string;
    ghRepo: string;
    pr: { number: number; head?: { ref: string } };
    evidenceCtx: EvidenceContext;
    evidence: MergeEvidence;
    /** Outcome of review, escalation and strong fixer. */
    reviewStatus: 'open' | 'approved';
    allReviews: PRReview[];
    allOutcomes: ReviewOutcome[];
    /** Review iterations that actually ran. */
    iterationsUsed: number;
    secretsBlockMerge: boolean;
    baseRef: string;
    baseBranch: string;
    primaryStoryId: string;
    /** The assignments the PR claims (executed ones). */
    assignments: Assignment[];
    contextPrompt: string;
    apiKey: string;
    techStack?: TechDecision[];
    isMaintainMode?: boolean;
    respawnCtx: { worktreeDir: string; baseRef: string };
    repoContract?: RepoContract | null;
    transcript: TranscriptMessage[];
}

export interface MergeStageResult {
    prStatus: PullRequest['status'];
    merged: boolean;
    evidence: MergeEvidence;
    completionEvidence?: CompletionEvidence[];
    /** Why the PR did not merge (empty when merged) — recorded on the PR (Plan 30-03). */
    blockers: string[];
}

/** Block the PR: status, event, transcript and a PR comment. */
async function block(input: MergeStageInput, blockers: string[], when: string): Promise<void> {
    log.warn(`PR #${input.pr.number} blocked${when}: ${blockers.join(' | ')}`);
    emitRunEvent('pr:blocked', { prNumber: input.pr.number, blockers });
    input.transcript.push(msg('conductor', `PR #${input.pr.number} BLOCKED${when}: ${blockers.join('; ')}`));
    await postComment(input.octokit, input.ghOwner, input.ghRepo, input.pr.number,
        `:x: **[BLOCKED]** This PR cannot be merged.\n\n${blockers.map(b => `- ${b}`).join('\n')}`);
}

/**
 * Decide on fresh evidence, then (when approved) integrate the base, check the
 * merge blockers and the remote head, and merge.
 */
export async function runMergeStage(input: MergeStageInput): Promise<MergeStageResult> {
    const { evidenceCtx: ctx, transcript } = input;
    const { worktreeWorkspace, branchName } = ctx;
    const prNumber = input.pr.number;
    const evidence = await refreshMergeEvidence(ctx, input.evidence);
    let prStatus: PullRequest['status'] = input.reviewStatus;
    let merged = false;

    const blockingComments = input.allReviews.flatMap(r => r.comments)
        .filter(c => !c.resolved && (c.severity === 'critical' || c.severity === 'major'));
    const diffNames = gitExec(worktreeWorkspace, `diff --name-only ${input.baseRef}...HEAD`);
    const filesChanged = diffNames.startsWith('Error:') ? 0 : diffNames.split('\n').filter(f => f.trim()).length;
    const unmetCriteriaCount = input.allOutcomes
        .filter((o: ReviewOutcome): o is Extract<ReviewOutcome, { kind: 'approved' | 'changes_requested' }> => o.kind !== 'abstained')
        .reduce((sum, o) => sum + (o.output.criteriaVerdicts ?? []).filter(v => !v.met).length, 0);
    const decision = decideMerge({
        approvals: input.allOutcomes.filter(o => o.kind === 'approved').length,
        blockingComments,
        abstentions: input.allOutcomes.filter(o => o.kind === 'abstained').length,
        gateReport: evidence.gateReport, integrityFindings: evidence.integrityFindings,
        filesChanged, iterationsUsed: input.iterationsUsed,
        policy: REVIEW_MERGE_POLICY, quorum: REVIEW_QUORUM, unmetCriteriaCount,
    });
    const blockers = [...decision.blockers, ...(evidence.refreshError ? [evidence.refreshError] : [])];

    if (blockers.length > 0 && REVIEW_MERGE_POLICY !== 'legacy') {
        prStatus = 'blocked';
        await block(input, blockers, '');
    }

    if (prStatus === 'approved' || (prStatus === 'open' && REVIEW_MERGE_POLICY === 'legacy')) {
        if (prStatus === 'open') {
            log.warn(`Max review iterations reached. Merging PR #${prNumber} despite pending reviews (legacy policy).`);
            transcript.push(msg('conductor', `WARNING: Max review iterations reached, merging anyway (legacy policy)`));
        }

        // Integrate base changes
        const integration = await integrateBase(
            worktreeWorkspace, branchName, input.baseBranch, ctx.projectSlug, input.primaryStoryId,
            input.assignments, input.contextPrompt, input.apiKey, ctx.gitContext, input.techStack, input.isMaintainMode, input.respawnCtx,
        );

        // Merge blockers
        let mergeBlocked: string | null = null;
        const lsRemote = gitExec(worktreeWorkspace, `ls-remote --heads origin ${branchName}`);
        if (!lsRemote || lsRemote.startsWith('Error:')) mergeBlocked = 'branch not on remote';
        if (input.secretsBlockMerge) {
            mergeBlocked = 'critical secrets detected';
            transcript.push(msg('security-gates', `Merge blocked for PR #${prNumber}: critical secrets detected`));
            await postComment(input.octokit, input.ghOwner, input.ghRepo, prNumber, ':x: **Merge blocked by security gate** — critical secrets detected in this PR. Remove hard-coded credentials before merging.');
        }
        const criticalIntegrity = evidence.integrityFindings.filter(f => f.severity === 'critical');
        if (criticalIntegrity.length > 0 && GATE_INTEGRITY_MODE === 'enforce') mergeBlocked = `${criticalIntegrity.length} critical integrity finding(s)`;
        const prHeadRef = input.pr.head?.ref;
        if (!mergeBlocked && prHeadRef && prHeadRef !== branchName) {
            const err = new PrIdentityMismatchError(prNumber, branchName, prHeadRef);
            log.error(err.message); transcript.push(msg('conductor', err.message)); mergeBlocked = err.message;
        }
        // Plan 30-02 merge guard: never merge a head other than the one that was gated and reviewed.
        if (!mergeBlocked && integration.resolved) {
            mergeBlocked = await checkPrHeadCurrent(input.octokit, input.ghOwner, input.ghRepo, prNumber, headSha(worktreeWorkspace));
            if (mergeBlocked) log.error(mergeBlocked);
        }

        if (!integration.resolved) {
            // Plan 30-05: 'blocked' like every other merge blocker. It stayed 'open' only because
            // the old runaway rule matched open PRs against merge-conflict transcript lines.
            prStatus = 'blocked';
            const conflict = `unresolvable merge conflicts with ${input.baseBranch}`;
            blockers.push(conflict);
            await block(input, [conflict], ' at merge');
        } else if (mergeBlocked) {
            prStatus = 'blocked';
            blockers.push(mergeBlocked);
            await block(input, [mergeBlocked], ' at merge');
        } else if (await mergePr(input.octokit, input.ghOwner, input.ghRepo, input.pr, branchName, input.baseBranch)) {
            prStatus = 'merged';
            merged = true;
            transcript.push(msg('conductor', `PR #${prNumber} merged to ${input.baseBranch}`));
        } else {
            prStatus = 'open';
            blockers.push(`the merge into ${input.baseBranch} failed`);
            transcript.push(msg('conductor', `Merge failed`));
        }
    }

    appendLedger({
        kind: 'merge', prNumber, decision: merged,
        reason: merged ? 'merged' : (blockers.join(' | ') || `not merged (status: ${prStatus})`), blockers,
    });
    const completionEvidence = merged
        ? computeCompletionEvidence(worktreeWorkspace, input.baseRef, input.assignments, evidence.gateReport, input.repoContract)
        : undefined;
    return { prStatus, merged, evidence, completionEvidence, blockers: merged ? [] : blockers };
}
