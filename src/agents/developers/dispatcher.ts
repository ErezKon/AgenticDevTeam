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
import { MAX_CONCURRENT_DEVS, INTER_BATCH_DELAY_MS, CONFIG_OWNERSHIP_SCAFFOLD_ONLY } from '../../config';
import { getLogger } from '../../utils/logger';
import { executePRWorkflow } from '../../conductor/pr-workflow';
import { completedIdsFromPullRequests } from '../../conductor/assignment-policy';
import type { CompletionEvidence } from '../../conductor/assignment-policy';
import { getEffectiveLimits } from '../../utils/run-budget';
import { getDevAgent } from './registry';
import { gitExec } from '../../utils/git-exec';
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

    let branch = a.branchName ?? `${projectSlug}/feature/${slugify(storyKey)}-${slugify(a.description)}`;
    if (!branch.startsWith(`${projectSlug}/`)) branch = `${projectSlug}/${branch}`;
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

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

// ─── Scaffold barrier (Sub-Plan 06 §5a) ─────────────────────────────────────

/** Returns true when an assignment is part of the scaffold (chore/scaffold). */
function isScaffoldAssignment(a: Assignment): boolean {
    return a.taskType === 'chore' || /\/chore\/scaffold$/i.test(a.branchName ?? '');
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

    // Sub-Plan 06 §5a: Inject implicit scaffold dependencies before grouping
    const augmentedAssignments = injectScaffoldDependencies(assignments);

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

        // Sub-Plan 06 §5a: Identify scaffold branches in this layer
        const scaffoldBranches = branchesToProcess.filter(branch => {
            const branchAssignments = branchGroups.get(branch) ?? [];
            return branchAssignments.every(isScaffoldAssignment);
        });
        const featureBranches = branchesToProcess.filter(b => !scaffoldBranches.includes(b));

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

        // Helper to run a batch of branches
        const runBranches = async (branches: string[]) => {
            for (let j = 0; j < branches.length; j += MAX_CONCURRENT_DEVS) {
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
                const batch = branches.slice(j, j + MAX_CONCURRENT_DEVS);
                const promises = batch.map(branchName => {
                    const branchAssignments = branchGroups.get(branchName) ?? [];
                    const reviewerIds = collectReviewers(branchAssignments);
                    const taskType = primaryTaskType(branchAssignments);

                    log.info(`Branch "${branchName}": ${branchAssignments.length} assignment(s), ` +
                        `${reviewerIds.length} reviewer(s), type=${taskType}`);

                    return executePRWorkflow({
                        branchName,
                        baseBranch,
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

                if (j + MAX_CONCURRENT_DEVS < branches.length && INTER_BATCH_DELAY_MS > 0) {
                    log.info(`Waiting ${INTER_BATCH_DELAY_MS}ms before next batch...`);
                    await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
                }
            }
        };

        // Run scaffold branches first (sequentially), then sync workspace
        if (scaffoldBranches.length > 0) {
            log.info(`Scaffold barrier: running ${scaffoldBranches.length} scaffold branch(es) first`);
            for (const scaffoldBranch of scaffoldBranches) {
                await runBranches([scaffoldBranch]);
                // Sync workspace after scaffold merge so feature worktrees cut from the merged tree
                const scaffoldPR = pullRequests.find(pr => pr.branchName === scaffoldBranch);
                if (scaffoldPR?.status === 'merged') {
                    syncWorkspaceToBranch(gitRoot, baseBranch);
                } else {
                    log.error(`Scaffold branch ${scaffoldBranch} failed to merge — feature branches may conflict`);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Scaffold branch ${scaffoldBranch} failed to merge — remaining branches may have conflicts`,
                    });
                }
            }
        }

        // Run serialised (overlapping) branches sequentially
        for (const chain of serialisedFeatures) {
            log.info(`Serialising ${chain.length} overlapping branches: ${chain.join(', ')}`);
            for (const branch of chain) {
                await runBranches([branch]);
            }
        }

        // Run parallel (non-overlapping) feature branches
        if (parallelFeatures.length > 0) {
            await runBranches(parallelFeatures);
        }
    }

    // Merged vs skipped matters: a `PR-SKIPPED-*` placeholder is recorded for every
    // branch whose dev agent produced no commits, so a raw PR count can read "16 PRs"
    // for a round that delivered nothing at all (Plan 21, E3).
    const mergedPrs = pullRequests.filter(pr => pr.status === 'merged').length;
    const skippedPrs = pullRequests.filter(pr => pr.id.startsWith('PR-SKIPPED-')).length;
    log.info(`Dispatch complete: ${fileChanges.length} total file changes, ${pullRequests.length} PRs (${mergedPrs} merged, ${skippedPrs} skipped), ${artifacts.length} artifacts, ${newlyCompletedIds.length} completed assignments`);

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
    };
}
