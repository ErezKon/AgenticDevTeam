/**
 * Developer Dispatcher — runs a dispatch plan through the PR workflow.
 *
 * `buildDispatchPlan()` (dispatch-plan.ts) decides branches, kinds and order;
 * this module executes it layer by layer. A branch starts only after every
 * branch it depends on has finished. Scaffold and bootstrap branches run one at
 * a time and the main checkout is synced to the system branch after each of
 * their merges; same-layer branches that own a common module are serialised;
 * the rest run in batches of MAX_CONCURRENT_DEVS (1 under SEQUENTIAL_DISPATCH).
 *
 * When a branch does not merge, DISPATCH_HALT_POLICY decides what happens:
 * `dependents` (default) skips only the branches that wait for it, `strict`
 * halts, `scaffold-only` halts only for the scaffold, `off` carries on.
 */
import {
    MAX_CONCURRENT_DEVS, INTER_BATCH_DELAY_MS, MAX_BRANCH_WALL_MS, MAX_BRANCHES,
    SEQUENTIAL_DISPATCH, DISPATCH_HALT_POLICY,
} from '../../config';
import { getLogger } from '../../utils/logger';
import { executePRWorkflow } from '../../conductor/pr-workflow';
import type { PRWorkflowResult } from '../../conductor/pr-workflow';
import { completedIdsFromPullRequests, ABANDON_AFTER_UNMERGED_ROUNDS } from '../../conductor/assignment-policy';
import type { CompletionEvidence } from '../../conductor/assignment-policy';
import { syncWorkspaceToBranch } from '../../conductor/workspace-sync';
import { classifyProviderFailure, isProviderLevelFailure } from '../../conductor/provider-failure';
import { getEffectiveLimits, getBudgetStatus } from '../../utils/run-budget';
import { findGitRoot } from '../../utils/git-exec';
import { awaitProviderRecovery, createProviderProbe } from '../../utils/llm-throttle';
import { emitRunEvent } from '../../utils/event-bus';
import { appendLedger } from '../../utils/run-ledger';
import { withTraceContext } from '../../utils/debug-trace';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import {
    buildDispatchPlan, onBranchNotMerged, serialiseOverlaps, summariseDispatchPlan, describeBrokenEdge,
} from './dispatch-plan';
import type { DispatchPlan } from './dispatch-plan';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage, PhaseName, PullRequest,
    GitContext, TechDecision, UserStory, Task, RepoContract,
} from '../_shared/base-schemas';
import { tokenTracker, withTokenAttribution, type TokenCallRecord } from '../../utils/token-tracker';

const log = getLogger('[Dispatcher]', 226);

/**
 * Why a dispatch round stopped before every runnable branch was attempted.
 * Plan 30-01: replaces the `prCreationFailed` flag, which the halt policy also
 * set — so a halted round was logged as "PR creation failed".
 */
export type DispatchStopReason = 'pr-creation-failed' | 'halt-policy' | 'budget' | `provider-${string}` | null;

export interface DispatchResult {
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
    pullRequests: PullRequest[];
    tokenUsage: TokenCallRecord[];
    completedAssignmentIds: string[];
    /** Evidence of assignment completion with real file changes (Sub-Plan 06 §6). */
    completionEvidence: CompletionEvidence[];
    /** Branches salvaged (failed to merge but patches exported). */
    salvageBranches: string[];
    /** Branches not admitted because they cannot plausibly finish within remaining run wall time (Plan 24, D3). */
    branchesDeferred: number;
    /** Assignments a branch never started because its branch budget ran out (Plan 30-02) — still pending. */
    deferredAssignmentIds: string[];
    /** Why dispatch stopped early; null when every runnable branch was attempted.
     *  `provider-<kind>`: a provider-level failure (billing, auth, quota) could not be recovered —
     *  the run should stop gracefully and write a snapshot for continue-run. */
    stopReason: DispatchStopReason;
}

// ─── Plan 24 D3: wall-clock-aware admission control ─────────────────────────

/** Default estimated branch duration (ms) when no branches have completed yet. */
const DEFAULT_BRANCH_ESTIMATE_MS = 180_000; // 3 minutes

/** Compute the median of a sorted numeric array. Returns 0 for empty arrays. */
function median(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

// ─── Plan observability (Plan 30-01) ────────────────────────────────────────

/** Log the plan, emit `dispatch:plan` and append the `dispatch-plan` ledger entry. */
function recordPlan(plan: DispatchPlan, assignmentCount: number, note: (message: string) => void): void {
    log.info(`Dispatch plan: ${plan.branches.size} branch(es) from ${assignmentCount} assignment(s) in ${plan.layers.length} layer(s) — order: ${plan.branchOrder.join(' → ') || 'none'}`);
    for (const name of plan.branchOrder) {
        const b = plan.branches.get(name)!;
        log.info(`  ${name} — ${b.reason}; ${b.assignments.length} assignment(s) [${b.assignments.map(a => a.id).join(', ')}]; waits for: ${b.dependsOnBranches.join(', ') || 'nothing'}`);
    }
    if (plan.branches.size > MAX_BRANCHES) {
        log.warn(`High branch count (${plan.branches.size} > MAX_BRANCHES=${MAX_BRANCHES}) — consider merging closely-related stories onto fewer branches`);
    }
    for (const warning of plan.warnings) log.warn(warning);
    for (const edge of plan.brokenEdges) {
        const text = describeBrokenEdge(edge);
        if (edge.level === 'assignment') log.error(text);
        else log.warn(text);
        note(text);
    }
    const summary = summariseDispatchPlan(plan);
    emitRunEvent('dispatch:plan', summary);
    appendLedger({ kind: 'dispatch-plan', ...summary });
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Dispatch all assignments to developer agents via the PR workflow.
 *
 * Each planned branch goes through: worktree → dev work → gates → PR → review → merge.
 *
 * @param apiKey       LLM token
 * @param assignments  Pending assignments (already-merged ones are excluded by the caller)
 * @param workspacePath Generated project workspace path
 * @param contextPrompt Context string (architecture, tech stack, DB design summary)
 * @param techStack    Architect's tech stack decisions (for convention file resolution)
 * @param repoContract Repo contract — completion evidence resolves module ids through it (Plan 30-02)
 * @param abandonedBranches Branches unmerged in consecutive rounds (Plan 30-05) — neither they nor
 *                     the branches waiting for them are dispatched
 */
export async function dispatchDevelopers(
    apiKey: string,
    assignments: Assignment[],
    workspacePath: string,
    contextPrompt: string,
    baseBranch: string,
    projectSlug: string,
    gitContext?: GitContext | null,
    techStack?: TechDecision[],
    completedAssignmentIds?: string[],
    userStories?: UserStory[],
    isMaintainMode?: boolean,
    outputPath?: string,
    tasks?: Task[],
    repoContract?: RepoContract | null,
    abandonedBranches: string[] = [],
): Promise<DispatchResult> {
    const fileChanges: FileChange[] = [];
    const artifacts: ArtifactRef[] = [];
    const transcript: TranscriptMessage[] = [];
    const pullRequests: PullRequest[] = [];
    const tokenUsage: TokenCallRecord[] = [];
    const newlyCompletedIds: string[] = [];
    const allCompletionEvidence: CompletionEvidence[] = [];
    const allSalvageBranches: string[] = [];
    const deferredAssignmentIds: string[] = [];
    const note = (message: string): void => {
        transcript.push({ timestamp: new Date().toISOString(), agentId: 'dispatcher', phase: 'development' as PhaseName, message });
    };

    // The first stop wins, except that a provider stop replaces any other: the run itself must end.
    // Everything not yet started is left pending.
    const stopped: { reason: DispatchStopReason; detail: string } = { reason: null, detail: '' };
    const stop = (reason: NonNullable<DispatchStopReason>, detail: string): void => {
        if (stopped.reason && (stopped.reason.startsWith('provider-') || !reason.startsWith('provider-'))) return;
        stopped.reason = reason;
        stopped.detail = detail;
    };

    // Plan 25: set when a provider-level failure cannot be recovered
    let providerFailureKind: string | null = null;

    // Plan 24 D3: wall-clock-aware admission control
    let branchesDeferred = 0;
    const completedBranchDurationsMs: number[] = [];

    const plan = buildDispatchPlan(assignments, { projectSlug, preSatisfied: completedAssignmentIds ?? [] });
    recordPlan(plan, assignments.length, note);

    /** branch → merged?, for every branch that finished (or was not admitted) this round. */
    const finished = new Map<string, boolean>();
    /** Branches not started because a branch they wait for did not merge. */
    const skipped = new Set<string>();
    // Plan 26, A5 — reachable only under DISPATCH_HALT_POLICY=off: later branches are
    // cut from a failed scaffold's tip (createBranchWorktree resolves it to origin/<scaffold>).
    let scaffoldFallbackRef: string | undefined;
    // Plan 27-B: force sequential dispatch when configured
    const effectiveConcurrency = SEQUENTIAL_DISPATCH ? 1 : MAX_CONCURRENT_DEVS;

    const skipDependents = (branch: string, dependents: string[], why: string): void => {
        const fresh = dependents.filter(b => !skipped.has(b) && !finished.has(b));
        if (fresh.length === 0) return;
        for (const b of fresh) skipped.add(b);
        const text = `Branch "${branch}" ${why} — skipping ${fresh.length} dependent branch(es) this round (their assignments stay pending): ${fresh.join(', ')}`;
        log.warn(text);
        note(text);
        emitRunEvent('dispatch:skipped-dependents', { branchName: branch, reason: why, dependents: fresh });
    };

    /** A branch ran and did not merge (or its workflow crashed): apply DISPATCH_HALT_POLICY. */
    const branchFailed = (branch: string, status: string): void => {
        finished.set(branch, false);
        tokenTracker.recordBranchOutcome(branch, status);   // Plan 30-06: the report's unmerged-branch tokens
        const { halt, skip } = onBranchNotMerged(plan, branch, DISPATCH_HALT_POLICY);
        if (halt) {
            log.error(`Branch "${branch}" failed (status: ${status}) — halting dispatch per DISPATCH_HALT_POLICY=${DISPATCH_HALT_POLICY}`);
            emitRunEvent('dispatch:halted', { branchName: branch, status, policy: DISPATCH_HALT_POLICY });
            stop('halt-policy', `branch "${branch}" did not merge (status: ${status}) and DISPATCH_HALT_POLICY=${DISPATCH_HALT_POLICY}`);
            return;
        }
        skipDependents(branch, skip, `did not merge (status: ${status})`);
        if (plan.branches.get(branch)!.kind === 'scaffold' && DISPATCH_HALT_POLICY === 'off') {
            scaffoldFallbackRef = branch;
            const text = `Scaffold branch ${branch} failed to merge — later branches are cut from origin/${branch} (DISPATCH_HALT_POLICY=off)`;
            log.error(text);
            note(text);
        }
    };

    /** A branch never really ran (not admitted for run wall time, or a recovered provider failure). */
    const branchNotAttempted = (branch: string, why: string): void => {
        finished.set(branch, false);
        tokenTracker.recordBranchOutcome(branch, 'not-attempted');
        if (DISPATCH_HALT_POLICY === 'dependents') skipDependents(branch, onBranchNotMerged(plan, branch, 'dependents').skip, why);
    };

    const onFulfilled = (branch: string, prResult: PRWorkflowResult): void => {
        fileChanges.push(...prResult.fileChanges);
        artifacts.push(...prResult.artifacts);
        transcript.push(...prResult.transcript);
        pullRequests.push(prResult.pullRequest);
        if (prResult.tokenUsage) tokenUsage.push(...prResult.tokenUsage);
        newlyCompletedIds.push(...completedIdsFromPullRequests([prResult.pullRequest]));
        if (prResult.completionEvidence) allCompletionEvidence.push(...prResult.completionEvidence);
        if (prResult.salvageBranch) allSalvageBranches.push(prResult.salvageBranch);
        if (prResult.deferredAssignmentIds) deferredAssignmentIds.push(...prResult.deferredAssignmentIds);

        const status = prResult.pullRequest.status;
        if (status === 'merged') {
            finished.set(branch, true);
            tokenTracker.recordBranchOutcome(branch, status);
        } else if (status === 'pr-creation-failed') {
            // Plan 24: stop gracefully — the branch is pushed, continue-run retries just the PR creation.
            finished.set(branch, false);
            tokenTracker.recordBranchOutcome(branch, status);
            stop('pr-creation-failed', `PR creation failed for ${branch} — use continue-run to retry`);
        } else {
            // Plan 30-02: a 'deferred' branch is not merged either — its dependents wait for the next round.
            // A placeholder record's title names why (e.g. "[PUSH-REJECTED] …", "[GATES-FAILED] …").
            const pr = prResult.pullRequest;
            branchFailed(branch, pr.prNumber === 0 ? `${status} — ${pr.title}` : status);
        }
    };

    const onRejected = async (branch: string, reason: unknown): Promise<void> => {
        // Plan 24, A3: provider-level errors (billing, auth, quota) do not consume the branch's attempt.
        const classification = classifyProviderFailure(reason);
        if (!isProviderLevelFailure(classification)) {
            log.error(`PR workflow failed for "${branch}": ${reason}`);
            note(`PR workflow failed for ${branch}: ${reason}`);
            branchFailed(branch, 'workflow-error');
            return;
        }
        log.error(`Provider failure (${classification.kind}): ${classification.message} — branch not counted as attempted`);
        emitRunEvent('run:paused', { kind: classification.kind, message: classification.message });
        note(`Provider failure (${classification.kind}): branch assignments remain pending — ${classification.message}`);
        if (classification.fatal) {
            // Plan 25: fatal provider errors (auth) stop immediately
            providerFailureKind = classification.kind;
            emitRunEvent('run:provider-stop', { kind: classification.kind, message: classification.message });
            log.error(`Fatal provider error (${classification.kind}) — stopping dispatch for graceful shutdown`);
        } else if (classification.pauseable && !(await awaitProviderRecovery(createProviderProbe()))) {
            // Plan 25: a real probe actively checks the provider; recovery failed — stop gracefully
            providerFailureKind = classification.kind;
            emitRunEvent('run:provider-stop', { kind: classification.kind, message: classification.message, recoveryFailed: true });
            log.error(`Provider recovery failed (${classification.kind}) — stopping dispatch for graceful shutdown`);
        }
        if (providerFailureKind) stop(`provider-${providerFailureKind}`, `provider failure (${providerFailureKind}) could not be recovered`);
        else branchNotAttempted(branch, `hit a recoverable provider failure (${classification.kind})`);
    };

    const runBranch = (branchName: string): Promise<PRWorkflowResult> => {
        const branch = plan.branches.get(branchName)!;
        const base = branch.kind !== 'scaffold' && scaffoldFallbackRef ? scaffoldFallbackRef : baseBranch;
        log.info(`Branch "${branchName}" [${branch.kind}]: ${branch.assignments.length} assignment(s) `
            + `[${branch.assignments.map(a => a.id).join(', ')}], ${branch.reviewerAgentIds.length} reviewer(s), type=${branch.taskType}`
            + (base !== baseBranch ? `, base=${base} (scaffold fallback)` : ''));
        // Plan 30-06: the branch's invocations are attributed to it in the token report
        return withTokenAttribution({ branch: branchName }, () => withTraceContext({ branch: branchName }, () => executePRWorkflow({
            branchName,
            baseBranch: base,
            assignments: branch.assignments,
            reviewerAgentIds: branch.reviewerAgentIds,
            taskType: branch.taskType,
            workspacePath,
            apiKey,
            contextPrompt,
            projectSlug,
            gitContext,
            techStack,
            userStories,
            tasks,
            isMaintainMode,
            outputPath,
            repoContract,
        })));
    };

    /** Plan 24 D3: defer a batch that cannot plausibly finish in the remaining run wall time. */
    const admit = (batch: string[]): string[] => {
        const { maxWallMs, elapsedMs } = getBudgetStatus();
        if (maxWallMs <= 0) return batch;
        const remainingWallMs = maxWallMs - elapsedMs;
        const estimateMs = completedBranchDurationsMs.length > 0
            ? median([...completedBranchDurationsMs].sort((a, b) => a - b))
            : DEFAULT_BRANCH_ESTIMATE_MS;
        // Also respect per-branch wall cap as an estimate floor
        const effectiveEstimate = MAX_BRANCH_WALL_MS > 0 ? Math.min(estimateMs, MAX_BRANCH_WALL_MS) : estimateMs;
        if (remainingWallMs >= effectiveEstimate) return batch;
        for (const b of batch) {
            branchesDeferred++;
            const text = `Branch "${b}" not admitted: insufficient run wall time (${(remainingWallMs / 1000).toFixed(0)}s remaining, ~${(effectiveEstimate / 1000).toFixed(0)}s needed)`;
            log.warn(text);
            note(text);
            branchNotAttempted(b, 'was not admitted (insufficient run wall time)');
        }
        return [];
    };

    const runBranches = async (branches: string[]): Promise<void> => {
        for (let j = 0; j < branches.length && !stopped.reason; j += effectiveConcurrency) {
            if (!getEffectiveLimits().allowNewBranchWorkflows) {
                stop('budget', 'run budget exhausted');
                break;
            }
            const batch = admit(branches.slice(j, j + effectiveConcurrency));
            if (batch.length === 0) continue;

            const batchStartMs = Date.now();
            const results = await Promise.allSettled(batch.map(b => runBranch(b)));
            // Record batch duration for future admission estimates
            completedBranchDurationsMs.push(Date.now() - batchStartMs);
            for (const [k, r] of results.entries()) {
                if (r.status === 'fulfilled') onFulfilled(batch[k], r.value);
                else await onRejected(batch[k], r.reason);
            }

            // Plan 27-F: periodic state snapshot after each batch of branch results
            if (outputPath) {
                writePeriodicSnapshot(outputPath, {
                    phase: 'development',
                    pullRequests,
                    fileChanges,
                    completedAssignmentIds: newlyCompletedIds,
                }, 'development');
            }

            if (!stopped.reason && j + effectiveConcurrency < branches.length && INTER_BATCH_DELAY_MS > 0) {
                log.info(`Waiting ${INTER_BATCH_DELAY_MS}ms before next batch...`);
                await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
            }
        }
    };

    /** After a scaffold/bootstrap merge: sync the main checkout to the system branch — never to a feature branch. */
    const syncAfterMerge = async (branch: string): Promise<void> => {
        let gitRoot: string;
        try {
            gitRoot = findGitRoot(workspacePath);
        } catch (err: any) {
            const text = `Workspace sync after merging ${branch} skipped: ${err.message}`;
            log.error(text);
            note(text);
            return;
        }
        const sync = await syncWorkspaceToBranch(gitRoot, baseBranch, gitContext);
        if (sync.ok) {
            log.info(`Workspace synced to ${baseBranch} after merging ${branch}: ${sync.details}`);
            return;
        }
        const text = `Workspace sync to ${baseBranch} after merging ${branch} FAILED: ${sync.details} — later worktrees are still cut from origin/${baseBranch}`;
        log.error(text);
        note(text);
    };

    // Plan 30-05: an abandoned branch is not dispatched again, and neither is any branch waiting for it.
    for (const b of abandonedBranches) {
        if (!plan.branches.has(b) || skipped.has(b)) continue;
        skipped.add(b);
        const text = `Branch "${b}" is abandoned (unmerged in ${ABANDON_AFTER_UNMERGED_ROUNDS}+ consecutive rounds) — not dispatched; its assignments stay pending`;
        log.warn(text);
        note(text);
        skipDependents(b, onBranchNotMerged(plan, b, 'dependents').skip, 'is abandoned');
    }

    for (const [i, layer] of plan.layers.entries()) {
        if (stopped.reason) break;
        const runnable = layer.filter(b => !skipped.has(b));
        if (runnable.length === 0) continue;
        const barriers = runnable.filter(b => ['scaffold', 'bootstrap'].includes(plan.branches.get(b)!.kind));
        const { chains, parallel } = serialiseOverlaps(plan, runnable.filter(b => !barriers.includes(b)));
        log.info(`Dispatch layer ${i + 1}/${plan.layers.length}: `
            + runnable.map(b => `${b} [${plan.branches.get(b)!.kind}]`).join(', ')
            + (chains.length > 0 ? ` — ${chains.length} serialised chain(s)` : ''));

        // Scaffold and bootstrap branches run one at a time; the main checkout follows each merge.
        for (const b of barriers) {
            await runBranches([b]);
            if (finished.get(b)) await syncAfterMerge(b);
        }
        // Sub-Plan 06 §5b: same-layer branches that own a common module run one after the other.
        for (const chain of chains) {
            log.info(`Serialising ${chain.length} overlapping branches: ${chain.join(', ')}`);
            for (const b of chain) await runBranches([b]);
        }
        await runBranches(parallel);
    }

    // Merged vs skipped matters: a `PR-SKIPPED-*` placeholder is recorded for every
    // branch whose dev agent produced no commits, so a raw PR count can read "16 PRs"
    // for a round that delivered nothing at all (Plan 21, E3).
    const mergedPrs = pullRequests.filter(pr => pr.status === 'merged').length;
    const skippedPrs = pullRequests.filter(pr => pr.id.startsWith('PR-SKIPPED-')).length;
    const failedPrCreation = pullRequests.filter(pr => pr.status === 'pr-creation-failed').length;
    const deferredBranches = pullRequests.filter(pr => pr.status === 'deferred').length;
    log.info(
        `Dispatch complete: ${fileChanges.length} total file changes, ${pullRequests.length} PRs `
        + `(${mergedPrs} merged, ${skippedPrs} skipped`
        + (failedPrCreation > 0 ? `, ${failedPrCreation} pr-creation-failed` : '')
        + (deferredBranches > 0 ? `, ${deferredBranches} deferred` : '')
        + `), ${artifacts.length} artifacts, `
        + `${newlyCompletedIds.length} completed assignments`
        + (deferredAssignmentIds.length > 0 ? `, ${deferredAssignmentIds.length} assignment(s) deferred to the next round (branch budget)` : '')
        + (branchesDeferred > 0 ? `, ${branchesDeferred} branch(es) not admitted (run wall time)` : '')
        + (skipped.size > 0 ? `, ${skipped.size} branch(es) skipped (abandoned, or waiting for an unmerged branch)` : ''),
    );

    if (stopped.reason) {
        const notDispatched = plan.branchOrder.filter(b => !finished.has(b) && !skipped.has(b));
        const text = `Dispatch stopped early [${stopped.reason}]: ${stopped.detail}`
            + (notDispatched.length > 0 ? ` — ${notDispatched.length} branch(es) not dispatched: ${notDispatched.join(', ')}` : '');
        log.error(text);
        note(text);
    }

    // Systemic failure: every branch in the round produced nothing. Individually these
    // surface only as per-branch WARNs, which is how 34 identical provider 400s scrolled
    // past unnoticed. Escalate to ERROR + transcript so runaway detection can halt.
    const allEmpty = pullRequests.length > 0 && mergedPrs === 0 && fileChanges.length === 0;
    if (allEmpty) {
        log.error(`ALL ${pullRequests.length} branch(es) in this dispatch round produced zero commits and zero merged PRs — developer agents are systemically failing (check provider errors above)`);
        note(`Zero-output dispatch round: ${pullRequests.length} branch(es), 0 merged PRs, 0 file changes`);
    }

    return {
        fileChanges, artifacts, transcript, pullRequests, tokenUsage,
        completedAssignmentIds: newlyCompletedIds,
        completionEvidence: allCompletionEvidence,
        salvageBranches: allSalvageBranches,
        branchesDeferred,
        deferredAssignmentIds,
        stopReason: stopped.reason,
    };
}
