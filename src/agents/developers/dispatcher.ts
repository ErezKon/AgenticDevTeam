/**
 * Developer Dispatcher — fans out assignments to developer agents.
 *
 * Groups assignments by devAgentId, respects dependency ordering,
 * and runs up to MAX_CONCURRENT_DEVS agents in parallel.
 */
import { MAX_CONCURRENT_DEVS, INTER_BATCH_DELAY_MS } from '../../config';
import { getLogger } from '../../utils/logger';
import { executePRWorkflow } from '../../conductor/pr-workflow';
import type { Assignment, FileChange, ArtifactRef, TranscriptMessage, PhaseName, PullRequest } from '../_shared/base-schemas';

const log = getLogger('[Dispatcher]', 226);

export interface DispatchResult {
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
    pullRequests: PullRequest[];
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
 * Group assignments by branch name.
 * Assignments without a branchName get their own auto-generated branch.
 */
function groupByBranch(assignments: Assignment[]): Map<string, Assignment[]> {
    const groups = new Map<string, Assignment[]>();
    for (const a of assignments) {
        const branch = a.branchName ?? `feature/${a.id}-${slugify(a.description)}`;
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
 * Returns a deduplicated array.
 */
function collectReviewers(assignments: Assignment[]): string[] {
    const reviewers = new Set<string>();
    for (const a of assignments) {
        if (a.reviewerAgentIds) {
            for (const r of a.reviewerAgentIds) reviewers.add(r);
        }
    }
    return [...reviewers];
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
 */
export async function dispatchDevelopers(
    apiKey: string,
    assignments: Assignment[],
    workspacePath: string,
    contextPrompt: string,
    baseBranch: string,
): Promise<DispatchResult> {
    const fileChanges: FileChange[] = [];
    const artifacts: ArtifactRef[] = [];
    const transcript: TranscriptMessage[] = [];
    const pullRequests: PullRequest[] = [];

    // ── Group by branch ──────────────────────────────────────────────────
    const branchGroups = groupByBranch(assignments);
    log.info(`Dispatch plan: ${branchGroups.size} branch(es), ${assignments.length} total assignments`);

    // ── Topological sort within each branch, then process branches ────────
    // Branches with cross-branch dependencies are serialized via topoSort on assignments
    const allAssignmentsSorted = topoSort(assignments);

    // Track which branches have been processed
    const processedBranches = new Set<string>();

    for (const layer of allAssignmentsSorted) {
        // Identify which branches appear in this layer
        const layerBranches = new Map<string, Assignment[]>();
        for (const a of layer) {
            const branch = a.branchName ?? `feature/${a.id}-${slugify(a.description)}`;
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
    return { fileChanges, artifacts, transcript, pullRequests };
}
