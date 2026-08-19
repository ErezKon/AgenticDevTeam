/**
 * Developer Dispatcher — fans out assignments to developer agents.
 *
 * Groups assignments by devAgentId, respects dependency ordering,
 * and runs up to MAX_CONCURRENT_DEVS agents in parallel.
 *
 * Sub-Plan 06: scaffold barrier ensures the scaffold branch merges first,
 * implicit scaffold dependencies are injected, and overlapping module
 * owners are serialised instead of batched.
 */
import { MAX_CONCURRENT_DEVS, INTER_BATCH_DELAY_MS, MAX_BRANCH_WALL_MS, SEQUENTIAL_DISPATCH, DISPATCH_HALT_POLICY } from '../../config';
import { slugify, featureBranch } from '../../utils/branch-naming';
import { getLogger } from '../../utils/logger';
import { executePRWorkflow } from '../../conductor/pr-workflow';
import { completedIdsFromPullRequests } from '../../conductor/assignment-policy';
import type { CompletionEvidence } from '../../conductor/assignment-policy';
import { getEffectiveLimits, getBudgetStatus } from '../../utils/run-budget';
import { getDevAgent } from './registry';
import { gitExec, assertValidRef } from '../../utils/git-exec';
import { classifyProviderFailure, isProviderLevelFailure } from '../../conductor/provider-failure';
import { awaitProviderRecovery, createProviderProbe } from '../../utils/llm-throttle';
import { emitRunEvent } from '../../utils/event-bus';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import type { Assignment, FileChange, ArtifactRef, TranscriptMessage, PhaseName, PullRequest, GitContext, TechDecision, UserStory, Task } from '../_shared/base-schemas';
import type { TokenCallRecord } from '../../utils/token-tracker';

const log = getLogger('[Dispatcher]', 226);

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
    /** Branches deferred because they cannot plausibly finish within remaining wall time (Plan 24, D3). */
    branchesDeferred: number;
    /** Set when a provider-level failure (billing, auth, quota) could not be recovered.
     *  The run should stop gracefully and write a snapshot for continue-run. */
    providerFailureKind: string | null;
}

/**
 * Topological sort on assignments by dependsOn.
 * Returns assignments in execution order (groups of independent assignments).
 *
 * `preSatisfied` seeds the completed set so dependencies on already-merged
 * work are treated as resolved rather than triggering the "cyclic" fallback.
 */
export function topoSort(
    assignments: Assignment[],
    preSatisfied: Set<string> = new Set(),
): Assignment[][] {
    const map = new Map<string, Assignment>();
    for (const a of assignments) map.set(a.id, a);

    // Detect and warn about dangling dependsOn ids (P10): treat them as pre-satisfied
    // rather than collapsing all layers into one parallel batch.
    const allIds = new Set([...map.keys(), ...preSatisfied]);
    for (const a of assignments) {
        for (const dep of a.dependsOn) {
            if (!allIds.has(dep)) {
                log.warn(`Assignment ${a.id} dependsOn non-existent id "${dep}" — treating as pre-satisfied`);
                preSatisfied.add(dep);
            }
        }
    }

    const completed = new Set<string>(preSatisfied);
    const layers: Assignment[][] = [];

    while (assignments.filter(a => !completed.has(a.id)).length > 0) {
        const ready = assignments.filter(
            a => !completed.has(a.id) &&
                a.dependsOn.every(dep => completed.has(dep))
        );
        if (ready.length === 0) {
            // Remaining are cyclic — just push them all
            const remaining = assignments.filter(a => !completed.has(a.id));
            log.warn(`topoSort: ${remaining.length} assignment(s) have cyclic dependencies — dispatching in one parallel batch`);
            layers.push(remaining);
            break;
        }
        layers.push(ready);
        for (const a of ready) completed.add(a.id);
    }
    return layers;
}

/**
 * Canonical branch name for an assignment.
 *
 * Enforces "one branch per user story": all assignments carrying the same
 * storyId collapse onto the branch name chosen by the FIRST assignment for
 * that story (or a derived name if the Team Leader supplied none). Run 6
 * produced 26 branches for 8 stories, which caused 19 PRs, ~5k LLM calls and
 * repeated merge conflicts.
 */
export function canonicalBranchName(
    a: Assignment,
    projectSlug: string,
    storyBranches: Map<string, string>,
): string {
    const storyKey = a.storyId ?? a.id;
    const existing = storyBranches.get(storyKey);
    if (existing) return existing;

    let branch = a.branchName ?? featureBranch(projectSlug, storyKey, a.description);
    if (!branch.startsWith(`${projectSlug}/`)) branch = `${projectSlug}/${branch}`;
    // Sanitize the entire branch name to prevent command injection via LLM-controlled
    // branchName or storyId values (Plan 25-02, A4).
    branch = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-').replace(/-{2,}/g, '-');
    assertValidRef(branch);
    storyBranches.set(storyKey, branch);
    return branch;
}

/**
 * Group assignments by branch name.
 * Uses canonicalBranchName to enforce one-branch-per-story grouping.
 */
function groupByBranch(
    assignments: Assignment[],
    projectSlug: string,
    storyBranches: Map<string, string>,
): Map<string, Assignment[]> {
    const groups = new Map<string, Assignment[]>();
    for (const a of assignments) {
        const branch = canonicalBranchName(a, projectSlug, storyBranches);
        const existing = groups.get(branch) ?? [];
        existing.push(a);
        groups.set(branch, existing);
    }
    return groups;
}

// ─── Scaffold barrier (Sub-Plan 06 §5a) ─────────────────────────────────────

/**
 * Matches a scaffold branch name with or without a project prefix.
 *
 * Plan 22 F1: the previous pattern was `/\/chore\/scaffold$/i`, which requires a
 * leading slash. The Team Leader emits un-prefixed names like `chore/scaffold`
 * (the dispatcher adds the `<project>/` prefix later), so the test failed and the
 * scaffold barrier never fired in the pacmanclaude run — no `Scaffold barrier:`
 * line appears in that log and the scaffold was dispatched as an ordinary
 * serialised feature branch, so feature worktrees were not guaranteed to be cut
 * from a merged scaffold.
 */
export const SCAFFOLD_BRANCH_RE = /(^|\/)chore\/scaffold$/i;

/** Returns true when an assignment is part of the scaffold (chore/scaffold). */
export function isScaffoldAssignment(a: Assignment): boolean {
    return a.taskType === 'chore' || SCAFFOLD_BRANCH_RE.test(a.branchName ?? '');
}

/**
 * Returns true when a *dispatch branch* is the scaffold branch.
 *
 * Classification is by branch name first, then by whether ANY assignment on the
 * branch looks like scaffold work. The old rule required `every` assignment to
 * match, so a single `refactor`-typed assignment sharing the scaffold branch
 * silently disabled the barrier for the whole run.
 */
export function isScaffoldBranch(branch: string, assignments: Assignment[]): boolean {
    if (SCAFFOLD_BRANCH_RE.test(branch)) return true;
    return assignments.length > 0 && assignments.some(isScaffoldAssignment);
}

/**
 * Inject implicit scaffold dependencies: every non-scaffold assignment
 * depends on all scaffold assignment ids, regardless of what the TL wrote.
 * This guarantees the scaffold merges before feature branches are created.
 */
export function injectScaffoldDependencies(assignments: Assignment[]): Assignment[] {
    const scaffoldIds = assignments.filter(isScaffoldAssignment).map(a => a.id);
    if (scaffoldIds.length === 0) return assignments;

    return assignments.map(a => {
        if (isScaffoldAssignment(a)) return a;
        const existing = new Set(a.dependsOn);
        const newDeps = scaffoldIds.filter(id => !existing.has(id));
        if (newDeps.length === 0) return a;
        return { ...a, dependsOn: [...a.dependsOn, ...newDeps] };
    });
}

// ─── Bootstrap/wiring barrier (Plan 24, E4) ─────────────────────────────────

/** Patterns in moduleIds that indicate an entry-point / app-root module. */
const ENTRY_MODULE_PATTERNS = [/^MOD-MAIN$/i, /^MOD-APP$/i, /^MOD-ROOT$/i, /^MOD-ENTRY$/i];

/** Patterns in assignment descriptions / story text that indicate bootstrap work. */
const BOOTSTRAP_TEXT_PATTERNS = [
    /\bbootstrap\b/i, /\bwiring\b/i, /\bentry\s*point\b/i,
    /\bapp\s*initializ/i, /\bcomposition\s*root\b/i,
];

/**
 * Returns true when an assignment looks like bootstrap/wiring work:
 * it either owns an entry-point module or its description mentions bootstrap keywords.
 */
export function isBootstrapAssignment(a: Assignment): boolean {
    // Don't classify scaffold assignments as bootstrap
    if (isScaffoldAssignment(a)) return false;

    // Check moduleIds for entry-point patterns
    for (const mod of a.moduleIds ?? []) {
        if (ENTRY_MODULE_PATTERNS.some(re => re.test(mod))) return true;
    }

    // Check description for bootstrap/wiring keywords
    const desc = a.description ?? '';
    if (BOOTSTRAP_TEXT_PATTERNS.some(re => re.test(desc))) return true;

    return false;
}

/**
 * Returns true when a *dispatch branch* is a bootstrap/wiring branch.
 *
 * A branch is bootstrap if any of its assignments is a bootstrap assignment.
 */
export function isBootstrapBranch(_branch: string, assignments: Assignment[]): boolean {
    return assignments.length > 0 && assignments.some(isBootstrapAssignment);
}

/**
 * Inject implicit bootstrap dependencies (Plan 24, E4): every non-scaffold,
 * non-bootstrap assignment depends on all bootstrap assignment ids.
 * This guarantees the bootstrap/wiring branch runs immediately after scaffold,
 * before other feature branches.
 */
export function injectBootstrapDependencies(assignments: Assignment[]): Assignment[] {
    const bootstrapIds = assignments.filter(isBootstrapAssignment).map(a => a.id);
    if (bootstrapIds.length === 0) return assignments;

    log.info(`Bootstrap barrier: ${bootstrapIds.length} bootstrap assignment(s) detected — injecting dependencies`);

    return assignments.map(a => {
        if (isScaffoldAssignment(a) || isBootstrapAssignment(a)) return a;
        const existing = new Set(a.dependsOn);
        const newDeps = bootstrapIds.filter(id => !existing.has(id));
        if (newDeps.length === 0) return a;
        return { ...a, dependsOn: [...a.dependsOn, ...newDeps] };
    });
}

/**
 * Detect branches with overlapping moduleIds. Returns sets of branches
 * that share module paths and should be serialised instead of batched.
 */
function findOverlappingBranches(
    branchGroups: Map<string, Assignment[]>,
): Map<string, Set<string>> {
    const branchModules = new Map<string, Set<string>>();
    for (const [branch, assignments] of branchGroups) {
        const modules = new Set<string>();
        for (const a of assignments) {
            for (const m of a.moduleIds ?? []) modules.add(m);
        }
        if (modules.size > 0) branchModules.set(branch, modules);
    }

    const conflicts = new Map<string, Set<string>>();
    const branches = [...branchModules.keys()];
    for (let i = 0; i < branches.length; i++) {
        for (let j = i + 1; j < branches.length; j++) {
            const a = branchModules.get(branches[i])!;
            const b = branchModules.get(branches[j])!;
            const overlap = [...a].filter(m => b.has(m));
            if (overlap.length > 0) {
                log.warn(`Serialising branches ${branches[i]} and ${branches[j]} — both own ${overlap.join(', ')}`);
                if (!conflicts.has(branches[i])) conflicts.set(branches[i], new Set());
                if (!conflicts.has(branches[j])) conflicts.set(branches[j], new Set());
                conflicts.get(branches[i])!.add(branches[j]);
                conflicts.get(branches[j])!.add(branches[i]);
            }
        }
    }
    return conflicts;
}

/**
 * Sync workspace to the latest baseBranch after a scaffold merge.
 */
function syncWorkspaceToBranch(gitRoot: string, baseBranch: string): void {
    gitExec(gitRoot, `fetch origin ${baseBranch}`);
    gitExec(gitRoot, `checkout ${baseBranch}`);
    gitExec(gitRoot, `pull origin ${baseBranch}`);
    log.info(`Workspace synced to ${baseBranch} after scaffold merge`);
}

/**
 * Determine the primary task type for a branch group of assignments.
 */
function primaryTaskType(assignments: Assignment[]): 'feature' | 'bug' | 'fix' | 'refactor' | 'chore' {
    const types = assignments.map(a => a.taskType ?? 'feature');
    // Priority: bug > fix > refactor > feature > chore
    const priority = ['bug', 'fix', 'refactor', 'feature', 'chore'] as const;
    for (const t of priority) {
        if (types.includes(t)) return t;
    }
    return 'feature';
}

/**
 * Collect reviewer IDs from all assignments in a branch group.
 * Returns a deduplicated array capped at 2 (the highest-rank reviewers)
 * so review cost does not grow with merged group size.
 */
function collectReviewers(assignments: Assignment[]): string[] {
    const reviewers = new Set<string>();
    for (const a of assignments) {
        if (a.reviewerAgentIds) {
            for (const r of a.reviewerAgentIds) reviewers.add(r);
        }
    }
    const all = [...reviewers];
    if (all.length <= 2) return all;

    const RANK_ORDER: Record<string, number> = { principal: 2, senior: 1, junior: 0 };
    return all
        .sort((x, y) =>
            (RANK_ORDER[getDevAgent(y)?.rank ?? 'junior'] ?? 0) -
            (RANK_ORDER[getDevAgent(x)?.rank ?? 'junior'] ?? 0))
        .slice(0, 2);
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

/**
 * Dispatch all assignments to developer agents via the PR workflow.
 *
 * Assignments are grouped by branch. Each branch group goes through:
 * branch creation → dev work → PR creation → code review → merge.
 *
 * Sub-Plan 06: scaffold barrier ensures the scaffold merges first, implicit
 * scaffold dependencies prevent parallel scaffold+feature dispatch, and
 * branches with overlapping moduleIds are serialised.
 *
 * @param apiKey       LLM token
 * @param assignments  All assignments from the Team Leader
 * @param workspacePath Generated project workspace path
 * @param contextPrompt Context string (architecture, tech stack, DB design summary)
 * @param techStack    Architect's tech stack decisions (for convention file resolution)
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
): Promise<DispatchResult> {
    const fileChanges: FileChange[] = [];
    const artifacts: ArtifactRef[] = [];
    const transcript: TranscriptMessage[] = [];
    const pullRequests: PullRequest[] = [];
    const tokenUsage: TokenCallRecord[] = [];
    const newlyCompletedIds: string[] = [];
    const allCompletionEvidence: CompletionEvidence[] = [];
    const allSalvageBranches: string[] = [];

    // Flag: set when any branch returns pr-creation-failed — stops further branches
    let prCreationFailed = false;

    // Plan 25: set when a provider-level failure cannot be recovered
    let providerFailureKind: string | null = null;

    // Plan 24 D3: wall-clock-aware admission control
    let branchesDeferred = 0;
    const completedBranchDurationsMs: number[] = [];

    // Sub-Plan 06 §5a: Inject implicit scaffold dependencies before grouping
    // Plan 24, E4: also inject bootstrap/wiring dependencies so the entry-point
    // branch runs immediately after scaffold, before other feature branches.
    const withScaffoldDeps = injectScaffoldDependencies(assignments);
    const augmentedAssignments = injectBootstrapDependencies(withScaffoldDeps);

    // ── Story → branch mapping (shared across grouping + layer loop) ────
    const storyBranches = new Map<string, string>();

    // ── Group by branch ──────────────────────────────────────────────────
    const branchGroups = groupByBranch(augmentedAssignments, projectSlug, storyBranches);
    log.info(`Dispatch plan: ${branchGroups.size} branch(es) from ${augmentedAssignments.length} assignments (${storyBranches.size} stories)`);
    if (branchGroups.size > 8) {
        log.warn(`High branch count (${branchGroups.size} > 8) — consider merging closely-related stories onto fewer branches`);
    }

    // Sub-Plan 06 §5b: Detect overlapping module ownership across branches
    const overlaps = findOverlappingBranches(branchGroups);

    // ── Topological sort within each branch, then process branches ────────
    // Branches with cross-branch dependencies are serialized via topoSort on assignments
    const preSatisfied = new Set(completedAssignmentIds ?? []);
    const allAssignmentsSorted = topoSort(augmentedAssignments, preSatisfied);

    // Track which branches have been processed
    const processedBranches = new Set<string>();
    const gitRoot = (() => { try { return gitExec(workspacePath, 'rev-parse --show-toplevel'); } catch { return workspacePath; } })();

    for (const layer of allAssignmentsSorted) {
        // Identify which branches appear in this layer (uses the shared storyBranches map)
        const layerBranches = new Map<string, Assignment[]>();
        for (const a of layer) {
            const branch = canonicalBranchName(a, projectSlug, storyBranches);
            const existing = layerBranches.get(branch) ?? [];
            existing.push(a);
            layerBranches.set(branch, existing);
        }

        // For each unprocessed branch in this layer, gather ALL its assignments
        // (including from other layers) and run the PR workflow
        const branchesToProcess: string[] = [];
        for (const branch of layerBranches.keys()) {
            if (!processedBranches.has(branch)) {
                branchesToProcess.push(branch);
                processedBranches.add(branch);
            }
        }

        if (branchesToProcess.length === 0) continue;

        // Sub-Plan 06 §5a / Plan 22 F1: Identify scaffold branches in this layer
        const scaffoldBranches = branchesToProcess.filter(branch =>
            isScaffoldBranch(branch, branchGroups.get(branch) ?? []),
        );
        // Plan 24, E4: Identify bootstrap/wiring branches (run right after scaffold)
        const bootstrapBranches = branchesToProcess.filter(branch =>
            !scaffoldBranches.includes(branch) &&
            isBootstrapBranch(branch, branchGroups.get(branch) ?? []),
        );
        const featureBranches = branchesToProcess.filter(b =>
            !scaffoldBranches.includes(b) && !bootstrapBranches.includes(b),
        );

        // Sub-Plan 06 §5b: Serialise branches with overlapping modules
        const serialisedFeatures: string[][] = [];
        const parallelFeatures: string[] = [];
        const serialised = new Set<string>();
        for (const branch of featureBranches) {
            if (serialised.has(branch)) continue;
            const conflicting = overlaps.get(branch);
            if (conflicting && conflicting.size > 0) {
                const chain = [branch, ...([...conflicting].filter(b => featureBranches.includes(b) && !serialised.has(b)))];
                serialisedFeatures.push(chain);
                for (const b of chain) serialised.add(b);
            } else {
                parallelFeatures.push(branch);
            }
        }

        // Plan 22 F1: log the classification every time. Previously the only
        // evidence that the barrier had fired was the presence of a log line, so
        // its silent absence in the pacmanclaude run went unnoticed.
        log.info(
            `Branch classification: ${scaffoldBranches.length} scaffold `
            + `[${scaffoldBranches.join(', ') || 'none'}], `
            + `${bootstrapBranches.length} bootstrap `
            + `[${bootstrapBranches.join(', ') || 'none'}], `
            + `${parallelFeatures.length} parallel, `
            + `${serialisedFeatures.length} serialised chain(s) `
            + `(${serialisedFeatures.reduce((n, c) => n + c.length, 0)} branches)`,
        );

        // Plan 27-B: force sequential dispatch when configured
        const effectiveConcurrency = SEQUENTIAL_DISPATCH ? 1 : MAX_CONCURRENT_DEVS;

        // Helper to run a batch of branches
        const runBranches = async (branches: string[]) => {
            for (let j = 0; j < branches.length; j += effectiveConcurrency) {
                // Stop dispatching if a previous branch's PR creation failed
                if (prCreationFailed) {
                    const skipped = branches.slice(j);
                    log.warn(`Skipping ${skipped.length} branch(es) due to PR creation failure — run will stop gracefully`);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Skipped ${skipped.length} branch(es) due to PR creation failure: ${skipped.join(', ')}`,
                    });
                    break;
                }
                // Plan 25: stop dispatching if a provider failure could not be recovered
                if (providerFailureKind) {
                    const skipped = branches.slice(j);
                    log.error(`Stopping dispatch — provider failure (${providerFailureKind}) unrecoverable. ${skipped.length} branch(es) not started.`);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Provider failure (${providerFailureKind}) — ${skipped.length} branch(es) not dispatched: ${skipped.join(', ')}`,
                    });
                    break;
                }
                if (!getEffectiveLimits().allowNewBranchWorkflows) {
                    const undispatched = branches.slice(j);
                    log.error(`Budget exhausted — stopping dispatch. ${undispatched.length} branch(es) not started: ${undispatched.join(', ')}`);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Budget exhausted — ${undispatched.length} branch(es) not dispatched: ${undispatched.join(', ')}`,
                    });
                    break;
                }
                let batch = branches.slice(j, j + effectiveConcurrency);

                // Plan 24 D3: wall-clock-aware admission control
                const budgetStatus = getBudgetStatus();
                if (budgetStatus.maxWallMs > 0) {
                    const remainingWallMs = budgetStatus.maxWallMs - budgetStatus.elapsedMs;
                    const estimateMs = completedBranchDurationsMs.length > 0
                        ? median([...completedBranchDurationsMs].sort((a, b) => a - b))
                        : DEFAULT_BRANCH_ESTIMATE_MS;
                    // Also respect per-branch wall cap as an estimate floor
                    const effectiveEstimate = MAX_BRANCH_WALL_MS > 0
                        ? Math.min(estimateMs, MAX_BRANCH_WALL_MS)
                        : estimateMs;

                    const admitted: string[] = [];
                    for (const branchName of batch) {
                        if (remainingWallMs < effectiveEstimate) {
                            branchesDeferred++;
                            log.warn(
                                `Deferring branch "${branchName}": remaining wall time `
                                + `${(remainingWallMs / 1000).toFixed(0)}s < estimated duration `
                                + `${(effectiveEstimate / 1000).toFixed(0)}s`,
                            );
                            transcript.push({
                                timestamp: new Date().toISOString(),
                                agentId: 'dispatcher',
                                phase: 'development' as PhaseName,
                                message: `Branch "${branchName}" deferred: insufficient wall time (${(remainingWallMs / 1000).toFixed(0)}s remaining, ~${(effectiveEstimate / 1000).toFixed(0)}s needed)`,
                            });
                        } else {
                            admitted.push(branchName);
                        }
                    }
                    batch = admitted;
                    if (batch.length === 0) continue;
                }

                const batchStartMs = Date.now();
                const promises = batch.map(branchName => {
                    const branchAssignments = branchGroups.get(branchName) ?? [];
                    const reviewerIds = collectReviewers(branchAssignments);
                    const taskType = primaryTaskType(branchAssignments);
                    // Plan 26, A5: use scaffold fallback ref as base for non-scaffold branches
                    const isScaffold = scaffoldBranches?.includes(branchName);
                    const effectiveBaseBranch = (!isScaffold && scaffoldFallbackRef) ? scaffoldFallbackRef : baseBranch;

                    log.info(`Branch "${branchName}": ${branchAssignments.length} assignment(s), ` +
                        `${reviewerIds.length} reviewer(s), type=${taskType}` +
                        (effectiveBaseBranch !== baseBranch ? `, base=${effectiveBaseBranch} (scaffold fallback)` : ''));

                    return executePRWorkflow({
                        branchName,
                        baseBranch: effectiveBaseBranch,
                        assignments: branchAssignments,
                        reviewerAgentIds: reviewerIds,
                        taskType,
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
                    });
                });

                const results = await Promise.allSettled(promises);
                // Record batch duration for future admission estimates
                completedBranchDurationsMs.push(Date.now() - batchStartMs);
                for (const r of results) {
                    if (r.status === 'fulfilled') {
                        const prResult = r.value;
                        fileChanges.push(...prResult.fileChanges);
                        artifacts.push(...prResult.artifacts);
                        transcript.push(...prResult.transcript);
                        pullRequests.push(prResult.pullRequest);
                        if (prResult.tokenUsage) tokenUsage.push(...prResult.tokenUsage);
                        newlyCompletedIds.push(...completedIdsFromPullRequests([prResult.pullRequest]));
                        if (prResult.completionEvidence) allCompletionEvidence.push(...prResult.completionEvidence);
                        if (prResult.salvageBranch) allSalvageBranches.push(prResult.salvageBranch);

                        // PR creation failed — flag for graceful stop
                        if (prResult.pullRequest.status === 'pr-creation-failed') {
                            prCreationFailed = true;
                        }

                        // Plan 27-B: halt-on-failure — check if a non-merged branch should stop dispatch
                        if (DISPATCH_HALT_POLICY !== 'off' && !prCreationFailed) {
                            const pr = prResult.pullRequest;
                            const isMerged = pr.status === 'merged';

                            if (!isMerged) {
                                const branchName = pr.branchName ?? '';
                                const branchAssigns = branchGroups.get(branchName) ?? [];
                                const isScaffold = isScaffoldBranch(branchName, branchAssigns);
                                const shouldHalt = DISPATCH_HALT_POLICY === 'strict'
                                    || (DISPATCH_HALT_POLICY === 'scaffold-only' && isScaffold);

                                if (shouldHalt) {
                                    log.error(`Branch "${branchName}" failed (status: ${pr.status}) — halting dispatch per DISPATCH_HALT_POLICY=${DISPATCH_HALT_POLICY}`);
                                    emitRunEvent('dispatch:halted', {
                                        branchName,
                                        status: pr.status,
                                        policy: DISPATCH_HALT_POLICY,
                                    });
                                    prCreationFailed = true; // reuse existing stop flag
                                    break;
                                }
                            }
                        }
                    } else {
                        // Plan 24, A3: classify the failure — provider-level errors
                        // (billing, auth, quota) should not consume the branch's attempt.
                        const classification = classifyProviderFailure(r.reason);
                        if (isProviderLevelFailure(classification)) {
                            log.error(`Provider failure (${classification.kind}): ${classification.message} — branch not counted as attempted`);
                            emitRunEvent('run:paused', { kind: classification.kind, message: classification.message });
                            transcript.push({
                                timestamp: new Date().toISOString(),
                                agentId: 'dispatcher',
                                phase: 'development' as PhaseName,
                                message: `Provider failure (${classification.kind}): branch assignments remain pending — ${classification.message}`,
                            });
                            // Plan 25: fatal provider errors (auth, model-not-found) stop immediately
                            if (classification.fatal) {
                                providerFailureKind = classification.kind;
                                emitRunEvent('run:provider-stop', { kind: classification.kind, message: classification.message });
                                log.error(`Fatal provider error (${classification.kind}) — stopping dispatch for graceful shutdown`);
                            } else if (classification.pauseable) {
                                // Attempt recovery for pauseable failures (billing, quota)
                                // Plan 25: pass a real probe so recovery actively checks the provider
                                const recovered = await awaitProviderRecovery(createProviderProbe());
                                if (!recovered) {
                                    // Plan 25: recovery failed — stop dispatching gracefully
                                    providerFailureKind = classification.kind;
                                    emitRunEvent('run:provider-stop', { kind: classification.kind, message: classification.message, recoveryFailed: true });
                                    log.error(`Provider recovery failed (${classification.kind}) — stopping dispatch for graceful shutdown`);
                                }
                            }
                        } else {
                            log.error(`PR workflow failed: ${r.reason}`);
                            transcript.push({
                                timestamp: new Date().toISOString(),
                                agentId: 'dispatcher',
                                phase: 'development' as PhaseName,
                                message: `PR workflow failed: ${r.reason}`,
                            });
                        }
                    }
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

                if (j + effectiveConcurrency < branches.length && INTER_BATCH_DELAY_MS > 0) {
                    log.info(`Waiting ${INTER_BATCH_DELAY_MS}ms before next batch...`);
                    await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
                }
            }
        };

        // Run scaffold branches first (sequentially), then sync workspace
        // Plan 26, A5: track scaffold fallback ref for feature branch creation
        let scaffoldFallbackRef: string | undefined;
        if (scaffoldBranches.length > 0) {
            log.info(`Scaffold barrier: running ${scaffoldBranches.length} scaffold branch(es) first`);
            for (const scaffoldBranch of scaffoldBranches) {
                if (prCreationFailed) break;
                await runBranches([scaffoldBranch]);
                // Sync workspace after scaffold merge so feature worktrees cut from the merged tree
                const scaffoldPR = pullRequests.find(pr => pr.branchName === scaffoldBranch);
                if (scaffoldPR?.status === 'merged') {
                    syncWorkspaceToBranch(gitRoot, baseBranch);
                } else {
                    // Plan 26, A5: use scaffold branch tip as fallback base for feature branches
                    log.error(`Scaffold branch ${scaffoldBranch} failed to merge — using scaffold tip as fallback base`);
                    scaffoldFallbackRef = scaffoldBranch;
                    syncWorkspaceToBranch(gitRoot, scaffoldBranch);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Scaffold branch ${scaffoldBranch} failed to merge — using scaffold tip as fallback base for feature branches`,
                    });
                }
            }
        }

        // Plan 24, E4: Run bootstrap/wiring branches right after scaffold, before features.
        // These branches wire up the entry point and other feature branches depend on them.
        if (!prCreationFailed && bootstrapBranches.length > 0) {
            log.info(`Bootstrap barrier: running ${bootstrapBranches.length} bootstrap branch(es) after scaffold`);
            for (const bootstrapBranch of bootstrapBranches) {
                if (prCreationFailed) break;
                await runBranches([bootstrapBranch]);
                const bootstrapPR = pullRequests.find(pr => pr.branchName === bootstrapBranch);
                if (bootstrapPR?.status === 'merged') {
                    syncWorkspaceToBranch(gitRoot, baseBranch);
                } else {
                    log.warn(`Bootstrap branch ${bootstrapBranch} failed to merge — feature branches may lack entry-point wiring`);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Bootstrap branch ${bootstrapBranch} failed to merge — remaining branches may lack entry-point wiring`,
                    });
                }
            }
        }

        // Run serialised (overlapping) branches sequentially
        if (!prCreationFailed) {
            for (const chain of serialisedFeatures) {
                if (prCreationFailed) break;
                log.info(`Serialising ${chain.length} overlapping branches: ${chain.join(', ')}`);
                for (const branch of chain) {
                    if (prCreationFailed) break;
                    await runBranches([branch]);
                }
            }
        }

        // Run parallel (non-overlapping) feature branches
        if (!prCreationFailed && parallelFeatures.length > 0) {
            await runBranches(parallelFeatures);
        }
    }

    // Merged vs skipped matters: a `PR-SKIPPED-*` placeholder is recorded for every
    // branch whose dev agent produced no commits, so a raw PR count can read "16 PRs"
    // for a round that delivered nothing at all (Plan 21, E3).
    const mergedPrs = pullRequests.filter(pr => pr.status === 'merged').length;
    const skippedPrs = pullRequests.filter(pr => pr.id.startsWith('PR-SKIPPED-')).length;
    const failedPrCreation = pullRequests.filter(pr => pr.status === 'pr-creation-failed').length;
    log.info(
        `Dispatch complete: ${fileChanges.length} total file changes, ${pullRequests.length} PRs `
        + `(${mergedPrs} merged, ${skippedPrs} skipped`
        + (failedPrCreation > 0 ? `, ${failedPrCreation} pr-creation-failed` : '')
        + `), ${artifacts.length} artifacts, `
        + `${newlyCompletedIds.length} completed assignments`
        + (branchesDeferred > 0 ? `, ${branchesDeferred} branch(es) deferred` : ''),
    );

    if (prCreationFailed) {
        log.error(`Run stopped early: PR creation failed — use continue-run to retry`);
        transcript.push({
            timestamp: new Date().toISOString(),
            agentId: 'dispatcher',
            phase: 'development' as PhaseName,
            message: `Run stopped early: PR creation failed for ${failedPrCreation} branch(es) — use continue-run to retry`,
        });
    }

    // Systemic failure: every branch in the round produced nothing. Individually these
    // surface only as per-branch WARNs, which is how 34 identical provider 400s scrolled
    // past unnoticed. Escalate to ERROR + transcript so runaway detection can halt.
    const allEmpty = pullRequests.length > 0 && mergedPrs === 0 && fileChanges.length === 0;
    if (allEmpty) {
        log.error(`ALL ${pullRequests.length} branch(es) in this dispatch round produced zero commits and zero merged PRs — developer agents are systemically failing (check provider errors above)`);
        transcript.push({
            timestamp: new Date().toISOString(),
            agentId: 'dispatcher',
            phase: 'development' as PhaseName,
            message: `Zero-output dispatch round: ${pullRequests.length} branch(es), 0 merged PRs, 0 file changes`,
        });
    }

    return {
        fileChanges, artifacts, transcript, pullRequests, tokenUsage,
        completedAssignmentIds: newlyCompletedIds,
        completionEvidence: allCompletionEvidence,
        salvageBranches: allSalvageBranches,
        branchesDeferred,
        providerFailureKind,
    };
}
