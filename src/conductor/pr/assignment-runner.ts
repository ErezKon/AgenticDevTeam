/**
 * Assignment runner — runs a branch's assignments, one agent invocation each
 * (Plan 26 B3), and records what really happened (Plan 30-02):
 *
 *   executed       the agent ran, whatever the outcome — only these are claimed by the PR
 *   deferred       never started because the branch budget ran out — they stay pending
 *   failed         ran, but crashed or crossed the invocation ceiling without valid output
 *   budget-capped  crossed the invocation ceiling with valid output, which is kept
 *
 * Every invocation gets one `agent` ledger entry with the real tool usage of
 * every generation, the respawn count and the files in its durable commit.
 *
 * Extracted from orchestrator.ts (Plan 30-02).
 */
import { getLogger } from '../../utils/logger';
import { gitExec } from '../../utils/git-exec';
import { writeArtifact } from '../../agents/_shared/artifact';
import { buildDevAgent } from '../../agents/developers/dev-agent.builder';
import { getDevAgent, type DevAgentEntry } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import {
    MAX_BRANCH_COST_USD, MAX_BRANCH_WALL_MS, MAX_BRANCH_WALL_PER_ASSIGNMENT_MS,
    RECONCILE_FILE_CHANGES, SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_CHARS,
} from '../../config';
import { InvocationBudgetExceededError } from '../../utils/run-budget';
import { billedCost } from '../../utils/cost';
import { emitRunEvent } from '../../utils/event-bus';
import { appendLedger, type LedgerEntry } from '../../utils/run-ledger';
import { buildWorkspaceSnapshot } from '../workspace-snapshot';
import { reconcileFileChanges } from '../file-change-reconciliation';
import { storiesForIds, tasksForIds } from '../context-builder';
import { invokeDevAgent, getModelForRank } from './agent-invoke';
import { commitWorktree, durableCommitSubject } from './commit';
import { workspaceContextBlock } from './dev-prompts';
import { msg } from './transcript';
import type {
    Assignment, ArtifactRef, FileChange, GitContext, TechDecision, TranscriptMessage, UserStory, Task,
} from '../../agents/_shared/base-schemas';
import type { DeveloperOutput } from '../../agents/developers/schemas/dev-output.schema';
import type { TokenCallRecord } from '../../utils/token-tracker';
import type { DevRank } from '../../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

type AgentOutcome = Extract<LedgerEntry, { kind: 'agent' }>['outcome'];

// ─── Branch budget (Plan 24 D2, Plan 30-02) ─────────────────────────────────

/**
 * Wall-clock cap for a branch that runs `assignmentCount` assignments:
 * MAX_BRANCH_WALL_MS + MAX_BRANCH_WALL_PER_ASSIGNMENT_MS × (n − 1); 0 = unlimited.
 * A flat 15 minutes cut 6–13-assignment branches short while the PR, review,
 * escalation and strong fixer still ran.
 */
export function branchWallCapMs(assignmentCount: number): number {
    if (MAX_BRANCH_WALL_MS <= 0) return 0;
    return MAX_BRANCH_WALL_MS + MAX_BRANCH_WALL_PER_ASSIGNMENT_MS * Math.max(0, assignmentCount - 1);
}

/**
 * Per-branch wall-time and cost check: returns why the branch must stop at
 * `checkpoint`, or null. `tokenUsage` is the branch's live accumulator, so the
 * cost estimate grows as the branch spends.
 */
export function makeBranchBudget(
    assignmentCount: number,
    tokenUsage: TokenCallRecord[],
    startMs = Date.now(),
): (checkpoint: string) => string | null {
    const wallCapMs = branchWallCapMs(assignmentCount);
    return (checkpoint) => {
        if (wallCapMs > 0) {
            const elapsedMs = Date.now() - startMs;
            if (elapsedMs >= wallCapMs) return `wall time ${(elapsedMs / 1000).toFixed(0)}s >= cap ${(wallCapMs / 1000).toFixed(0)}s at ${checkpoint}`;
        }
        if (MAX_BRANCH_COST_USD > 0) {
            // Plan 30-06: billed (cache-aware) cost — list price overstated cached branches and stopped them early
            const cost = tokenUsage.reduce((sum, t) => sum + billedCost(t), 0);
            if (cost >= MAX_BRANCH_COST_USD) return `cost $${cost.toFixed(4)} >= cap $${MAX_BRANCH_COST_USD} at ${checkpoint}`;
        }
        return null;
    };
}

// ─── Resume (Plan 30-02) ────────────────────────────────────────────────────

/** Split a resumed branch's assignments into the ones its commits show already ran, and the rest. */
export function partitionByExecution(
    assignments: Assignment[],
    executedIds: ReadonlySet<string>,
): { previouslyExecuted: Assignment[]; toRun: Assignment[] } {
    return {
        previouslyExecuted: assignments.filter(a => executedIds.has(a.id)),
        toRun: assignments.filter(a => !executedIds.has(a.id)),
    };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/** The orchestrator's per-branch accumulators; the runner appends to them as it goes. */
export interface BranchAccumulators {
    fileChanges: FileChange[];
    phantomFileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
    tokenUsage: TokenCallRecord[];
}

export interface AssignmentRunInput {
    branchName: string;
    baseBranch: string;
    projectSlug: string;
    primaryStoryId: string;
    /** Assignments to run now, in the dispatch plan's intra-branch dependency order. */
    assignments: Assignment[];
    /** Assignments a resumed branch executed in an earlier round (prompt context only). */
    previouslyExecuted: Assignment[];
    worktreeWorkspace: string;
    apiKey: string;
    contextPrompt: string;
    gitContext?: GitContext | null;
    techStack?: TechDecision[];
    userStories?: UserStory[];
    tasks?: Task[];
    isMaintainMode?: boolean;
    outputPath?: string;
    respawnCtx: { worktreeDir: string; baseRef: string };
    checkBranchBudget: (checkpoint: string) => string | null;
    sink: BranchAccumulators;
}

export interface AssignmentRunResult {
    executedIds: string[];
    deferredIds: string[];
    failedIds: string[];
    budgetCappedIds: string[];
    /** Could not run: unknown dev agent (a planning defect). They stay pending. */
    skippedIds: string[];
    failedAgentIds: string[];
    /** Why the branch budget stopped the loop; null when every assignment got its turn. */
    budgetStop: string | null;
}

/** Wrap an agent builder so the tool usage and respawns of every agent it builds can be summed. */
function trackAgents(build: () => any) {
    const built: any[] = [];
    return {
        build: (): any => {
            const agent = build();
            built.push(agent);
            return agent;
        },
        toolCalls: () => built.reduce((sum: { read: number; write: number; shell: number; turns: number }, agent) => {
            const u = agent.getToolUsage?.();
            return u ? { read: sum.read + u.reads, write: sum.write + u.writes, shell: sum.shell + u.shell, turns: sum.turns + u.turns } : sum;
        }, { read: 0, write: 0, shell: 0, turns: 0 }),
        respawns: (): number => Math.max(0, built.length - 1),
    };
}

/** Paths in a commit, relative to the workspace — what an invocation actually wrote. */
function filesInCommit(worktreeWorkspace: string, sha: string | null): string[] {
    if (!sha) return [];
    const out = gitExec(worktreeWorkspace, `diff-tree --no-commit-id --name-only --relative -r ${sha}`);
    return out.startsWith('Error:') ? [] : out.split('\n').filter(Boolean);
}

/** Prompt for one assignment: context, fresh workspace snapshot, its stories and tasks, earlier work. */
function buildAssignmentMessage(input: AssignmentRunInput, assignment: Assignment, doneDescs: string[]): string {
    const { userStories, tasks, branchName } = input;
    const storyIds = [assignment.storyId, ...(assignment.additionalStoryIds ?? [])].filter(Boolean) as string[];
    let storySection = '';
    if (userStories?.length && storyIds.length) {
        const { text: storyText, missing: missingStoryIds } = storiesForIds(userStories, storyIds);
        storySection = `\n## User Stories for This Assignment\n\n${storyText}`;
        if (missingStoryIds.length > 0) {
            log.error(`Assignment ${assignment.id} on branch ${branchName} references unknown story id(s): ${missingStoryIds.join(', ')} — the developer will have NO acceptance criteria. This is a planning defect.`);
        }
    }
    const taskIds = assignment.taskIds ?? [];
    const taskSection = (tasks?.length && taskIds.length) ? `\n## Tasks for This Assignment\n\n${tasksForIds(tasks, taskIds)}` : '';

    // Plan 26, B3: refresh the snapshot for each assignment so the agent sees earlier assignments' files
    let snapshotSection = '';
    try {
        snapshotSection = '\n' + buildWorkspaceSnapshot(input.worktreeWorkspace, { maxFiles: SNAPSHOT_MAX_FILES, maxChars: SNAPSHOT_MAX_CHARS });
    } catch (snapErr: any) { log.warn(`Workspace snapshot failed (non-fatal): ${snapErr.message}`); }

    const previousWorkSection = doneDescs.length > 0
        ? `\n## Previously Completed Assignments on This Branch\n\nThe following assignments have already been completed. Their files are already in the workspace.\n${doneDescs.map(d => `- ${d}`).join('\n')}\n`
        : '';

    return [
        input.contextPrompt, snapshotSection, storySection, taskSection, previousWorkSection,
        workspaceContextBlock(input.projectSlug, branchName),
        `\n## Your Assignment\n\nAssignment ${assignment.id} [${assignment.priority}/${assignment.complexity}]: ${assignment.description}`,
    ].join('\n');
}

/** Reconcile an agent's claims, write its mission report and record both. Runs before the durable commit. */
function recordOutput(
    input: AssignmentRunInput, entry: DevAgentEntry, assignment: Assignment, output: DeveloperOutput,
): string[] {
    const { worktreeWorkspace, branchName, sink } = input;
    let changes = output.fileChanges ?? [];
    let phantoms: FileChange[] = [];
    if (RECONCILE_FILE_CHANGES && changes.length) {
        const recon = reconcileFileChanges(worktreeWorkspace, changes);
        if (recon.phantoms.length > 0 || recon.unreported.length > 0) {
            log.warn(`${entry.id} claimed ${changes.length} changes; ${recon.verified.length} verified, ${recon.phantoms.length} phantom, ${recon.unreported.length} unreported`);
        }
        phantoms = recon.phantoms;
        changes = [...recon.verified, ...recon.unreported];
    }
    sink.phantomFileChanges.push(...phantoms);
    sink.fileChanges.push(...changes);
    sink.artifacts.push(writeArtifact({
        agentId: entry.id, colorCode: entry.colorCode,
        workspacePath: worktreeWorkspace, outputPath: input.outputPath,
        title: `${entry.name} Mission Report — ${assignment.id}`,
        content: [
            `## Branch: ${branchName}\n`, `## Assignment: ${assignment.id}\n`, `## Files Changed\n`,
            ...(output.fileChanges ?? []).map(fc => `- **${fc.action}** \`${fc.path}\` — ${fc.summary}`),
            output.notes ? `\n## Notes\n\n${output.notes}` : '',
            output.mermaidDiagram ? `\n## Diagram\n\n\`\`\`mermaid\n${output.mermaidDiagram}\n\`\`\`` : '',
        ].join('\n'),
    }));
    sink.transcript.push(msg(entry.id, `Completed ${output.fileChanges?.length ?? 0} file changes for ${assignment.id} on branch ${branchName}`));
    return phantoms.map(fc => fc.path);
}

/**
 * Run the branch's assignments in order. The branch budget is checked before
 * each one; once it runs out the rest are deferred, not started. Each
 * invocation is followed by a durable commit whose subject records that the
 * assignment ran and whether it failed, so a resumed branch skips the
 * successful ones and runs the failed ones again.
 */
export async function runAssignments(input: AssignmentRunInput): Promise<AssignmentRunResult> {
    const { branchName, projectSlug, primaryStoryId, worktreeWorkspace, gitContext, sink } = input;
    const result: AssignmentRunResult = {
        executedIds: [], deferredIds: [], failedIds: [], budgetCappedIds: [], skippedIds: [], failedAgentIds: [], budgetStop: null,
    };
    const failedAgents = new Set<string>();
    // Plan 26, B3: each agent is told which assignments already put their files in the workspace.
    const doneDescs = input.previouslyExecuted.map(a => `${a.id}: ${a.description.slice(0, 120)}`);

    for (const [index, assignment] of input.assignments.entries()) {
        const devId = assignment.devAgentId;
        const budgetReason = input.checkBranchBudget(`before assignment ${assignment.id} (dev ${devId})`);
        if (budgetReason) {
            result.deferredIds = input.assignments.slice(index).map(a => a.id);
            result.budgetStop = budgetReason;
            log.warn(`Branch ${branchName} budget exceeded: ${budgetReason} — deferring ${result.deferredIds.length} assignment(s) to the next round: [${result.deferredIds.join(', ')}]`);
            sink.transcript.push(msg('conductor', `Branch budget exceeded: ${budgetReason} — deferred to the next round: [${result.deferredIds.join(', ')}]`));
            emitRunEvent('branch:budget-exceeded', { branchName, reason: budgetReason, checkpoint: `before assignment ${assignment.id}`, deferredAssignmentIds: result.deferredIds });
            break;
        }

        const entry = getDevAgent(devId);
        if (!entry) {
            log.error(`Unknown dev agent ${devId} — assignment ${assignment.id} cannot run and stays pending (planning defect)`);
            sink.transcript.push(msg('conductor', `Skipped ${assignment.id}: unknown dev agent ${devId}`));
            result.skippedIds.push(assignment.id);
            continue;
        }
        const devLog = getLogger(entry.tag, entry.colorCode);
        devLog.info(`Working on assignment ${assignment.id} [${assignment.priority}/${assignment.complexity}] on branch ${branchName}`);

        const conventionFiles = resolveConventionFiles(entry.languages, input.techStack);
        // Plan 26, B4: pass this assignment's complexity for budget scaling
        const agents = trackAgents(() => buildDevAgent(input.apiKey, entry, worktreeWorkspace, gitContext, input.baseBranch, conventionFiles, input.isMaintainMode, assignment.complexity));
        const message = buildAssignmentMessage(input, assignment, doneDescs);

        let outcome: AgentOutcome = 'failed';
        let error: string | undefined;
        let filesClaimed: string[] = [];
        let phantoms: string[] = [];
        let commitSha: string | null = null;
        try {
            const devModel = getModelForRank(entry.rank as DevRank);
            const invocation = await invokeDevAgent(agents.build(), message, `${entry.id}-${branchName}-${assignment.id}`, entry.id, devModel, agents.build, input.respawnCtx);
            if (invocation.tokenUsage) sink.tokenUsage.push(invocation.tokenUsage);
            if (invocation.allTokenUsage) sink.tokenUsage.push(...invocation.allTokenUsage.slice(1));
            outcome = invocation.budgetCapped ? 'ok-budget-capped' : 'ok';
            filesClaimed = (invocation.output.fileChanges ?? []).map(fc => fc.path);
            phantoms = recordOutput(input, entry, assignment, invocation.output);
            devLog.info(`Done: ${filesClaimed.length} file changes for ${assignment.id}${invocation.budgetCapped ? ' (budget-capped: valid output kept)' : ''}`);
        } catch (err: any) {
            error = err.message;
            if (err instanceof InvocationBudgetExceededError) {
                outcome = 'budget-exhausted';
                log.warn(`Dev agent ${devId} stopped on ${assignment.id}: ${err.message}`);
                sink.transcript.push(msg(devId, `Stopped on ${assignment.id} (invocation budget exceeded without valid output): ${err.message}`));
            } else {
                // Plan 26, A2: record the failure and continue with the next assignment
                outcome = 'failed';
                log.error(`Dev agent ${devId} failed on ${assignment.id}: ${err.message}`);
                sink.transcript.push(msg(devId, `Failed on ${assignment.id}: ${err.message}`));
            }
        } finally {
            // Commit after each assignment, not just on failure. The subject records that it ran,
            // and whether it failed (a resumed branch runs a failed assignment again).
            const failed = outcome === 'failed' || outcome === 'budget-exhausted';
            commitSha = commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'feat',
                durableCommitSubject(devId, assignment.id, failed), gitContext).sha;
        }

        result.executedIds.push(assignment.id);
        if (outcome === 'ok-budget-capped') result.budgetCappedIds.push(assignment.id);
        if (outcome === 'failed' || outcome === 'budget-exhausted') {
            result.failedIds.push(assignment.id);
            failedAgents.add(devId);
        } else {
            doneDescs.push(`${assignment.id}: ${assignment.description.slice(0, 120)}`);
        }
        // Plan 30-02: the ledger records real tool usage (every generation), respawns and the committed files.
        appendLedger({
            kind: 'agent', agentId: entry.id, phase: 'development', invocation: index,
            assignmentId: assignment.id, branch: branchName,
            toolCalls: agents.toolCalls(), respawns: agents.respawns(), budgetCapped: outcome === 'ok-budget-capped',
            poisoned: false, filesWritten: filesInCommit(worktreeWorkspace, commitSha), filesClaimed, phantoms,
            outcome, error,
        });
    }

    result.failedAgentIds = [...failedAgents];
    reportRun(input, result);
    return result;
}

/** "X of N executed (D deferred, B budget-capped, F failed)" — log, transcript and partial-failure event. */
function reportRun(input: AssignmentRunInput, result: AssignmentRunResult): void {
    const { branchName, sink } = input;
    const earlier = input.previouslyExecuted.length;
    const summary = `${result.executedIds.length} of ${input.assignments.length} assignment(s) executed on ${branchName} `
        + `(${result.deferredIds.length} deferred, ${result.budgetCappedIds.length} budget-capped, ${result.failedIds.length} failed`
        + (result.skippedIds.length > 0 ? `, ${result.skippedIds.length} skipped: unknown dev agent` : '') + ')'
        + (earlier > 0 ? ` — ${earlier} more already executed in an earlier round` : '');
    const clean = result.deferredIds.length + result.failedIds.length + result.skippedIds.length === 0;
    if (clean) log.info(summary);
    else log.warn(summary + (result.failedIds.length > 0 ? `; failed: [${result.failedIds.join(', ')}] (agents: ${result.failedAgentIds.join(', ')})` : ''));
    sink.transcript.push(msg('conductor', summary));
    if (result.failedIds.length > 0) {
        emitRunEvent('branch:partial-failure', {
            branchName, failedAgentIds: result.failedAgentIds, failedAssignmentIds: result.failedIds,
            completedCount: result.executedIds.length - result.failedIds.length, totalCount: input.assignments.length,
        });
    }
}
