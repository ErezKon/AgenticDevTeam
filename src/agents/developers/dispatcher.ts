/**
 * Developer Dispatcher — fans out assignments to developer agents.
 *
 * Groups assignments by devAgentId, respects dependency ordering,
 * and runs up to MAX_CONCURRENT_DEVS agents in parallel.
 */
import { MAX_CONCURRENT_DEVS, INTER_BATCH_DELAY_MS } from '../../config';
import { getLogger } from '../../utils/logger';
import { executePRWorkflow } from '../../conductor/pr-workflow';
import { getDevAgent } from './registry';
import type { Assignment, FileChange, ArtifactRef, TranscriptMessage, PhaseName, PullRequest, GitContext, TechDecision } from '../_shared/base-schemas';
import type { TokenCallRecord } from '../../utils/token-tracker';

const log = getLogger('[Dispatcher]', 226);

export interface DispatchResult {
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
    pullRequests: PullRequest[];
    tokenUsage: TokenCallRecord[];
}

/**
 * Topological sort on assignments by dependsOn.
 * Returns assignments in execution order (groups of independent assignments).
 */
function topoSort(assignments: Assignment[]): Assignment[][] {
    const map = new Map<string, Assignment>();
    for (const a of assignments) map.set(a.id, a);

    const completed = new Set<string>();
    const layers: Assignment[][] = [];

    while (completed.size < assignments.length) {
        const ready = assignments.filter(
            a => !completed.has(a.id) &&
                a.dependsOn.every(dep => completed.has(dep))
        );
        if (ready.length === 0) {
            // Remaining are cyclic — just push them all
            const remaining = assignments.filter(a => !completed.has(a.id));
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
): Promise<DispatchResult> {
    const fileChanges: FileChange[] = [];
    const artifacts: ArtifactRef[] = [];
    const transcript: TranscriptMessage[] = [];
    const pullRequests: PullRequest[] = [];
    const tokenUsage: TokenCallRecord[] = [];

    // ── Story → branch mapping (shared across grouping + layer loop) ────
    const storyBranches = new Map<string, string>();

    // ── Group by branch ──────────────────────────────────────────────────
    const branchGroups = groupByBranch(assignments, projectSlug, storyBranches);
    log.info(`Dispatch plan: ${branchGroups.size} branch(es) from ${assignments.length} assignments (${storyBranches.size} stories)`);
    if (branchGroups.size > 8) {
        log.warn(`High branch count (${branchGroups.size} > 8) — consider merging closely-related stories onto fewer branches`);
    }

    // ── Topological sort within each branch, then process branches ────────
    // Branches with cross-branch dependencies are serialized via topoSort on assignments
    const allAssignmentsSorted = topoSort(assignments);

    // Track which branches have been processed
    const processedBranches = new Set<string>();

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

        // Fan out branch PR workflows with concurrency limit
        for (let j = 0; j < branchesToProcess.length; j += MAX_CONCURRENT_DEVS) {
            const batch = branchesToProcess.slice(j, j + MAX_CONCURRENT_DEVS);
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

            // Delay between batches to avoid rate-limit bursts
            if (j + MAX_CONCURRENT_DEVS < branchesToProcess.length && INTER_BATCH_DELAY_MS > 0) {
                log.info(`Waiting ${INTER_BATCH_DELAY_MS}ms before next batch...`);
                await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
            }
        }
    }

    log.info(`Dispatch complete: ${fileChanges.length} total file changes, ${pullRequests.length} PRs, ${artifacts.length} artifacts`);
    return { fileChanges, artifacts, transcript, pullRequests, tokenUsage };
}
