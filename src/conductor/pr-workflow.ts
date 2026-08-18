/**
 * PR Workflow Orchestrator
 *
 * Manages the full lifecycle of a pull request:
 *   branch creation → dev work → PR creation → review loop → merge
 *
 * Called by the dispatcher for each branch group of assignments.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { getLogger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { writeArtifact } from '../agents/_shared/artifact';
import { buildDevAgent, buildStrongFixerAgent } from '../agents/developers/dev-agent.builder';
import { buildReviewerAgent } from '../agents/developers/reviewer-agent.builder';
import { getDevAgent } from '../agents/developers/registry';
import { resolveConventionFiles } from '../utils/coding-conventions';
import { gitExec, gitExecVerbose, gitPush, findGitRoot } from '../utils/git-exec';
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
    DEV_RECURSION_LIMIT, REVIEWER_RECURSION_LIMIT,
    GIT_USER_NAME, GIT_USER_EMAIL,
    PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL, JUNIOR_DEV_MODEL,
    PR_TEST_INSTALL_TIMEOUT_MS, PR_TEST_TIMEOUT_MS,
    SECURITY_GATE_IN_PR,
    AGENT_RESPAWN_ENABLED, AGENT_RESPAWN_MAX_GENERATIONS,
    WORKTREE_SALVAGE_MAX, PR_SALVAGE_PATCHES,
    MERGE_CONFLICT_FIX_ATTEMPTS,
    STRONG_FIXER_MODEL, STRONG_FIXER_ENABLED, STRONG_FIXER_MAX_TOOL_CALLS, STRONG_FIXER_MAX_INPUT_TOKENS,
    PR_EXHAUSTION_STRATEGY,
    MAX_INVOCATION_INPUT_TOKENS, MAX_BRANCH_COST_USD, MAX_BRANCH_WALL_MS,
} from '../config';
import { buildHandoff, renderHandoff, madeProgress } from './agent-respawn';
import { ensureProjectGitignore, getGitignoreEntriesForStack } from '../utils/workspace';
import { getEffectiveLimits, InvocationBudgetExceededError } from '../utils/run-budget';
import { buildWorkspaceSnapshot } from './workspace-snapshot';
import { reconcileFileChanges } from './file-change-reconciliation';
import {
    SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_CHARS, RECONCILE_FILE_CHANGES,
} from '../config';
import { emitRunEvent } from '../utils/event-bus';
import { GITHUB_MODE, createLocalGitHub } from '../utils/github-local';
import { storiesForIds, tasksForIds } from './context-builder';
import {
    isBlockingReview, evaluateProgress, MAX_NO_PROGRESS_ITERATIONS,
    type ReviewOutcome, decideMerge, selectEscalationCandidate,
    evaluateQuorum, enforceCriteriaVerdicts,
} from './review-policy';
import {
    REVIEW_MERGE_POLICY, REVIEW_QUORUM, REVIEW_ABSTAIN_RETRIES,
} from '../config';
import { runQualityGates, gateReportToMarkdown, detectStackRoots } from './quality-gates';
import { runProductVerification } from './product-verify';
import { scanForSecrets, securityReportToMarkdown } from './security-gates';
import {
    captureConfigBaseline, detectTampering, tamperFindingsToMarkdown,
    detectTrivialTests, findTestFiles, findProductSourceFiles, trivialTestSeverity,
    type ConfigBaseline, type TamperFinding,
} from './gate-integrity';
import { GATE_INTEGRITY_MODE, GATE_INTEGRITY_DELETE_TRIVIAL_TESTS } from '../config';
import { classifyPrFailure, isFatalPrFailure } from './pr-failure';
import { resolveKnownConflicts, listConflictedFiles } from './merge-resolve';
import type { CompletionEvidence } from './assignment-policy';
import { parseAgentJson, validateAgentOutput, extractAgentText } from '../utils/structured-output';
import { logAgentResponse } from '../utils/response-log';
import { DeveloperOutputSchema } from '../agents/developers/schemas/dev-output.schema';
import { ReviewOutputSchema } from '../agents/developers/schemas/review-output.schema';
import type { GateReport } from './quality-gates';
import type {
    Assignment, FileChange, ArtifactRef, TranscriptMessage,
    PhaseName, PullRequest, PRReview, GitContext, TechDecision, UserStory, Task,
} from '../agents/_shared/base-schemas';
import type { DeveloperOutput } from '../agents/developers/schemas/dev-output.schema';
import type { ReviewOutput } from '../agents/developers/schemas/review-output.schema';
import { extractTokenUsageFromMessages } from '../utils/token-usage-extractor';
import { tokenTracker, type TokenCallRecord } from '../utils/token-tracker';
import { estimateCost } from '../utils/cost';
import type { DevRank } from '../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

/**
 * Consecutive no-progress respawn generations tolerated before termination
 * (Plan 22, C3). One retry is worth it — the handoff may unblock the agent;
 * four are not: `junior-react` spent 4 respawns and 882k input tokens on
 * reconnaissance in the pacmanclaude run.
 */
const MAX_CONSECUTIVE_ZERO_WRITE_GENERATIONS = 1;

/**
 * Plan 24 B2: branches that have already had a zero-write strong fixer pass.
 * One shot per branch — if the fixer produced nothing, re-running it is waste.
 */
const strongFixerZeroWriteBranches = new Set<string>();

/**
 * Archive a test file the integrity gate is about to delete (Plan 22, F3).
 *
 * Deleting source on the strength of a heuristic must never be unrecoverable.
 * Never throws — a failed archive must not abort the gate.
 */
function archiveDeletedTest(
    outputPath: string | undefined, branchName: string, relPath: string, absPath: string,
): void {
    if (!outputPath) return;
    try {
        const dir = path.join(outputPath, 'deleted-tests', branchName.replace(/[^a-zA-Z0-9._-]+/g, '-'));
        const dest = path.join(dir, relPath.replace(/[\\/]/g, '__'));
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(absPath, dest);
        log.info(`  Archived before deletion: ${dest}`);
    } catch (err: any) {
        log.warn(`Could not archive ${relPath} before deletion: ${err.message}`);
    }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts(): string { return new Date().toISOString(); }

function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: ts(), agentId, phase: 'development' as PhaseName, message };
}

// gitExec, gitPush, findGitRoot imported from ../utils/git-exec

/** Local-mode bare repo path, resolved once per process from gitContext. */
let _localBareRepoPath: string | null = null;

/** Set the bare repo path for local GitHub mode (called by intakeNode). */
export function setLocalBareRepoPath(p: string): void {
    _localBareRepoPath = p;
}

function getOctokit(gitContext?: GitContext | null): Octokit {
    if (GITHUB_MODE === 'local') {
        // Return a local GitHub stand-in backed by a bare repo
        const bareRepoPath = _localBareRepoPath ?? gitContext?.repo ?? '';
        return createLocalGitHub(bareRepoPath) as unknown as Octokit;
    }
    const token = gitContext?.token ?? GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN is not set. Cannot perform GitHub API operations.');
    }
    return new Octokit({ auth: token });
}

/**
 * Create a GitHub PR using curl as a fallback when Octokit fails.
 * This avoids Node.js HTTP stack issues with corporate SSL proxies.
 */
function createPRViaCurl(title: string, body: string, head: string, base: string, gitContext?: GitContext | null): { number: number; html_url: string; node_id: string } {
    const token = gitContext?.token ?? GITHUB_TOKEN;
    const owner = gitContext?.owner ?? GITHUB_OWNER;
    const repo = gitContext?.repo ?? GITHUB_REPO;
    const payload = JSON.stringify({ title, body, head, base });
    const result = execSync(
        `curl -s -X POST "https://api.github.com/repos/${owner}/${repo}/pulls" `
        + `-H "Authorization: token ${token}" `
        + `-H "Accept: application/vnd.github+json" `
        + `-H "Content-Type: application/json" `
        + `--data-binary @-`,
        { encoding: 'utf-8', timeout: 30_000, input: payload },
    ).trim();
    const data = JSON.parse(result);
    if (data.message) {
        throw new Error(`GitHub API error: ${data.message} (${JSON.stringify(data.errors ?? [])})`);
    }
    return { number: data.number, html_url: data.html_url, node_id: data.node_id };
}

// ensureDepsAndRunTests removed — replaced by runQualityGates (fixes A6)

// findGitRoot imported from ../utils/git-exec

// ─── Durable commit (Sub-Plan 06 §2) ────────────────────────────────────────

/**
 * Stage, commit and push whatever is in the worktree. Safe to call repeatedly.
 * MUST be called from a `finally` block after every agent invocation: an agent that
 * throws (recursion limit, loop-guard poisoning, connection error) has usually already
 * written files, and those writes are otherwise lost when the worktree is removed.
 * Returns the new HEAD sha, or null when there was nothing to commit.
 */
export function commitWorktree(
    worktreeWorkspace: string,
    branchName: string,
    projectSlug: string,
    storyId: string,
    type: 'feat' | 'fix' | 'test' | 'refactor' | 'chore',
    subject: string,
    gitContext?: GitContext | null,
): string | null {
    try {
        gitExec(worktreeWorkspace, 'add .');
        const statusOutput = gitExec(worktreeWorkspace, 'status --short');
        if (!statusOutput || statusOutput.includes('nothing to commit') || statusOutput.startsWith('Error:')) {
            return null; // nothing to commit
        }
        const commitMsg = `[${projectSlug}]-[${storyId}]-${type}: ${subject}`;
        gitExec(worktreeWorkspace, `commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
        gitPush(worktreeWorkspace, branchName, gitContext);
        const sha = gitExec(worktreeWorkspace, 'rev-parse HEAD');
        const commit = sha.startsWith('Error:') ? null : sha.trim();

        // Plan 22 G3: a branch is pushed as soon as an agent finishes, but its PR
        // is only opened after every assignment on the branch completes and the
        // gates run. In the pacmanclaude run that left 27 minutes in which the
        // branch had code, no PR existed, and nothing said why — indistinguishable
        // from a crash. Announce the push explicitly.
        log.info(`Branch pushed: ${branchName} @ ${commit?.slice(0, 8) ?? '(unknown)'} — "${subject}" (PR not open yet)`);
        emitRunEvent('branch:pushed', { branchName, commit, subject, type });

        return commit;
    } catch (err: any) {
        log.warn(`commitWorktree failed (non-fatal): ${err.message}`);
        return null;
    }
}

// ─── Worktree salvage (Sub-Plan 06 §3) ──────────────────────────────────────

/**
 * Export a `git format-patch` bundle and a diagnostic README for a branch
 * that failed to merge. The patches are written to `<outputPath>/salvage/<slug>/`.
 */
function salvageWorktree(
    worktreeWorkspace: string,
    _gitRoot: string,
    baseRef: string,
    branchName: string,
    failureReason: string,
    outputPath: string,
): void {
    if (!PR_SALVAGE_PATCHES) return;
    const slug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');
    const salvageDir = path.join(outputPath, 'salvage', slug);
    try {
        fs.mkdirSync(salvageDir, { recursive: true });
        // Export patches
        gitExec(worktreeWorkspace, `format-patch ${baseRef}..HEAD -o "${salvageDir}"`);
        // Write diagnostic README
        const gitLog = gitExec(worktreeWorkspace, 'log --oneline');
        const diffStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}..HEAD`);
        const readme = [
            `# Salvaged branch: ${branchName}`,
            ``,
            `**Base ref:** ${baseRef}`,
            `**Failure reason:** ${failureReason}`,
            `**Salvage date:** ${new Date().toISOString()}`,
            ``,
            `## Commits`,
            '```',
            gitLog,
            '```',
            ``,
            `## Diff stat`,
            '```',
            diffStat,
            '```',
        ].join('\n');
        fs.writeFileSync(path.join(salvageDir, 'README.md'), readme, 'utf-8');
        log.info(`Salvage patches written to ${salvageDir}`);
        emitRunEvent('pr:salvage', { branch: branchName, salvageDir, reason: failureReason });
    } catch (err: any) {
        log.warn(`Salvage export failed (non-fatal): ${err.message}`);
    }
}

/**
 * Evict the oldest failed worktrees beyond the retention cap.
 */
function evictStaleSalvageWorktrees(gitRoot: string): void {
    const failedDir = path.join(gitRoot, '.worktrees-failed');
    if (!fs.existsSync(failedDir)) return;
    try {
        const entries = fs.readdirSync(failedDir)
            .map(name => ({ name, mtime: fs.statSync(path.join(failedDir, name)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime); // oldest first
        while (entries.length > WORKTREE_SALVAGE_MAX) {
            const oldest = entries.shift()!;
            fs.rmSync(path.join(failedDir, oldest.name), { recursive: true, force: true });
            log.info(`Evicted stale salvage worktree: ${oldest.name}`);
        }
    } catch (err: any) {
        log.warn(`Eviction of stale salvage worktrees failed (non-fatal): ${err.message}`);
    }
}

/**
 * Find an existing open PR for the given head branch to avoid 422 errors.
 *
 * Plan 24, A1: the bare-ref fallback is gated on local mode only. In live
 * GitHub mode, `pulls.list({ head: 'branch' })` without the `owner:` prefix
 * is not a head filter — it silently returns the full open-PR list and
 * `data[0]` is whatever PR was opened first. This attached nine branches to
 * the wrong PR in the pacmanclaude run.
 *
 * Both modes validate unconditionally: a candidate is accepted only when
 * `pr.head?.ref === head` (the local stand-in stores `head` as the bare
 * branch name, so one predicate covers both).
 */
async function findExistingPR(
    octokit: any, owner: string, repo: string, head: string,
): Promise<{ number: number; html_url: string; node_id: string; head?: { ref: string } } | null> {
    try {
        const headRef = `${owner}:${head}`;
        const { data } = await octokit.pulls.list({ owner, repo, head: headRef, state: 'open' });
        for (const pr of data) {
            // Validate: candidate's actual head must match the requested branch
            const prHeadRef = pr.head?.ref ?? pr.head;
            if (prHeadRef === head) {
                log.info(`Found existing open PR #${pr.number} for ${head}`);
                return { number: pr.number, html_url: pr.html_url, node_id: pr.node_id ?? `pr-${pr.number}`, head: { ref: prHeadRef } };
            }
            log.warn(`Rejected PR #${pr.number}: head '${prHeadRef}' !== requested '${head}'`);
        }
        // Bare-ref fallback: only in local mode (Plan 24, A1)
        if (GITHUB_MODE === 'local') {
            const { data: data2 } = await octokit.pulls.list({ owner, repo, head, state: 'open' });
            for (const pr of data2) {
                const prHeadRef = pr.head?.ref ?? pr.head;
                if (prHeadRef === head) {
                    log.info(`Found existing open PR #${pr.number} for ${head} (bare)`);
                    return { number: pr.number, html_url: pr.html_url, node_id: pr.node_id ?? `pr-${pr.number}`, head: { ref: prHeadRef } };
                }
                log.warn(`Rejected PR #${pr.number} (bare): head '${prHeadRef}' !== requested '${head}'`);
            }
        }
    } catch (err: any) {
        log.warn(`Failed to list existing PRs: ${err.message}`);
    }
    return null;
}

/**
 * PR identity mismatch error — thrown when the PR about to be merged or
 * whose branch is about to be deleted has a different head than expected.
 * Plan 24, A1: this is the assertion that would have prevented the deletion
 * of `us-010-screen-manager` in the pacmanclaude run.
 */
export class PrIdentityMismatchError extends Error {
    constructor(public readonly prNumber: number, public readonly expectedHead: string, public readonly actualHead: string) {
        super(`PR #${prNumber} head mismatch: expected '${expectedHead}', got '${actualHead}'`);
        this.name = 'PrIdentityMismatchError';
    }
}

// ─── PR title & description builders ─────────────────────────────────────────

function buildPRTitle(assignments: Assignment[], taskType: string, projectSlug: string): string {
    const prefix = taskType === 'bug' ? 'fix' : taskType === 'refactor' ? 'refactor' : 'feat';
    let desc: string;
    if (assignments.length === 1) {
        desc = assignments[0].description.split('.')[0].trim();
    } else {
        // Multiple assignments — summarize
        const storyIds = [...new Set(assignments.map(a => a.storyId))];
        desc = `${assignments[0].description.split('.')[0].trim()} (${storyIds.join(', ')})`;
    }
    // Strip backticks and truncate to 80 chars on word boundary
    desc = desc.replace(/`/g, '');
    if (desc.length > 80) {
        desc = desc.slice(0, 77).replace(/\s+\S*$/, '') + '...';
    }
    return `[${projectSlug}] ${prefix}: ${desc}`;
}

function buildPRDescription(
    assignments: Assignment[],
    fileChanges: FileChange[],
    taskType: string,
    currentState?: string,
    authorAgentId?: string,
): string {
    const sections: string[] = [];

    // Author attribution
    if (authorAgentId) {
        const authorEntry = getDevAgent(authorAgentId);
        const authorLabel = authorEntry ? `${authorEntry.name} (${authorAgentId})` : authorAgentId;
        sections.push(`**Opened by ${authorLabel}**\n`);
    }

    // Task summary
    sections.push('## Task Summary\n');
    for (const a of assignments) {
        sections.push(`- **${a.id}** [${a.priority}/${a.complexity}]: ${a.description}`);
    }

    // Derived actions
    sections.push('\n## Derived Actions\n');
    const storyIds = [...new Set(assignments.map(a => a.storyId))];
    sections.push(`Stories covered: ${storyIds.join(', ')}`);
    sections.push(`Developers involved: ${[...new Set(assignments.map(a => a.devAgentId))].join(', ')}`);

    // Current state (for bug/fix/refactor)
    if (['bug', 'fix', 'refactor'].includes(taskType) && currentState) {
        sections.push('\n## Current State\n');
        sections.push(currentState);
    }

    // Changes made
    sections.push('\n## Changes Made\n');
    if (fileChanges.length > 0) {
        for (const fc of fileChanges) {
            sections.push(`- **${fc.action}** \`${fc.path}\` — ${fc.summary}`);
        }
    } else {
        sections.push('_(changes will be listed after development)_');
    }

    return sections.join('\n');
}

// ─── Agent invocation helpers ────────────────────────────────────────────────

/** Resolve the LLM model name for a developer/reviewer rank. */
function getModelForRank(rank: DevRank): string {
    switch (rank) {
        case 'principal': return PRINCIPAL_DEV_MODEL;
        case 'senior':    return SENIOR_DEV_MODEL;
        case 'junior':    return JUNIOR_DEV_MODEL;
    }
}

/**
 * Parse a single agent invocation result into a DeveloperOutput.
 * Extracted from invokeDevAgent so the respawn loop can call it per-generation.
 */
function parseDevResult(
    result: any, agentId: string, model: string,
    logMeta?: { userMessage?: string; systemPrompt?: string; generation?: number },
): { output: DeveloperOutput; tokenUsage: TokenCallRecord | null } {
    const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, 'development');
    logAgentResponse({
        agentId, phase: 'development', model,
        kind: logMeta?.generation ? 'respawn' : 'invoke',
        attempt: logMeta?.generation,
        userMessage: logMeta?.userMessage,
        systemPrompt: logMeta?.systemPrompt,
    }, result);

    // Guard against empty or missing messages array
    if (!result?.messages || result.messages.length === 0) {
        log.warn(`Dev agent ${agentId} returned no messages — returning empty output`);
        return { output: { fileChanges: [], notes: 'Agent returned no messages (possible tool loop or recursion limit).' }, tokenUsage };
    }

    // Content may be a plain string or an array of blocks (Anthropic streaming,
    // OpenAI Responses API); extractAgentText handles both and skips reasoning.
    const extraction = extractAgentText(result.messages);
    if (extraction.text === null) {
        log.warn(
            `Dev agent ${agentId} returned no text content (${extraction.blockTypes}) — returning empty output`,
        );
        return { output: { fileChanges: [], notes: `Agent returned no text content (${extraction.blockTypes}).` }, tokenUsage };
    }

    const raw = extraction.text;
    const parseResult = parseAgentJson(raw);
    if (!parseResult.ok) {
        throw new Error(`Invalid JSON output from dev agent: ${parseResult.error}`);
    }

    // Validate against DeveloperOutputSchema — throw on failure to enforce schema
    const validation = validateAgentOutput(DeveloperOutputSchema, parseResult.value);
    if (!validation.ok) {
        throw new Error(`Dev agent ${agentId} output failed schema validation:\n${validation.issues}`);
    }
    return { output: validation.value as DeveloperOutput, tokenUsage };
}

/**
 * Invoke a dev agent with optional respawn support.
 *
 * When `buildAgentFn` is provided and `AGENT_RESPAWN_ENABLED` is true, hitting
 * the tool-call ceiling triggers a fresh-context respawn: the current agent's
 * work is summarised into a compact handoff, a new agent is built with a clean
 * MemorySaver, and the handoff is prepended to the original task message.
 *
 * This replaces "poison and flail" with "summarise and respawn", bounding
 * each invocation's context to O(threshold) instead of O(max steps).
 */
async function invokeDevAgent(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, model: string,
    buildAgentFn?: () => any,
    /**
     * Worktree + base ref for ground-truth handoff verification (Plan 22, C1).
     * Without it `buildHandoff` cannot verify anything: `worktreeVerified` stays
     * false, byte sizes are absent, there is no tree snapshot, and `filesWritten`
     * is the agent's claim rather than what is actually on disk — which is how
     * generations that had committed real work were terminated for "zero writes".
     */
    respawnContext?: { worktreeDir: string; baseRef: string },
): Promise<{ output: DeveloperOutput; tokenUsage: TokenCallRecord | null; allTokenUsage?: TokenCallRecord[] }> {
    return retryWithBackoff(async () => {
        // Track the overall dev invocation (spans all respawn generations)
        const invocationId = tokenTracker.startInvocation(agentId, 'development');

        // ── Respawn loop ─────────────────────────────────────────────────
        if (AGENT_RESPAWN_ENABLED && buildAgentFn) {
            const allTokenUsage: TokenCallRecord[] = [];
            let currentAgent = agent;
            let handoff: ReturnType<typeof buildHandoff> | null = null;
            let respawnCount = 0;
            let consecutiveZeroWriteGenerations = 0;

            for (let gen = 0; gen <= AGENT_RESPAWN_MAX_GENERATIONS; gen++) {
                // Build a fresh agent for generations > 0
                if (gen > 0) {
                    currentAgent = buildAgentFn();
                    respawnCount++;
                }

                // Tag LLM calls with the invocation ID
                currentAgent.setInvocationId?.(invocationId);

                // Compose the message: base message + handoff for gen > 0
                const message = (gen === 0 || !handoff)
                    ? userMessage
                    : [userMessage, '\n', renderHandoff(handoff)].join('\n');

                const result = await currentAgent.invoke(
                    { messages: [{ role: 'user', content: message }] },
                    { configurable: { thread_id: `dev-pr-${threadSuffix}-gen${gen}-${Date.now()}` }, recursionLimit: DEV_RECURSION_LIMIT },
                );

                const parsed = parseDevResult(result, agentId, model, {
                    userMessage: message, systemPrompt: currentAgent.systemPromptText, generation: gen || undefined,
                });
                if (parsed.tokenUsage) allTokenUsage.push(parsed.tokenUsage);

                // Plan 24 D1: per-invocation input token ceiling
                if (MAX_INVOCATION_INPUT_TOKENS > 0) {
                    const invInputTokens = tokenTracker.getInvocationInputTokens(invocationId);
                    if (invInputTokens >= MAX_INVOCATION_INPUT_TOKENS) {
                        log.warn(
                            `${agentId} invocation ${invocationId} exceeded input ceiling: `
                            + `${invInputTokens.toLocaleString()} / ${MAX_INVOCATION_INPUT_TOKENS.toLocaleString()} — stopping gracefully`,
                        );
                        tokenTracker.endInvocation(invocationId, respawnCount > 0 ? respawnCount : undefined);
                        throw new InvocationBudgetExceededError(invocationId, invInputTokens, MAX_INVOCATION_INPUT_TOKENS);
                    }
                }

                // Check if ceiling was reached and more generations are available
                const ceilingHit = currentAgent.isCeilingReached?.() ?? false;

                if (!ceilingHit || gen === AGENT_RESPAWN_MAX_GENERATIONS) {
                    // Done — return the final result with all accumulated token usage
                    tokenTracker.endInvocation(invocationId, respawnCount > 0 ? respawnCount : undefined);
                    return {
                        output: parsed.output,
                        tokenUsage: allTokenUsage[0] ?? null,
                        allTokenUsage: allTokenUsage.length > 1 ? allTokenUsage : undefined,
                    };
                }

                // Build handoff for the next generation.
                // Plan 22 C1: pass the worktree so `filesWritten` is ground truth
                // (git diff + git status), sizes are real, and the successor gets a
                // tree snapshot instead of re-discovering the repo.
                const budgetSpent = currentAgent.getToolUsage?.();
                handoff = buildHandoff(
                    result.messages ?? [], gen + 1,
                    respawnContext?.worktreeDir, respawnContext?.baseRef,
                    budgetSpent
                        ? { reads: budgetSpent.reads, writes: budgetSpent.writes, shell: budgetSpent.shell, turns: budgetSpent.turns }
                        : undefined,
                );

                // Plan 22 C3: progress-gated respawn — a generation that neither
                // wrote a file nor got a build/test command to pass does not get
                // another respawn. Consecutive zero-write generations are capped
                // at one so a stuck agent cannot burn all AGENT_RESPAWN_MAX_GENERATIONS
                // on reconnaissance (junior-react spent 4 respawns / 882k input
                // tokens doing exactly that).
                const progressed = madeProgress(handoff);
                if (!progressed) consecutiveZeroWriteGenerations++;
                else consecutiveZeroWriteGenerations = 0;

                if (!progressed && consecutiveZeroWriteGenerations > MAX_CONSECUTIVE_ZERO_WRITE_GENERATIONS) {
                    log.warn(
                        `${agentId} generation ${gen} made no progress `
                        + `(${consecutiveZeroWriteGenerations} consecutive) — terminating instead of respawning`,
                    );
                    tokenTracker.endInvocation(invocationId, respawnCount > 0 ? respawnCount : undefined);
                    return {
                        output: parsed.output,
                        tokenUsage: allTokenUsage[0] ?? null,
                        allTokenUsage: allTokenUsage.length > 1 ? allTokenUsage : undefined,
                    };
                }

                log.info(
                    `Respawning ${agentId} (generation ${gen + 1}): ` +
                    `${handoff.filesWritten.length} files carried forward` +
                    `${handoff.worktreeVerified ? ' (worktree-verified)' : ''}, ` +
                    `${handoff.filesRead.length} already inspected, ` +
                    `handoff ${renderHandoff(handoff).length} chars`,
                );
                emitRunEvent('agent:respawn', {
                    agentId,
                    generation: gen + 1,
                    files: handoff.filesWritten.length,
                });
            }
        }

        // ── Non-respawn path (fallback or no builder provided) ───────────
        agent.setInvocationId?.(invocationId);
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: `dev-pr-${threadSuffix}-${Date.now()}` }, recursionLimit: DEV_RECURSION_LIMIT },
        );
        tokenTracker.endInvocation(invocationId);

        // Plan 24 D1: per-invocation input token ceiling
        if (MAX_INVOCATION_INPUT_TOKENS > 0) {
            const invInputTokens = tokenTracker.getInvocationInputTokens(invocationId);
            if (invInputTokens >= MAX_INVOCATION_INPUT_TOKENS) {
                log.warn(
                    `${agentId} invocation ${invocationId} exceeded input ceiling: `
                    + `${invInputTokens.toLocaleString()} / ${MAX_INVOCATION_INPUT_TOKENS.toLocaleString()} — stopping gracefully`,
                );
                throw new InvocationBudgetExceededError(invocationId, invInputTokens, MAX_INVOCATION_INPUT_TOKENS);
            }
        }

        return parseDevResult(result, agentId, model, {
            userMessage, systemPrompt: agent.systemPromptText,
        });
    }, `dev-${threadSuffix}`);
}

/**
 * Invoke a reviewer agent and return a ReviewOutcome (not a coerced ReviewOutput).
 *
 * Sub-Plan 07: every failure mode returns `abstained` — never a fake `approved`.
 */
async function invokeReviewerAgent(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, model: string,
): Promise<{ outcome: ReviewOutcome; tokenUsage: TokenCallRecord | null }> {
    return retryWithBackoff(async () => {
        // Track this reviewer invocation
        const invocationId = tokenTracker.startInvocation(agentId, 'review');
        agent.setInvocationId?.(invocationId);

        let result: any;
        try {
            result = await agent.invoke(
                { messages: [{ role: 'user', content: userMessage }] },
                { configurable: { thread_id: `review-${threadSuffix}-${Date.now()}` }, recursionLimit: REVIEWER_RECURSION_LIMIT },
            );
        } catch (err: any) {
            const m = String(err?.message ?? err);
            if (m.includes('Recursion limit') || m.includes('recursion limit')) {
                log.warn(`Reviewer ${agentId} hit the recursion limit — abstaining.`);
                tokenTracker.endInvocation(invocationId);
                return {
                    outcome: { kind: 'abstained' as const, reviewerId: agentId, reason: 'recursion-limit' as const, detail: 'Tool-call budget exhausted' },
                    tokenUsage: null,
                };
            }
            tokenTracker.endInvocation(invocationId);
            throw err;   // rate limits stay retriable via retryWithBackoff
        }
        tokenTracker.endInvocation(invocationId);
        const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, 'review');
        logAgentResponse({
            agentId, phase: 'review', model, invocationId, kind: 'invoke',
            userMessage, systemPrompt: agent.systemPromptText,
        }, result);

        // Guard against empty or missing messages — abstain, not approve
        if (!result?.messages || result.messages.length === 0) {
            log.warn(`Reviewer ${agentId} returned no messages — abstaining`);
            return { outcome: { kind: 'abstained' as const, reviewerId: agentId, reason: 'empty-output' as const, detail: 'Reviewer returned no messages' }, tokenUsage };
        }

        const extraction = extractAgentText(result.messages);
        if (extraction.text === null) {
            log.warn(`Reviewer ${agentId} returned no text content (${extraction.blockTypes}) — abstaining`);
            return { outcome: { kind: 'abstained' as const, reviewerId: agentId, reason: 'empty-output' as const, detail: `Reviewer returned no text content (${extraction.blockTypes})` }, tokenUsage };
        }

        const raw = extraction.text;
        const parseResult = parseAgentJson(raw);
        if (!parseResult.ok) {
            throw new Error(`Invalid JSON output from reviewer agent: ${parseResult.error}`);
        }

        // Validate against ReviewOutputSchema — abstain on garbage, not approve
        const validation = validateAgentOutput(ReviewOutputSchema, parseResult.value);
        if (!validation.ok) {
            log.warn(`Reviewer ${agentId} output schema issues — abstaining:\n${validation.issues}`);
            return { outcome: { kind: 'abstained' as const, reviewerId: agentId, reason: 'schema-invalid' as const, detail: `Schema issues: ${validation.issues}` }, tokenUsage };
        }

        const output = validation.value as ReviewOutput;
        // Determine outcome kind from reviewer's stated status
        const kind = output.status === 'approved' ? 'approved' as const : 'changes_requested' as const;
        return { outcome: { kind, reviewerId: agentId, output }, tokenUsage };
    }, `review-${threadSuffix}`);
}

// ─── Escalation helper ──────────────────────────────────────────────────────
// Sub-Plan 07: `selectEscalationCandidate` from review-policy.ts replaces
// the old `findEscalationAgent`. It never returns null for a valid author.

// ─── Base-ref resolution ─────────────────────────────────────────────────────

/**
 * Resolve baseBranch to a ref that exists in the worktree.
 * Worktrees don't have local branches for the base — only origin/ remotes.
 */
function resolveBaseRef(worktreeDir: string, baseBranch: string): string {
    // Try local branch first
    const localCheck = gitExec(worktreeDir, `rev-parse --verify --quiet ${baseBranch}`);
    if (localCheck && !localCheck.startsWith('Error')) return baseBranch;
    // Fall back to origin/<baseBranch>
    const remoteCheck = gitExec(worktreeDir, `rev-parse --verify --quiet origin/${baseBranch}`);
    if (remoteCheck && !remoteCheck.startsWith('Error')) return `origin/${baseBranch}`;
    // Last resort: return as-is
    return baseBranch;
}

// ─── Retry PR creation for continue-run ──────────────────────────────────────

/**
 * Retry PR creation for a branch that had `pr-creation-failed` status.
 * The branch code is already pushed — this only creates the GitHub PR.
 * Returns the updated PullRequest with a real PR number on success,
 * or re-throws on failure so the caller can stop gracefully.
 */
export async function retryFailedPRCreation(
    failedPR: PullRequest,
    baseBranch: string,
    gitContext?: GitContext | null,
): Promise<PullRequest> {
    const ghOwner = gitContext?.owner ?? GITHUB_OWNER;
    const ghRepo = gitContext?.repo ?? GITHUB_REPO;
    const octokit = getOctokit(gitContext);
    const branchName = failedPR.branchName;

    log.info(`Retrying PR creation for branch ${branchName}...`);

    // Check if a PR was created manually or by a previous retry
    const existingPR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
    if (existingPR) {
        log.info(`Found existing PR #${existingPR.number} for ${branchName} — reusing`);
        return {
            ...failedPR,
            id: `PR-${existingPR.number}`,
            prNumber: existingPR.number,
            prUrl: existingPR.html_url,
            status: 'open',
        };
    }

    // Retry with the same retry/backoff logic
    const PR_RETRY_MAX = 3;
    const PR_RETRY_BASE_DELAY_MS = 2_000;
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= PR_RETRY_MAX; attempt++) {
        try {
            const { data } = await octokit.pulls.create({
                owner: ghOwner,
                repo: ghRepo,
                title: failedPR.title,
                body: failedPR.description,
                head: branchName,
                base: baseBranch,
            });
            log.info(`PR #${data.number} created on retry for ${branchName}`);
            emitRunEvent('pr:opened', { prNumber: data.number, title: failedPR.title, branch: branchName, baseBranch });
            return {
                ...failedPR,
                id: `PR-${data.number}`,
                prNumber: data.number,
                prUrl: data.html_url,
                status: 'open',
            };
        } catch (err: any) {
            const classification = classifyPrFailure(err);
            if (isFatalPrFailure(classification)) {
                throw new Error(`Fatal PR error on retry (${classification.kind}): ${classification.message}`);
            }
            if (classification.kind === 'pr-already-exists') {
                const reusePR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
                if (reusePR) {
                    return {
                        ...failedPR,
                        id: `PR-${reusePR.number}`,
                        prNumber: reusePR.number,
                        prUrl: reusePR.html_url,
                        status: 'open',
                    };
                }
            }

            lastErr = err;
            if (classification.retryable && attempt < PR_RETRY_MAX) {
                const delay = PR_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                log.warn(`PR retry attempt ${attempt}/${PR_RETRY_MAX} failed (${classification.kind}) — retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // All retries failed — throw so the caller can stop gracefully again
    throw lastErr ?? new Error(`PR creation retry failed for ${branchName}`);
}

// ─── Main PR workflow ────────────────────────────────────────────────────────

export async function executePRWorkflow(input: PRWorkflowInput): Promise<PRWorkflowResult> {
    const {
        branchName, baseBranch, assignments, reviewerAgentIds, taskType,
        workspacePath, apiKey, contextPrompt, currentState, projectSlug, gitContext,
        techStack, userStories, tasks, isMaintainMode, outputPath,
    } = input;

    // Resolve owner/repo from gitContext (falls back to config constants)
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

    /**
     * Estimate the USD cost of token usage accumulated on this branch so far.
     */
    const estimateBranchCost = (): number => {
        let total = 0;
        for (const t of allTokenUsage) {
            total += estimateCost(t.model, t.inputTokens, t.outputTokens);
        }
        return total;
    };

    /**
     * Check whether this branch has exceeded its wall-time or cost cap.
     * Returns a reason string if exceeded, or null if within budget.
     */
    const checkBranchBudget = (checkpoint: string): string | null => {
        if (MAX_BRANCH_WALL_MS > 0) {
            const elapsedMs = Date.now() - branchStartMs;
            if (elapsedMs >= MAX_BRANCH_WALL_MS) {
                return `wall time ${(elapsedMs / 1000).toFixed(0)}s >= cap ${(MAX_BRANCH_WALL_MS / 1000).toFixed(0)}s at ${checkpoint}`;
            }
        }
        if (MAX_BRANCH_COST_USD > 0) {
            const cost = estimateBranchCost();
            if (cost >= MAX_BRANCH_COST_USD) {
                return `cost $${cost.toFixed(4)} >= cap $${MAX_BRANCH_COST_USD} at ${checkpoint}`;
            }
        }
        return null;
    };

    // ── 0. Create isolated worktree for this branch ─────────────────────
    // Each branch gets its own working directory so parallel agents
    // never interfere with each other via git checkout races.
    const gitRoot = findGitRoot(workspacePath);
    const relativeWorkspace = path.relative(gitRoot, workspacePath);
    const worktreeSlug = branchName.replace(/[^a-zA-Z0-9]+/g, '-');
    const worktreeDir = path.join(gitRoot, '.worktrees', worktreeSlug);
    const worktreeWorkspace = relativeWorkspace
        ? path.join(worktreeDir, relativeWorkspace)
        : worktreeDir;

    log.info(`Creating worktree for branch: ${branchName} (from ${baseBranch})`);

    // Plan 24, A2: remove ANY existing worktree whose branch is this branchName,
    // including ones under .worktrees-failed/ (salvage). Without this, `git branch -D`
    // fails because the salvage worktree still has the branch checked out, then
    // `git worktree add` fails with "A branch named '...' already exists".
    const porcelainOutput = gitExec(gitRoot, 'worktree list --porcelain');
    const worktreeEntries = porcelainOutput.split('\n\n').filter(Boolean);
    for (const entry of worktreeEntries) {
        const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m);
        const pathMatch = entry.match(/^worktree (.+)$/m);
        if (branchMatch && pathMatch && branchMatch[1] === branchName) {
            const existingWtPath = pathMatch[1];
            // Skip if it's the main worktree
            if (existingWtPath === gitRoot) continue;
            log.info(`Removing existing worktree for branch ${branchName}: ${existingWtPath}`);
            gitExec(gitRoot, `worktree remove "${existingWtPath}" --force`);
        }
    }
    // Prune stale worktree tracking entries (e.g. directories deleted but
    // git's internal worktree list not updated — prevents "already checked out" errors)
    gitExec(gitRoot, 'worktree prune');

    // Clean up stale worktree from a previous failed run
    if (fs.existsSync(worktreeDir)) {
        gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
    }
    // Delete stale local branch if it exists (ignore errors).
    // Plan 24, A2: this now succeeds because we removed the worktree above.
    gitExec(gitRoot, `branch -D ${branchName}`);
    // Fetch latest base branch from remote (may fail if not pushed yet)
    gitExec(gitRoot, `fetch origin ${baseBranch}`);
    // Plan 24, A2: if the branch still exists despite deletion attempt (e.g. it's
    // checked out in a worktree we couldn't remove), reuse it with a hard reset.
    const branchExists = !gitExec(gitRoot, `rev-parse --verify refs/heads/${branchName}`).startsWith('Error:');

    // Create worktree with a new branch — try remote ref first, fall back to local.
    // Wrapped in try/catch so a failed creation cleans up the partial directory
    // before re-throwing (fixes A11 worktree leak).
    try {
        let wtResult: string;
        if (branchExists) {
            // Plan 24, A2: reuse existing branch — happens when a salvage worktree
            // held the branch and we couldn't fully remove it, or on a re-dispatch.
            log.info(`Reusing existing branch ${branchName} for a second dispatch round (previous attempt salvaged)`);
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" ${branchName}`);
            if (wtResult.startsWith('Error:')) {
                throw new Error(`Failed to reuse worktree for ${branchName}: ${wtResult}`);
            }
            // Reset to base to discard stale commits from previous attempt
            const resetTarget = gitExec(worktreeDir, `rev-parse --verify origin/${baseBranch}`).startsWith('Error:')
                ? baseBranch
                : `origin/${baseBranch}`;
            const resetResult = gitExec(worktreeDir, `reset --hard ${resetTarget}`);
            if (resetResult.startsWith('Error:')) {
                log.warn(`Reset to ${resetTarget} failed: ${resetResult}`);
            } else {
                log.info(`Reset reused branch to ${resetTarget}`);
            }
        } else {
            wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -b ${branchName} origin/${baseBranch}`);
            if (wtResult.startsWith('Error:')) {
                log.warn(`Remote ref origin/${baseBranch} not found, falling back to local branch`);
                wtResult = gitExec(gitRoot, `worktree add "${worktreeDir}" -b ${branchName} ${baseBranch}`);
            }
            if (wtResult.startsWith('Error:')) {
                throw new Error(`Failed to create worktree for ${branchName}: ${wtResult}`);
            }
        }
        log.info(`Worktree created: ${wtResult}`);
        // Set git identity in the worktree so agent shell commands have valid author
        gitExec(worktreeDir, `config user.name "${GIT_USER_NAME}"`);
        gitExec(worktreeDir, `config user.email "${GIT_USER_EMAIL}"`);
        // Ensure the workspace sub-directory exists in the worktree
        fs.mkdirSync(worktreeWorkspace, { recursive: true });
        allTranscript.push(msg('conductor', `Created isolated worktree for branch: ${branchName} from ${baseBranch}`));
    } catch (wtCreateErr) {
        // Clean up any partial worktree directory so it does not leak (fixes A11)
        if (fs.existsSync(worktreeDir)) {
            gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
        }
        gitExec(gitRoot, 'worktree prune');
        throw wtCreateErr;
    }

    try {
        // Fetch base branch and resolve to a ref that exists in the worktree
        gitExec(worktreeWorkspace, `fetch origin ${baseBranch}`);
        const baseRef = resolveBaseRef(worktreeWorkspace, baseBranch);

        // Plan 22 C1: ground truth for every respawn handoff in this workflow.
        const respawnCtx = { worktreeDir: worktreeWorkspace, baseRef };

        /**
         * Reconcile a fix/repair/escalation agent's claimed `fileChanges` against
         * the worktree and return only what is really on disk (Plan 22, C4).
         *
         * The initial dev path already did this; the fix paths reported claims
         * verbatim. In the pacmanclaude run a generation with zero `write_file`
         * calls claimed three files and the log dutifully said
         * `Fix complete: 3 changes` — a hallucinated fix that the review loop then
         * treated as real work.
         */
        const reconcileClaims = (who: string, claimed?: FileChange[]): FileChange[] => {
            if (!claimed?.length) return [];
            if (!RECONCILE_FILE_CHANGES) return claimed;
            const recon = reconcileFileChanges(worktreeWorkspace, claimed);
            if (recon.phantoms.length > 0 || recon.unreported.length > 0) {
                log.warn(
                    `${who} claimed ${claimed.length} changes; ${recon.verified.length} verified, ` +
                    `${recon.phantoms.length} phantom, ${recon.unreported.length} unreported`,
                );
                allPhantomFileChanges.push(...recon.phantoms);
            }
            return [...recon.verified, ...recon.unreported];
        };

        // ── 0b. Ensure the worktree carries the stack-aware .gitignore ────
        // Plan 22 G2: ensureProjectGitignore only ever ran on the main workspace,
        // so feature branches never received the Playwright/Vitest artifact
        // entries. `junior-react` consequently committed 111 test-results/ files
        // and 7 playwright-report/ files onto this branch.
        try {
            ensureProjectGitignore(worktreeWorkspace, [
                ...getGitignoreEntriesForStack(techStack),
                '.conventions/', '.worktrees/', '.worktrees-failed/', '.agent/',
            ]);
        } catch (giErr: any) {
            log.warn(`Could not refresh .gitignore in worktree: ${giErr.message}`);
        }

        // ── 0a. Capture per-branch config baseline for tamper detection ──
        let branchBaseline: ConfigBaseline | null = null;
        if (GATE_INTEGRITY_MODE !== 'off') {
            try {
                const worktreeRoots = detectStackRoots(worktreeWorkspace);
                branchBaseline = captureConfigBaseline(worktreeWorkspace, worktreeRoots);
                log.info(`Config baseline captured: ${Object.keys(branchBaseline.scripts).length} package.json(s), ${branchBaseline.testFiles.length} test files`);
            } catch (blErr: any) {
                log.warn(`Config baseline capture failed (non-fatal): ${blErr.message}`);
            }
        }

        // ── 1. Run dev agent(s) on assignments ──────────────────────────
        // Group by developer agent
        const byDev = new Map<string, Assignment[]>();
        for (const a of assignments) {
            const existing = byDev.get(a.devAgentId) ?? [];
            existing.push(a);
            byDev.set(a.devAgentId, existing);
        }

        for (const [devId, devAssignments] of byDev) {
            // Plan 24 D2: check branch budget before each dev invocation
            const branchBudgetReason = checkBranchBudget(`before dev ${devId}`);
            if (branchBudgetReason) {
                log.warn(`Branch ${branchName} budget exceeded: ${branchBudgetReason} — stopping branch`);
                allTranscript.push(msg('conductor', `Branch budget exceeded: ${branchBudgetReason}`));
                emitRunEvent('branch:budget-exceeded', { branchName, reason: branchBudgetReason, checkpoint: `before dev ${devId}` });
                // Salvage worktree and commit any partial work
                commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'chore',
                    `partial work before budget stop`, gitContext);
                if (outputPath) {
                    salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName, branchBudgetReason, outputPath);
                }
                break;
            }

            const entry = getDevAgent(devId);
            if (!entry) {
                log.warn(`Unknown dev agent: ${devId}, skipping`);
                continue;
            }

            const devLog = getLogger(entry.tag, entry.colorCode);
            devLog.info(`Working on branch ${branchName}: ${devAssignments.length} assignment(s)`);

            const conventionFiles = resolveConventionFiles(entry.languages, techStack);
            const buildAgentFn = () => buildDevAgent(apiKey, entry, worktreeWorkspace, gitContext, baseBranch, conventionFiles, isMaintainMode);
            const agent = buildAgentFn();

            const assignmentText = devAssignments.map(a =>
                `Assignment ${a.id} [${a.priority}/${a.complexity}]: ${a.description}`
            ).join('\n\n');

            // Build the per-branch story section (fixes A8: every dev got all stories)
            const branchStoryIds = [...new Set(devAssignments.flatMap(a => [a.storyId, ...(a.additionalStoryIds ?? [])]).filter(Boolean))] as string[];
            let storySection = '';
            if (userStories?.length && branchStoryIds.length) {
                const { text: storyText, missing: missingStoryIds } = storiesForIds(userStories, branchStoryIds);
                storySection = `\n## User Stories for This Branch\n\n${storyText}`;
                if (missingStoryIds.length > 0) {
                    log.error(`Assignment(s) on branch ${branchName} reference unknown story id(s): ${missingStoryIds.join(', ')} — the developer will have NO acceptance criteria. This is a planning defect.`);
                }
            }

            // Build the per-branch task section (P11: task descriptions now reach developers)
            const branchTaskIds = [...new Set(devAssignments.flatMap(a => a.taskIds ?? []))];
            const taskSection = (tasks?.length && branchTaskIds.length)
                ? `\n## Tasks for This Branch\n\n${tasksForIds(tasks, branchTaskIds)}`
                : '';

            // Sub-Plan 08 §2: inject workspace snapshot so agents stop wasting
            // tool budget on `list_dir` / `read_file package.json` reconnaissance
            let snapshotSection = '';
            try {
                snapshotSection = '\n' + buildWorkspaceSnapshot(worktreeWorkspace, {
                    maxFiles: SNAPSHOT_MAX_FILES,
                    maxChars: SNAPSHOT_MAX_CHARS,
                });
            } catch (snapErr: any) {
                log.warn(`Workspace snapshot failed (non-fatal): ${snapErr.message}`);
            }

            const message = [
                contextPrompt,
                snapshotSection,
                storySection,
                taskSection,
                `\n## Project Slug: ${projectSlug}`,
                `\n## Your Branch: ${branchName}`,
                `\nYou are already on this branch. Do NOT create or switch branches — your workspace is isolated for this branch.`,
                `\n## IMPORTANT: Workspace Context`,
                `Your current working directory IS the project root.`,
                `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                `\n## Your Assignments\n\n${assignmentText}`,
            ].join('\n');

            try {
                const devModel = getModelForRank(entry.rank as DevRank);
                const { output, tokenUsage: devTokenUsage, allTokenUsage: devAllTokenUsage } = await invokeDevAgent(agent, message, `${entry.id}-${branchName}`, entry.id, devModel, buildAgentFn, respawnCtx);
                if (devTokenUsage) allTokenUsage.push(devTokenUsage);
                if (devAllTokenUsage) allTokenUsage.push(...devAllTokenUsage.slice(1)); // first already pushed above

                // Sub-Plan 08 §7: reconcile agent-claimed fileChanges against the worktree
                if (RECONCILE_FILE_CHANGES && output.fileChanges?.length) {
                    const recon = reconcileFileChanges(worktreeWorkspace, output.fileChanges);
                    if (recon.phantoms.length > 0 || recon.unreported.length > 0) {
                        log.warn(
                            `${entry.id} claimed ${output.fileChanges.length} changes; ` +
                            `${recon.verified.length} verified, ${recon.phantoms.length} phantom, ${recon.unreported.length} unreported`,
                        );
                        allPhantomFileChanges.push(...recon.phantoms);
                    }
                    allFileChanges.push(...recon.verified, ...recon.unreported);
                } else if (output.fileChanges) {
                    allFileChanges.push(...output.fileChanges);
                }

                const artifact = writeArtifact({
                    agentId: entry.id,
                    colorCode: entry.colorCode,
                    workspacePath: worktreeWorkspace,
                    outputPath,
                    title: `${entry.name} Mission Report`,
                    content: [
                        `## Branch: ${branchName}\n`,
                        `## Files Changed\n`,
                        ...(output.fileChanges ?? []).map(fc =>
                            `- **${fc.action}** \`${fc.path}\` — ${fc.summary}`
                        ),
                        output.notes ? `\n## Notes\n\n${output.notes}` : '',
                        output.mermaidDiagram ? `\n## Diagram\n\n\`\`\`mermaid\n${output.mermaidDiagram}\n\`\`\`` : '',
                    ].join('\n'),
                });
                allArtifacts.push(artifact);
                allTranscript.push(msg(entry.id, `Completed ${output.fileChanges?.length ?? 0} file changes on branch ${branchName}`));
                devLog.info(`Done: ${output.fileChanges?.length ?? 0} file changes`);
            } catch (err: any) {
                // Plan 24 D1: invocation budget exceeded is a graceful stop, not a failure
                if (err instanceof InvocationBudgetExceededError) {
                    log.warn(`Dev agent ${devId} stopped: ${err.message}`);
                    allTranscript.push(msg(devId, `Stopped (invocation budget exceeded): ${err.message}`));
                } else {
                    log.error(`Dev agent ${devId} failed: ${err.message}`);
                    allTranscript.push(msg(devId, `Failed: ${err.message}`));
                }
            } finally {
                // Sub-Plan 06 §2: commit in finally — agent may have written files before throwing
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

        // Plan 22 G3: all assignments are done and the branch is fully pushed —
        // the PR opens only after the gates below finish, which can take tens of
        // minutes. Say so, so "branch has code, no PR" is never a mystery.
        log.info(
            `All ${assignments.length} assignment(s) complete on ${branchName} — running quality gates before opening the PR`,
        );
        emitRunEvent('branch:pr-pending', {
            branchName,
            assignments: assignments.length,
            reason: 'quality-gates',
        });

        // ── 1a. Post-development quality gate verification (fixes A6) ──
        // Run multi-language quality gates (install/build/lint/test) to detect
        // failures early. If gates fail and effective prTestRepairAttempts > 0, give
        // the dev agent a repair attempt before opening the PR.
        // Also run product verification (artifacts+resolve only — no smoke server in PR worktrees).
        let gateReport: GateReport | null = null;
        try {
            // Run artifact and resolve checks in the worktree (cheap, deterministic)
            let productVerifyReport;
            try {
                const worktreeRoots = detectStackRoots(worktreeWorkspace);
                productVerifyReport = await runProductVerification(worktreeWorkspace, worktreeRoots, 'artifacts+resolve');
                log.info(`Product verification: artifacts=${productVerifyReport.artifacts.filter(a => a.passed).length}/${productVerifyReport.artifacts.length}, unresolved refs=${productVerifyReport.resolveIssues.length}`);
            } catch (pvErr: any) {
                log.warn(`Product verification error (non-fatal): ${pvErr.message}`);
            }

            gateReport = runQualityGates(worktreeWorkspace, {
                timeoutMs: PR_TEST_TIMEOUT_MS,
                installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
                productVerify: productVerifyReport,
            });
            if (gateReport && gateReport.results.length > 0) {
                if (gateReport.passed) {
                    log.info(`Quality gates passed on branch ${branchName}`);
                    allTranscript.push(msg('conductor', `Quality gates passed on branch ${branchName}`));
                } else {
                    const failingSteps = gateReport.results
                        .filter(r => !r.passed && !r.skipped)
                        .map(r => `${r.step}: ${r.output.slice(0, 200)}`);
                    log.warn(`Quality gates FAILED on branch ${branchName} — giving dev agent a repair attempt`);
                    allTranscript.push(msg('conductor', `WARNING: Quality gates failed on branch ${branchName}:\n${failingSteps.join('\n').slice(0, 500)}`));

                    // Automated repair: re-invoke the primary dev agent with failing step output
                    const effectiveRepairAttempts = getEffectiveLimits().prTestRepairAttempts;
                    if (effectiveRepairAttempts > 0) {
                        for (let repair = 0; repair < effectiveRepairAttempts; repair++) {
                            try {
                                const primaryDevId = assignments[0].devAgentId;
                                const primaryEntry = getDevAgent(primaryDevId);
                                if (!primaryEntry) break;

                                const repairConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                                const buildRepairAgentFn = () => buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, repairConventions, isMaintainMode);
                                const repairAgent = buildRepairAgentFn();

                                // Feed only the failing steps to the repair agent
                                const failDetails = gateReport.results
                                    .filter(r => !r.passed && !r.skipped)
                                    .map(r => `### ${r.step} (\`${r.command}\`)\n\`\`\`\n${r.output.slice(-1000)}\n\`\`\``)
                                    .join('\n\n');

                                const repairMsg = [
                                    contextPrompt,
                                    `\n## Project Slug: ${projectSlug}`,
                                    `\n## Your Branch: ${branchName}`,
                                    `\nYou are already on this branch. Do NOT switch branches.`,
                                    `\n## IMPORTANT: Workspace Context`,
                                    `Your current working directory IS the project root.`,
                                    `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                                    `\n## Failing Quality Gate Steps\n\n${failDetails}`,
                                    `\n## Instructions`,
                                    `Fix the SOURCE CODE so that the project's EXISTING build, lint and test commands pass unchanged.`,
                                    ``,
                                    `HARD CONSTRAINTS — these are enforced mechanically, not on trust:`,
                                    `- You MUST NOT modify \`scripts\` in any package.json. The \`build\`, \`test\`, \`lint\` and`,
                                    `  \`typecheck\` commands are frozen. Writes to protected config files are REFUSED by your tools.`,
                                    `- You MUST NOT delete, rename, skip (\`it.skip\`, \`xit\`, \`--passWithNoTests\`) or weaken any test.`,
                                    `- You MUST NOT add a test whose subject is not part of the application (a test for a helper that`,
                                    `  nothing imports does not count and will be rejected).`,
                                    `- You MUST NOT remove dependencies, remove \`workspaces\`, relax \`tsconfig\` strictness, or add`,
                                    `  entries to \`.gitignore\`/eslint ignore files.`,
                                    `- If the build fails because a file is missing, CREATE THE MISSING FILE.`,
                                    `- If the build fails because an import path is wrong, FIX THE IMPORT.`,
                                    `Any of the above is detected by a baseline diff; the change is reverted and the PR is blocked.`,
                                ].join('\n');

                                log.info(`Quality gate repair attempt ${repair + 1}/${effectiveRepairAttempts}`);
                                const repairModel = getModelForRank(primaryEntry.rank as DevRank);
                                const { output: repairOutput, tokenUsage: repairTokenUsage } = await invokeDevAgent(
                                    repairAgent, repairMsg, `repair-${primaryEntry.id}-${branchName}`, primaryEntry.id, repairModel,
                                    buildRepairAgentFn, respawnCtx,
                                );
                                if (repairTokenUsage) allTokenUsage.push(repairTokenUsage);
                                const repairChanges = reconcileClaims(`${primaryEntry.id} (gate repair)`, repairOutput.fileChanges);
                                allFileChanges.push(...repairChanges);
                            } catch (repairErr: any) {
                                log.warn(`Quality gate repair attempt failed (non-fatal): ${repairErr.message}`);
                            } finally {
                                // Sub-Plan 06 §2: commit repair work in finally
                                commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                                    `repair failing quality gates (attempt ${repair + 1})`, gitContext);
                            }

                            try {
                                // Re-run quality gates
                                gateReport = runQualityGates(worktreeWorkspace, {
                                    timeoutMs: PR_TEST_TIMEOUT_MS,
                                    installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
                                });
                                if (gateReport?.passed) {
                                    log.info(`Quality gates passed after repair attempt ${repair + 1}`);
                                    allTranscript.push(msg('conductor', `Quality gates passed after repair attempt ${repair + 1}`));
                                    break;
                                }
                            } catch (gateErr: any) {
                                log.warn(`Quality gate re-run failed: ${gateErr.message}`);
                            }
                        }
                    }
                }
            }
        } catch (testErr: any) {
            log.warn(`Post-dev quality gate error: ${testErr.message}`);
        }

        // ── 1b. Gate integrity: tamper detection ──────────────────────────
        let integrityFindings: TamperFinding[] = [];
        if (GATE_INTEGRITY_MODE !== 'off' && branchBaseline) {
            try {
                const currentRoots = detectStackRoots(worktreeWorkspace);
                const currentBaseline = captureConfigBaseline(worktreeWorkspace, currentRoots);
                integrityFindings = detectTampering(branchBaseline, currentBaseline, worktreeWorkspace);

                // Also run trivial test detection
                const testFiles = findTestFiles(worktreeWorkspace);
                const productFiles = findProductSourceFiles(worktreeWorkspace);
                const trivialFindings = detectTrivialTests(worktreeWorkspace, testFiles, productFiles);
                for (const tf of trivialFindings) {
                    // Check if this is a new test file (not in baseline)
                    if (!branchBaseline.testFiles.includes(tf.file)) {
                        integrityFindings.push({
                            kind: 'trivial-test-added',
                            // Plan 22 F3: heuristic import-graph reasons are `major`
                            // (report only); unambiguous gate-gaming stays `critical`.
                            severity: trivialTestSeverity(tf.reason),
                            file: tf.file,
                            detail: `${tf.reason}: ${tf.detail}`,
                        });
                    }
                }

                if (integrityFindings.length > 0) {
                    const criticals = integrityFindings.filter(f => f.severity === 'critical');
                    log.error(`Gate integrity: ${integrityFindings.length} finding(s) (${criticals.length} critical)`);
                    for (const f of integrityFindings) {
                        log.error(`  [${f.severity.toUpperCase()}] ${f.kind}: ${f.file} — ${f.detail}`);
                    }
                    allTranscript.push(msg('conductor', `Gate integrity: ${integrityFindings.length} finding(s) detected\n${integrityFindings.map(f => `- [${f.severity}] ${f.kind}: ${f.detail}`).join('\n')}`));

                    if (criticals.length > 0 && GATE_INTEGRITY_MODE === 'enforce') {
                        // Plan 24 B3: remember pre-revert gate status so we can
                        // detect revert-induced failures and undo them.
                        const gatesGreenBeforeRevert = gateReport?.passed ?? false;

                        // Snapshot the current (pre-revert) content of files we are
                        // about to overwrite, so we can restore if the revert breaks gates.
                        const preRevertBodies: Record<string, string> = {};
                        for (const [relPath, body] of Object.entries(branchBaseline.protectedBodies)) {
                            const absPath = path.join(worktreeWorkspace, relPath);
                            if (fs.existsSync(absPath)) {
                                const currentBody = fs.readFileSync(absPath, 'utf-8');
                                if (currentBody !== body) {
                                    preRevertBodies[relPath] = currentBody;
                                }
                            }
                        }

                        // Revert protected files to baseline content
                        log.warn('Reverting protected files to baseline content...');
                        for (const [relPath, body] of Object.entries(branchBaseline.protectedBodies)) {
                            const absPath = path.join(worktreeWorkspace, relPath);
                            if (fs.existsSync(absPath)) {
                                const currentBody = fs.readFileSync(absPath, 'utf-8');
                                if (currentBody !== body) {
                                    fs.writeFileSync(absPath, body, 'utf-8');
                                    log.info(`  Reverted: ${relPath}`);
                                }
                            }
                        }

                        // Delete fabricated test files (in current but not baseline).
                        //
                        // Plan 22 F3: only CRITICAL trivial-test findings are eligible,
                        // deletion is behind GATE_INTEGRITY_DELETE_TRIVIAL_TESTS
                        // (default false), and every deleted body is archived to
                        // outputs/<run>/deleted-tests/ so a false positive is
                        // recoverable. Previously every `trivial-test-added` finding —
                        // including the purely heuristic `no-product-import` — was
                        // unlinked and the deletion pushed.
                        const deletableTests = integrityFindings.filter(
                            f => f.kind === 'trivial-test-added' && f.severity === 'critical',
                        );
                        const reportOnlyTests = integrityFindings.filter(
                            f => f.kind === 'trivial-test-added' && f.severity !== 'critical',
                        );
                        if (reportOnlyTests.length > 0) {
                            log.warn(
                                `  ${reportOnlyTests.length} trivial-test finding(s) are heuristic — reported, not deleted: `
                                + reportOnlyTests.map(f => f.file).join(', '),
                            );
                        }
                        if (deletableTests.length > 0 && !GATE_INTEGRITY_DELETE_TRIVIAL_TESTS) {
                            log.warn(
                                `  ${deletableTests.length} fabricated test(s) left in place `
                                + '(GATE_INTEGRITY_DELETE_TRIVIAL_TESTS=false) — reported to reviewers instead',
                            );
                        }
                        if (deletableTests.length > 0 && GATE_INTEGRITY_DELETE_TRIVIAL_TESTS) {
                            for (const f of deletableTests) {
                                const absPath = path.join(worktreeWorkspace, f.file);
                                if (!fs.existsSync(absPath)) continue;
                                archiveDeletedTest(outputPath, branchName, f.file, absPath);
                                fs.unlinkSync(absPath);
                                log.info(`  Deleted fabricated test: ${f.file}`);
                            }
                        }

                        // Re-commit reverted state
                        gitExec(worktreeWorkspace, 'add .');
                        const revertStatus = gitExec(worktreeWorkspace, 'status --short');
                        if (revertStatus && !revertStatus.includes('nothing to commit')) {
                            gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-integrity: revert tampering — ${criticals.length} critical finding(s)"`);
                            gitPush(worktreeWorkspace, branchName, gitContext);
                        }

                        // Re-run quality gates on reverted tree
                        try {
                            gateReport = runQualityGates(worktreeWorkspace, {
                                timeoutMs: PR_TEST_TIMEOUT_MS,
                                installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
                            });
                            log.info(`Quality gates after revert: ${gateReport?.passed ? 'passed' : 'failed'}`);

                            // Plan 24 B3: if gates were green before the revert and red
                            // after, the revert itself broke them. Restore the reverted
                            // content, record a config-change finding at major, and emit
                            // an event. Never let revert-induced failures reach decideMerge.
                            if (gatesGreenBeforeRevert && gateReport && !gateReport.passed) {
                                log.warn('Revert broke quality gates — restoring pre-revert content and flagging as config-change');
                                for (const [relPath, body] of Object.entries(preRevertBodies)) {
                                    const absPath = path.join(worktreeWorkspace, relPath);
                                    fs.writeFileSync(absPath, body, 'utf-8');
                                    log.info(`  Restored: ${relPath}`);
                                }

                                // Re-commit restored state
                                gitExec(worktreeWorkspace, 'add .');
                                const restoreStatus = gitExec(worktreeWorkspace, 'status --short');
                                if (restoreStatus && !restoreStatus.includes('nothing to commit')) {
                                    gitExec(worktreeWorkspace, `commit -m "[${projectSlug}]-integrity: restore config (revert broke gates)"`);
                                    gitPush(worktreeWorkspace, branchName, gitContext);
                                }

                                // Record as a major (informational) finding, not a gate blocker
                                integrityFindings.push({
                                    kind: 'config-change-by-feature-branch',
                                    severity: 'major',
                                    file: Object.keys(preRevertBodies).join(', '),
                                    detail: 'config-change-by-feature-branch: feature branch config changes are required for gates to pass',
                                });

                                emitRunEvent('pr:config-change-flagged', {
                                    branch: branchName,
                                    files: Object.keys(preRevertBodies),
                                });

                                // Restore the pre-revert gate report so the revert-induced
                                // failure does not reach decideMerge as a blocker.
                                gateReport = runQualityGates(worktreeWorkspace, {
                                    timeoutMs: PR_TEST_TIMEOUT_MS,
                                    installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
                                });
                            }
                        } catch (rerunErr: any) {
                            log.warn(`Quality gate re-run after revert failed: ${rerunErr.message}`);
                        }
                    }
                }
            } catch (intErr: any) {
                log.warn(`Gate integrity check failed (non-fatal): ${intErr.message}`);
            }
        }

        // ── 1c. Check for actual commits before creating PR ─────────────
        // If no commits exist between base and this branch, skip PR creation
        // to avoid the "No commits between" GitHub API error.
        const diffCheck = gitExec(worktreeWorkspace, `log ${baseRef}..HEAD --oneline`);
        if (!diffCheck || diffCheck.startsWith('Error:') || diffCheck.trim() === '') {
            log.warn(`No commits on branch ${branchName} relative to ${baseBranch} — skipping PR creation`);
            allTranscript.push(msg('conductor', `Skipped PR for ${branchName}: no commits (dev agent produced no changes)`));

            const pullRequest: PullRequest = {
                id: `PR-SKIPPED-${branchName}`,
                prNumber: 0,
                prUrl: '',
                title: `[SKIPPED] No changes on ${branchName}`,
                description: 'Dev agent did not produce any commits.',
                branchName,
                authorAgentId: assignments[0].devAgentId,
                reviewerAgentIds,
                reviews: [],
                status: 'closed',
                assignmentIds: assignments.map(a => a.id),
                taskType,
                currentState,
            };
            return {
                pullRequest,
                fileChanges: allFileChanges,
                artifacts: allArtifacts,
                transcript: allTranscript,
                tokenUsage: allTokenUsage,
            };
        }

        // ── 2. Create GitHub PR ─────────────────────────────────────────
        const prTitle = buildPRTitle(assignments, taskType, projectSlug);
        let prBody = buildPRDescription(assignments, allFileChanges, taskType, currentState, assignments[0].devAgentId);
        // Append quality gate results to the PR description
        if (gateReport && gateReport.results.length > 0) {
            prBody += `\n\n## Quality Gates\n\n${gateReportToMarkdown(gateReport)}`;
        }
        // Append gate integrity findings to the PR description
        // Plan 24 B4: split major findings into an informational section
        if (integrityFindings.length > 0) {
            const criticalFindings = integrityFindings.filter(f => f.severity === 'critical');
            const majorFindings = integrityFindings.filter(f => f.severity === 'major');
            if (criticalFindings.length > 0) {
                prBody += `\n\n${tamperFindingsToMarkdown(criticalFindings)}`;
            }
            if (majorFindings.length > 0) {
                prBody += `\n\n## Heuristic findings (informational)\n\n`
                    + '| Severity | Kind | File | Detail |\n'
                    + '|----------|------|------|--------|\n'
                    + majorFindings.map(f => `| ${f.severity.toUpperCase()} | ${f.kind} | \`${f.file}\` | ${f.detail} |`).join('\n');
            }
        }

        // ── 1c. Secret scan before PR (when SECURITY_GATE_IN_PR=true) ────
        let secretsBlockMerge = false;
        if (SECURITY_GATE_IN_PR) {
            try {
                const secretFindings = scanForSecrets(worktreeWorkspace);
                if (secretFindings.length > 0) {
                    const criticalCount = secretFindings.filter(f => f.severity === 'critical').length;
                    log.warn(`Secret scan: ${secretFindings.length} finding(s), ${criticalCount} critical`);
                    prBody += `\n\n## Security Scan\n\n${securityReportToMarkdown({ findings: secretFindings, passed: criticalCount === 0 })}`;
                    // A critical secret finding blocks the merge
                    if (criticalCount > 0) {
                        secretsBlockMerge = true;
                        log.error(`Critical secrets detected — merge will be blocked`);
                        allTranscript.push(msg('security-gates', `PR ${branchName}: BLOCKED — ${criticalCount} critical secret(s) detected`));
                    }
                }
            } catch (secErr: any) {
                log.warn(`PR secret scan error (non-fatal): ${secErr.message}`);
            }
        }

        log.info(`Creating PR: "${prTitle}"`);
        const octokit = getOctokit(gitContext);
        let ghPr!: { number: number; html_url: string; node_id: string; head?: { ref: string } };

        // Sub-Plan 06 §4: Check for existing open PR before creating (prevents 422 deadlock)
        const existingPR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
        if (existingPR) {
            ghPr = existingPR;
            log.info(`Reusing existing PR #${ghPr.number} for ${branchName}`);
            // Update the PR body with current changes
            try {
                await octokit.pulls.update({
                    owner: ghOwner, repo: ghRepo,
                    pull_number: ghPr.number,
                    body: prBody,
                });
            } catch (updateErr: any) {
                log.warn(`Failed to update existing PR body: ${updateErr.message}`);
            }
        } else {
            // Retry loop for transient GitHub failures (server-error, network, rate-limit)
            const PR_CREATE_MAX_RETRIES = 3;
            const PR_CREATE_BASE_DELAY_MS = 2_000;
            let prCreationFailed: Error | null = null;
            for (let attempt = 1; attempt <= PR_CREATE_MAX_RETRIES; attempt++) {
                try {
                    const { data } = await octokit.pulls.create({
                        owner: ghOwner,
                        repo: ghRepo,
                        title: prTitle,
                        body: prBody,
                        head: branchName,
                        base: baseBranch,
                    });
                    ghPr = { number: data.number, html_url: data.html_url, node_id: data.node_id };
                    break; // success
                } catch (octokitErr: any) {
                    // Sub-Plan 06 §4: classify the error
                    const classification = classifyPrFailure(octokitErr);

                    // Auth errors are fatal — stop the entire run
                    if (isFatalPrFailure(classification)) {
                        throw new Error(`Fatal PR error (${classification.kind}): ${classification.message}`);
                    }

                    // pr-already-exists: list and reuse instead of falling back to curl
                    if (classification.kind === 'pr-already-exists') {
                        const reusePR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
                        if (reusePR) {
                            ghPr = reusePR;
                            log.info(`Reusing existing PR #${ghPr.number} after 422`);
                        } else {
                            prCreationFailed = octokitErr;
                        }
                        break;
                    } else if (GITHUB_MODE === 'local') {
                        // In local mode, Octokit is a local stand-in — do not fall back to curl
                        prCreationFailed = octokitErr;
                        break;
                    } else {
                        log.warn(`Octokit PR creation failed (${classification.kind}), falling back to curl`);
                        try {
                            ghPr = createPRViaCurl(prTitle, prBody, branchName, baseBranch, gitContext);
                            break; // curl succeeded
                        } catch (curlErr: any) {
                            const curlClassification = classifyPrFailure(curlErr);
                            if (curlClassification.kind === 'pr-already-exists') {
                                const reusePR = await findExistingPR(octokit, ghOwner, ghRepo, branchName);
                                if (reusePR) {
                                    ghPr = reusePR;
                                    log.info(`Reusing existing PR #${ghPr.number} after curl 422`);
                                } else {
                                    prCreationFailed = curlErr;
                                }
                                break;
                            } else if (curlClassification.retryable && attempt < PR_CREATE_MAX_RETRIES) {
                                const delay = PR_CREATE_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                                log.warn(`PR creation attempt ${attempt}/${PR_CREATE_MAX_RETRIES} failed (${curlClassification.kind}) — retrying in ${delay}ms`);
                                await new Promise(r => setTimeout(r, delay));
                                prCreationFailed = curlErr; // will be cleared if next attempt succeeds
                                continue; // retry the whole attempt
                            } else {
                                prCreationFailed = curlErr;
                                break;
                            }
                        }
                    }
                }
            }

            // PR creation failed after all retries — return a failed result
            // so the dispatcher can persist state and stop gracefully.
            // The branch code is already pushed; continue-run will retry PR creation.
            if (prCreationFailed) {
                const failMsg = prCreationFailed.message || String(prCreationFailed);
                log.error(`PR creation failed after ${PR_CREATE_MAX_RETRIES} attempts: ${failMsg}`);
                allTranscript.push(msg('conductor', `PR creation failed for ${branchName}: ${failMsg}`));

                const failedPullRequest: PullRequest = {
                    id: `PR-FAILED-${branchName}`,
                    prNumber: 0,
                    prUrl: '',
                    title: prTitle,
                    description: prBody.slice(0, 500),
                    branchName,
                    authorAgentId: assignments[0].devAgentId,
                    reviewerAgentIds,
                    reviews: [],
                    status: 'pr-creation-failed',
                    assignmentIds: assignments.map(a => a.id),
                    taskType,
                    currentState,
                };
                return {
                    pullRequest: failedPullRequest,
                    fileChanges: allFileChanges,
                    artifacts: allArtifacts,
                    transcript: allTranscript,
                    tokenUsage: allTokenUsage,
                };
            }
        }
        log.info(`PR #${ghPr.number} created: ${ghPr.html_url}`);
        emitRunEvent('pr:opened', { prNumber: ghPr.number, title: prTitle, branch: branchName, baseBranch });
        allTranscript.push(msg('conductor', `PR #${ghPr.number} created: ${prTitle}`));

        // Post simulated review-request comment
        try {
            const authorEntry = getDevAgent(assignments[0].devAgentId);
            const reviewerNames = reviewerAgentIds
                .map(id => getDevAgent(id))
                .filter(Boolean)
                .map(e => `${e!.name} (${e!.id})`);
            const requestBody = `[REVIEW_REQUEST] ${authorEntry?.name ?? assignments[0].devAgentId} requested review from ${reviewerNames.join(' and ')}.`;
            await octokit.issues.createComment({
                owner: ghOwner, repo: ghRepo,
                issue_number: ghPr.number, body: requestBody,
            });
        } catch (reqErr: any) {
            log.warn(`Failed to post review-request comment: ${reqErr.message}`);
        }

        // ── 3. Review loop ──────────────────────────────────────────────
        const allReviews: PRReview[] = [];
        const allOutcomes: ReviewOutcome[] = [];
        const seenCommentKeys = new Set<string>();
        let prStatus: 'open' | 'approved' | 'merged' | 'closed' | 'escalated_open' | 'blocked' = 'open';

        /** SHA of the last commit that reviewers actually reviewed. */
        let lastReviewedSha = '';
        /** Consecutive iterations where the fix attempt produced no new commit. */
        let noProgressCount = 0;
        /** Rate-limit retries of the fix step (bounded; replaces the old `iteration--`). */
        let fixRateLimitRetries = 0;
        const MAX_FIX_RATE_LIMIT_RETRIES = 2;

        /** Max chars for inline diff before switching to stat-based fallback. */
        const MAX_DIFF_CHARS = 25_000;

        /** Generated-file exclusion pathspecs for git diff (mirrors git-tools.ts). */
        const DIFF_EXCLUDE_SPECS = [
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
            'composer.lock', 'Gemfile.lock', 'Pipfile.lock', 'poetry.lock',
            'go.sum', 'Cargo.lock',
            '*.min.js', '*.min.css', '*.map', '*.snap',
            'dist/*', 'build/*', '.next/*',
        ].map(p => `':!${p}'`).join(' ');

        for (let iteration = 1; iteration <= getEffectiveLimits().maxReviewIterations; iteration++) {
            // Plan 24 D2: check branch budget before each review iteration
            const reviewBudgetReason = checkBranchBudget(`before review iteration ${iteration}`);
            if (reviewBudgetReason) {
                log.warn(`Branch ${branchName} budget exceeded: ${reviewBudgetReason} — ending review loop`);
                allTranscript.push(msg('conductor', `Branch budget exceeded during review: ${reviewBudgetReason}`));
                emitRunEvent('branch:budget-exceeded', { branchName, reason: reviewBudgetReason, checkpoint: `review iteration ${iteration}` });
                break;
            }

            const effectiveReviewLimit = getEffectiveLimits().maxReviewIterations;
            log.info(`Review iteration ${iteration}/${effectiveReviewLimit}`);

            // ── No-progress detection (Change 1) ────────────────────────
            // NOTE: the decision must be taken BEFORE `lastReviewedSha` is
            // updated, otherwise every iteration > 1 looks like no-progress and
            // reviewers are never re-invoked. `evaluateProgress` owns that order.
            const headSha = gitExec(worktreeWorkspace, 'rev-parse HEAD');
            const progress = evaluateProgress(iteration, headSha, lastReviewedSha, noProgressCount);
            lastReviewedSha = progress.lastReviewedSha;
            noProgressCount = progress.noProgressCount;
            const skipReviewPhase = progress.skipReview;
            if (skipReviewPhase) {
                log.warn(`No new commits since the last review (HEAD ${headSha.slice(0, 8)}) — skipping re-review (no-progress ${noProgressCount}/${MAX_NO_PROGRESS_ITERATIONS})`);
                if (progress.endLoop) {
                    log.warn(`${MAX_NO_PROGRESS_ITERATIONS} consecutive iterations with no progress — ending review loop.`);
                    break;
                }
                // Skip the review but still attempt a fix below
            }

            // Get the diff for reviewers (excluding generated files)
            const prDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);

            // ── Skip reviewers on empty diff (Change 4) ─────────────────
            // Sub-Plan 07: empty diff → changes_requested (not approved).
            // An empty PR delivered nothing; it must not be merged.
            if (!prDiff || prDiff.trim() === '' || prDiff.startsWith('Error:')) {
                log.warn('Empty or unavailable diff — no production code produced.');
                allOutcomes.push({
                    kind: 'changes_requested',
                    reviewerId: 'automated-verification',
                    output: {
                        status: 'changes_requested',
                        summary: 'No changes were produced for this assignment',
                        comments: [{ filePath: '.', body: 'No changes were produced for this assignment', severity: 'critical' }],
                        criteriaVerdicts: [],
                    },
                });
                break;
            }

            // ── Review phase (skipped when no progress) ──────────────────
            const reviewResults: { reviewerId: string; output: ReviewOutput }[] = [];

            if (!skipReviewPhase) {
                // Truncate reviewer list to the budget-effective limit
                const { maxReviewers } = getEffectiveLimits();
                const activeReviewerIds = reviewerAgentIds.slice(0, Math.max(maxReviewers, 0));
                // Determine which reviewers need to (re-)review
                const pendingReviewers = iteration === 1
                    ? activeReviewerIds
                    : activeReviewerIds.filter(rid => {
                        const lastReview = allReviews
                            .filter(r => r.reviewerId === rid)
                            .sort((a, b) => b.iteration - a.iteration)[0];
                        return !lastReview || lastReview.status === 'changes_requested';
                    });

                if (pendingReviewers.length === 0) {
                    log.info('All reviewers have approved');
                    prStatus = 'approved';
                    break;
                }

                // ── Sequential per-reviewer passes: review → fix → next reviewer ──
                // Each reviewer sees the code after the previous reviewer's
                // comments have been addressed, avoiding duplicate observations
                // and saving tokens.
                for (const reviewerId of pendingReviewers) {
                    const reviewerEntry = getDevAgent(reviewerId);
                    if (!reviewerEntry) {
                        log.warn(`Unknown reviewer: ${reviewerId}, skipping`);
                        continue;
                    }

                    const reviewerLog = getLogger(`${reviewerEntry.tag} [REVIEW]`, reviewerEntry.colorCode);
                    reviewerLog.info(`Reviewing PR #${ghPr.number} (iteration ${iteration})`);

                    const reviewerConventions = resolveConventionFiles(reviewerEntry.languages, techStack);
                    const reviewerAgent = buildReviewerAgent(apiKey, reviewerEntry, worktreeWorkspace, gitContext, baseBranch, reviewerConventions);

                    // Refresh diff for each reviewer so they see code after prior fixes
                    const freshDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);

                    // B6: Context-aware diff truncation with stat fallback
                    let truncatedDiff: string;
                    if (freshDiff.length <= MAX_DIFF_CHARS) {
                        truncatedDiff = freshDiff;
                    } else {
                        // Diff too large — provide stat summary and instruct to use per-file tools
                        const diffStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                        truncatedDiff = [
                            `[DIFF TOO LARGE — ${freshDiff.length} chars. Showing file summary instead]\n`,
                            diffStat,
                            `\nUse the "git_diff_file" tool with a specific file path to review individual files.`,
                            `Use the "git_diff_stat" tool to see the full list of changed files.`,
                        ].join('\n');
                    }

                    // B6: Summarize previous reviews instead of full JSON
                    const prevReviewSummary = iteration > 1
                        ? allReviews.filter(r => r.reviewerId === reviewerId)
                            .map(r => `Iteration ${r.iteration}: ${r.status} (${r.comments.length} comments)`)
                            .join('\n')
                        : '';

                    // B3: Collect prior reviewer comments from this iteration to avoid duplicates
                    const priorIterComments = reviewResults
                        .flatMap(r => (r.output.comments ?? []).map((c: any) => ({
                            reviewer: r.reviewerId,
                            file: c.filePath,
                            line: c.line,
                            body: c.body,
                            severity: c.severity,
                        })));
                    const priorCommentsSection = priorIterComments.length > 0
                        ? `\n## Other Reviewer Comments This Iteration\nThe following comments have already been posted by other reviewers in this iteration. Do NOT repeat these. Only add NEW, UNIQUE observations.\n\n${JSON.stringify(priorIterComments, null, 2)}`
                        : '';

                    const reviewMsg = [
                        `## Pull Request #${ghPr.number}: ${prTitle}`,
                        `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                        `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                        `\n## Diff\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
                        `\n## Review Iteration: ${iteration}`,
                        prevReviewSummary ? `\n## Previous Review Summary\n\n${prevReviewSummary}` : '',
                        priorCommentsSection,
                    ].join('\n');

                    try {
                        const reviewerModel = getModelForRank(reviewerEntry.rank as DevRank);
                        const { outcome: rawOutcome, tokenUsage: revTokenUsage } = await invokeReviewerAgent(
                            reviewerAgent, reviewMsg, `${reviewerId}-pr${ghPr.number}-iter${iteration}`,
                            `${reviewerId}-reviewer`, reviewerModel,
                        );
                        if (revTokenUsage) allTokenUsage.push(revTokenUsage);

                        // Sub-Plan 07 §5.3: enforce criteriaVerdicts consistency
                        const assignmentHasCriteria = assignments.some(a =>
                            (a.acIndexes ?? []).length > 0 || (a.additionalStoryIds ?? []).length > 0,
                        );
                        const outcome = enforceCriteriaVerdicts(rawOutcome, assignmentHasCriteria);
                        allOutcomes.push(outcome);

                        // Extract reviewOutput for downstream use (fix, record, comment)
                        const reviewOutput: ReviewOutput = outcome.kind === 'abstained'
                            ? { status: 'changes_requested', summary: `Abstained: ${outcome.detail}`, comments: [], criteriaVerdicts: [] }
                            : outcome.output;

                        // ── Only blocking severities block (Change 3) ───────
                        // Sub-Plan 07: non-blocking comments are still recorded, but do not
                        // downgrade the outcome kind — the outcome is already set above.
                        if (outcome.kind === 'changes_requested' && !isBlockingReview(reviewOutput.comments ?? [])) {
                            reviewerLog.info('Only non-blocking comments (minor/suggestion) — recording as approved-with-comments.');
                            // Upgrade to approved — review had substance but nothing blocking
                            allOutcomes[allOutcomes.length - 1] = { kind: 'approved', reviewerId, output: { ...reviewOutput, status: 'approved' } };
                        }

                        reviewResults.push({ reviewerId, output: reviewOutput });
                        const effectiveStatus = allOutcomes[allOutcomes.length - 1].kind;
                        reviewerLog.info(`Decision: ${effectiveStatus} (${reviewOutput.comments?.length ?? 0} comments)`);
                        emitRunEvent('pr:reviewed', { prNumber: ghPr.number, reviewerId, status: effectiveStatus, comments: reviewOutput.comments?.length ?? 0 });

                        // B2: Log individual review comments to the run log
                        for (const c of reviewOutput.comments ?? []) {
                            reviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                        }

                        // Post simulated review as an issue comment (avoids "Can not request changes on your own pull request")
                        const ghComments = (reviewOutput.comments ?? [])
                            .filter((c: any) => c.filePath && c.body)
                            .map((c: any) => ({
                                path: c.filePath,
                                line: c.line ?? 1,
                                body: `**[${c.severity?.toUpperCase() ?? 'INFO'}]** ${c.body}`,
                            }));

                        const statusTag = reviewOutput.status === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
                        const commentParts = [
                            `[REVIEW: ${statusTag} by ${reviewerEntry.name} (${reviewerEntry.id})] — iteration ${iteration}`,
                            '',
                            `**Summary:** ${reviewOutput.summary}`,
                        ];
                        if (ghComments.length > 0) {
                            commentParts.push('', '### Comments', '');
                            for (const c of ghComments) {
                                commentParts.push(`- **\`${c.path}\`${c.line ? `:${c.line}` : ''}** — ${c.body}`);
                            }
                        }

                        try {
                            await octokit.issues.createComment({
                                owner: ghOwner, repo: ghRepo,
                                issue_number: ghPr.number, body: commentParts.join('\n'),
                            });
                        } catch (commentErr: any) {
                            log.warn(`Failed to post review comment to GitHub: ${commentErr.message}`);
                        }

                        // Record review
                        allReviews.push({
                            reviewerId,
                            status: reviewOutput.status === 'approved' ? 'approved' : 'changes_requested',
                            comments: (reviewOutput.comments ?? []).map((c: any, idx: number) => ({
                                id: `${reviewerId}-iter${iteration}-${idx}`,
                                reviewerId,
                                filePath: c.filePath ?? '',
                                line: c.line,
                                body: c.body ?? '',
                                severity: c.severity ?? 'info',
                                resolved: false,
                            })),
                            iteration,
                        });

                        allTranscript.push(msg(reviewerId, `Review: ${reviewOutput.status} — ${reviewOutput.summary?.slice(0, 100)}`));

                        // ── Sequential fix: address this reviewer's comments
                        //    before the next reviewer sees the code ────────────
                        const lastOutcome = allOutcomes[allOutcomes.length - 1];
                        if (lastOutcome.kind === 'changes_requested' && iteration < effectiveReviewLimit) {
                            const thisReviewerComments = (reviewOutput.comments ?? [])
                                .map((c: any) => ({
                                    reviewer: reviewerId,
                                    file: c.filePath,
                                    line: c.line,
                                    comment: c.body,
                                    severity: c.severity,
                                }))
                                .filter((c: any) => {
                                    const key = `${(c.file ?? '').toLowerCase()}::${(c.comment ?? '').slice(0, 100).toLowerCase()}`;
                                    if (seenCommentKeys.has(key)) return false;
                                    seenCommentKeys.add(key);
                                    return true;
                                });

                            if (thisReviewerComments.length > 0) {
                                const primaryDevId = assignments[0].devAgentId;
                                const primaryEntry = getDevAgent(primaryDevId);
                                if (primaryEntry) {
                                    const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
                                    devLog.info(`Fixing ${thisReviewerComments.length} review comments from ${reviewerId}...`);

                                    const fixConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                                    const buildFixAgentFn = () => buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, fixConventions, isMaintainMode);
                                    const fixAgent = buildFixAgentFn();
                                    const fixMsg = [
                                        contextPrompt,
                                        `\n## Project Slug: ${projectSlug}`,
                                        `\n## Your Branch: ${branchName}`,
                                        `\nYou are already on this branch. Do NOT switch branches. Fix the review comments below.`,
                                        `\n## IMPORTANT: Workspace Context`,
                                        `Your current working directory IS the project root.`,
                                        `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                                        `\n## Review Comments to Fix\n\n${JSON.stringify(thisReviewerComments, null, 2)}`,
                                        `\n## Instructions`,
                                        `Address ALL review comments. For each comment:`,
                                        `1. Read the file and understand the issue.`,
                                        `2. Make the fix.`,
                                        `3. Commit with a message like "fix: address review comment — <description>".`,
                                        `4. Push when done.`,
                                        ``,
                                        `HARD CONSTRAINTS (enforced mechanically):`,
                                        `- Do NOT modify \`scripts\` in any package.json (writes are REFUSED by your tools).`,
                                        `- Do NOT delete, skip, or weaken tests. Do NOT add trivial tests for non-product code.`,
                                        `- Do NOT relax tsconfig/eslint strictness or add source paths to .gitignore.`,
                                        `- Fix the SOURCE CODE, not the build/test configuration.`,
                                    ].join('\n');

                                    try {
                                        const fixModel = getModelForRank(primaryEntry.rank as DevRank);
                                        const { output: fixOutput, tokenUsage: fixTokenUsage } = await invokeDevAgent(
                                            fixAgent, fixMsg, `fix-${primaryEntry.id}-${reviewerId}-iter${iteration}`,
                                            primaryEntry.id, fixModel,
                                            buildFixAgentFn, respawnCtx,
                                        );
                                        if (fixTokenUsage) allTokenUsage.push(fixTokenUsage);
                                        const fixChanges = reconcileClaims(`${primaryDevId} (fix for ${reviewerId})`, fixOutput.fileChanges);
                                        allFileChanges.push(...fixChanges);
                                        devLog.info(`Fix complete: ${fixChanges.length} verified change(s) (from ${reviewerId})`);
                                        allTranscript.push(msg(primaryDevId, `Fixed ${fixChanges.length} files from ${reviewerId}'s review`));
                                    } catch (fixErr: any) {
                                        log.error(`Fix attempt for ${reviewerId}'s comments failed: ${fixErr.message}`);
                                        allTranscript.push(msg(primaryDevId, `Fix failed for ${reviewerId}: ${fixErr.message}`));
                                        // Rate-limit handling
                                        if (fixErr.message?.includes('429') || fixErr.message?.includes('rate limit') || fixErr.message?.includes('Rate limit') || fixErr.message?.includes('Request limit')) {
                                            if (fixRateLimitRetries < MAX_FIX_RATE_LIMIT_RETRIES) {
                                                fixRateLimitRetries++;
                                                log.warn(`Rate-limited fix (retry ${fixRateLimitRetries}/${MAX_FIX_RATE_LIMIT_RETRIES}) — waiting`);
                                                await new Promise(r => setTimeout(r, 30_000));
                                            }
                                        }
                                    } finally {
                                        // Sub-Plan 06 §2: commit per-reviewer fix work in finally
                                        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                                            `address ${reviewerId} review (iteration ${iteration})`, gitContext);
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        log.error(`Reviewer ${reviewerId} failed: ${err.message}`);
                        allTranscript.push(msg(reviewerId, `Review failed: ${err.message}`));
                    }
                }

                // Check if quorum met using ReviewOutcome (Sub-Plan 07)
                const iterationOutcomes = allOutcomes.filter(o => {
                    // Only count the latest outcome per reviewer this iteration
                    const rid = o.reviewerId;
                    return allOutcomes.filter(oo => oo.reviewerId === rid).pop() === o;
                });
                const quorumResult = evaluateQuorum(iterationOutcomes, REVIEW_QUORUM);
                if (quorumResult.met) {
                    log.info(`All reviewers approved (quorum ${quorumResult.approvals}/${REVIEW_QUORUM} met)!`);
                    prStatus = 'approved';
                    break;
                }

                // Sub-Plan 07 §2: All abstained → retry with fresh agents
                if (quorumResult.allAbstained) {
                    log.warn(`All ${quorumResult.abstentions} reviewer(s) abstained — will retry (REVIEW_ABSTAIN_RETRIES: ${REVIEW_ABSTAIN_RETRIES})`);
                }
            } // end if (!skipReviewPhase)

            // ── Fix requested changes (skipReviewPhase fallback) ─────────
            // When skipReviewPhase is true, re-use the comments from the most
            // recent iteration that actually produced reviews — the previous
            // iteration may itself have been a skipped one.
            // In normal flow, fixes already happen per-reviewer above; this block
            // only runs for no-progress retries.
            if (skipReviewPhase) {
                const lastReviewedIteration = allReviews.reduce((m, r) => Math.max(m, r.iteration), 0);
                const changesRequested = allReviews
                    .filter(r => r.iteration === lastReviewedIteration && r.status === 'changes_requested')
                    .map(r => ({ reviewerId: r.reviewerId, output: { status: 'changes_requested' as const, summary: '', comments: r.comments } }));
                if (changesRequested.length > 0 && iteration < effectiveReviewLimit) {
                    log.info(`${changesRequested.length} reviewer(s) requested changes (no-progress retry). Re-invoking dev agent(s)...`);

                    // On a no-progress retry the comments are deliberately the same
                    // ones the failed fix attempt was given, so dedup is skipped.
                    const requestedComments = changesRequested.flatMap(r =>
                        (r.output.comments ?? []).map((c: any) => ({
                            reviewer: r.reviewerId,
                            file: c.filePath,
                            line: c.line,
                            comment: c.body,
                            severity: c.severity,
                        }))
                    );

                    if (requestedComments.length > 0) {
                        const primaryDevId = assignments[0].devAgentId;
                        const primaryEntry = getDevAgent(primaryDevId);
                        if (primaryEntry) {
                            const devLog = getLogger(primaryEntry.tag, primaryEntry.colorCode);
                            devLog.info(`Fixing ${requestedComments.length} review comments (no-progress retry)...`);

                            const fixConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                            const buildNoProgressFixFn = () => buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, fixConventions, isMaintainMode);
                            const fixAgent = buildNoProgressFixFn();
                            const fixMsg = [
                                contextPrompt,
                                `\n## Project Slug: ${projectSlug}`,
                                `\n## Your Branch: ${branchName}`,
                                `\nYou are already on this branch. Do NOT switch branches. Fix the review comments below.`,
                                `\n## IMPORTANT: Workspace Context`,
                                `Your current working directory IS the project root.`,
                                `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                                `\n## Review Comments to Fix\n\n${JSON.stringify(requestedComments, null, 2)}`,
                                `\n## Instructions`,
                                `Address ALL review comments. For each comment:`,
                                `1. Read the file and understand the issue.`,
                                `2. Make the fix.`,
                                `3. Commit with a message like "fix: address review comment — <description>".`,
                                `4. Push when done.`,
                                ``,
                                `HARD CONSTRAINTS (enforced mechanically):`,
                                `- Do NOT modify \`scripts\` in any package.json (writes are REFUSED by your tools).`,
                                `- Do NOT delete, skip, or weaken tests. Do NOT add trivial tests for non-product code.`,
                                `- Do NOT relax tsconfig/eslint strictness or add source paths to .gitignore.`,
                                `- Fix the SOURCE CODE, not the build/test configuration.`,
                            ].join('\n');

                            try {
                                const fixModel = getModelForRank(primaryEntry.rank as DevRank);
                                const { output: fixOutput, tokenUsage: fixTokenUsage } = await invokeDevAgent(fixAgent, fixMsg, `fix-${primaryEntry.id}-iter${iteration}`, primaryEntry.id, fixModel, buildNoProgressFixFn, respawnCtx);
                                if (fixTokenUsage) allTokenUsage.push(fixTokenUsage);
                                const fixChanges = reconcileClaims(`${primaryDevId} (no-progress fix)`, fixOutput.fileChanges);
                                allFileChanges.push(...fixChanges);
                                devLog.info(`Fix complete: ${fixChanges.length} verified change(s)`);
                                allTranscript.push(msg(primaryDevId, `Fixed ${fixChanges.length} files based on review comments`));
                            } catch (err: any) {
                                log.error(`Fix attempt failed: ${err.message}`);
                                if (err.message?.includes('429') || err.message?.includes('rate limit') || err.message?.includes('Rate limit') || err.message?.includes('Request limit')) {
                                    if (fixRateLimitRetries < MAX_FIX_RATE_LIMIT_RETRIES) {
                                        fixRateLimitRetries++;
                                        log.warn(`Rate-limited fix (retry ${fixRateLimitRetries}/${MAX_FIX_RATE_LIMIT_RETRIES}) — waiting before the next iteration`);
                                        await new Promise(r => setTimeout(r, 30_000));
                                    } else {
                                        log.warn('Fix step exhausted its rate-limit retries — ending review loop.');
                                        break;
                                    }
                                }
                                if (err.message?.includes('recursion limit') || err.message?.includes('Recursion limit')) {
                                    log.warn(`Recursion limit hit in fix attempt — will retry with fresh agent next iteration`);
                                    allTranscript.push(msg(primaryDevId, `Fix hit recursion limit (iteration ${iteration}), will retry`));
                                }
                                if (err.message?.includes('Already borrowed')) {
                                    log.warn(`Non-retriable error in fix attempt — skipping remaining fix iterations`);
                                    allTranscript.push(msg(primaryDevId, `Fix skipped (non-retriable): ${err.message}`));
                                    break;
                                }
                                allTranscript.push(msg(primaryDevId, `Fix failed: ${err.message}`));
                            } finally {
                                // Sub-Plan 06 §2: commit no-progress fix work in finally
                                commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                                    `address review comments (no-progress retry, iteration ${iteration})`, gitContext);
                            }
                        }
                    }
                }
            }
        }

        // ── 3b. Escalation check ────────────────────────────────────────
        // Guarded by PR_EXHAUSTION_STRATEGY: 'escalate-then-fix' or 'escalate-only' run escalation.
        // 'fix-only' skips escalation entirely (proceeds straight to strong fixer in 3c).
        if (prStatus === 'open' && PR_EXHAUSTION_STRATEGY !== 'fix-only') {
            // Use the last iteration that actually produced reviews — the loop can
            // now end early (no-progress / rate-limit exhaustion), in which case
            // there are no reviews at the effective limit to escalate on.
            const finalIteration = allReviews.reduce((m, r) => Math.max(m, r.iteration), 0);
            const lastReviews = allReviews.filter(r => r.iteration === finalIteration);
            const hasCritical = lastReviews.some(r =>
                r.comments.some((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
            );

            if (hasCritical) {
                const reviewLimit = getEffectiveLimits().maxReviewIterations;
                log.warn(`PR #${ghPr.number} has unresolved CRITICALs after ${reviewLimit} iterations. Escalating developer...`);
                allTranscript.push(msg('conductor', `Escalating: unresolved CRITICALs after max iterations`));

                // Sub-Plan 07 §4: selectEscalationCandidate always finds a candidate
                const originalDevId = assignments[0].devAgentId;
                const escalatedDevId = selectEscalationCandidate(
                    originalDevId,
                    [...reviewerAgentIds, originalDevId],
                );

                if (escalatedDevId) {
                    const escalatedDevEntry = getDevAgent(escalatedDevId)!;
                    log.info(`Escalated dev: ${escalatedDevEntry.name} (${escalatedDevId})`);

                    // Escalated dev fixes CRITICALs + reviews overall quality
                    const escalatedConventions = resolveConventionFiles(escalatedDevEntry.languages, techStack);
                    const buildEscalatedFn = () => buildDevAgent(apiKey, escalatedDevEntry, worktreeWorkspace, gitContext, baseBranch, escalatedConventions, isMaintainMode);
                    const escalatedDev = buildEscalatedFn();
                    const criticalComments = lastReviews.flatMap(r =>
                        r.comments.filter((c: any) => c.severity === 'critical' || c.body?.includes('[CRITICAL]'))
                    );
                    const escalationMsg = [
                        contextPrompt,
                        `\n## Project Slug: ${projectSlug}`,
                        `\n## Your Branch: ${branchName}`,
                        `\n## IMPORTANT: Workspace Context`,
                        `Your current working directory IS the project root.`,
                        `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                        `\n## Escalation: You are a SENIOR developer taking over from a lower-rank developer.`,
                        `\n## Unresolved CRITICAL Comments\n\n${JSON.stringify(criticalComments, null, 2)}`,
                        `\n## Instructions`,
                        `1. Fix ALL CRITICAL review comments listed above.`,
                        `2. Review the ENTIRE codebase on this branch for quality issues.`,
                        `3. Fix any additional issues you find.`,
                        `4. Commit all changes when done.`,
                        ``,
                        `HARD CONSTRAINTS (enforced mechanically):`,
                        `- Do NOT modify \`scripts\` in any package.json (writes are REFUSED by your tools).`,
                        `- Do NOT delete, skip, or weaken tests. Do NOT add trivial tests for non-product code.`,
                        `- Do NOT relax tsconfig/eslint strictness or add source paths to .gitignore.`,
                        `- Fix the SOURCE CODE, not the build/test configuration.`,
                    ].join('\n');

                    try {
                        const escModel = getModelForRank(escalatedDevEntry.rank as DevRank);
                        const { output: fixOutput, tokenUsage: escTokenUsage } = await invokeDevAgent(escalatedDev, escalationMsg, `escalation-${escalatedDevId}`, escalatedDevId, escModel, buildEscalatedFn, respawnCtx);
                        if (escTokenUsage) allTokenUsage.push(escTokenUsage);
                        const escChanges = reconcileClaims(`${escalatedDevId} (escalation)`, fixOutput.fileChanges);
                        allFileChanges.push(...escChanges);
                        log.info(`Escalated dev ${escalatedDevId} completed fixes: ${escChanges.length} verified change(s)`);
                        allTranscript.push(msg(escalatedDevId, `Escalated dev fixes applied`));

                        // Find escalated reviewer (higher rank, not the originals)
                        const escalatedReviewerId = selectEscalationCandidate(
                            escalatedDevId,
                            [...reviewerAgentIds, escalatedDevId, originalDevId],
                        );

                        if (escalatedReviewerId) {
                            const escalatedReviewerEntry = getDevAgent(escalatedReviewerId)!;
                            const escalatedReviewerLog = getLogger(`${escalatedReviewerEntry.tag} [ESCALATED REVIEW]`, escalatedReviewerEntry.colorCode);
                            escalatedReviewerLog.info(`Escalated review of PR #${ghPr.number}`);

                            const escalatedReviewerConventions = resolveConventionFiles(escalatedReviewerEntry.languages, techStack);
                            const escalatedReviewer = buildReviewerAgent(apiKey, escalatedReviewerEntry, worktreeWorkspace, gitContext, baseBranch, escalatedReviewerConventions);
                            const escalatedDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                            let escalatedDiffContent: string;
                            if (escalatedDiff.length <= MAX_DIFF_CHARS) {
                                escalatedDiffContent = `\`\`\`diff\n${escalatedDiff}\n\`\`\``;
                            } else {
                                const escalatedStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                                escalatedDiffContent = [
                                    `[DIFF TOO LARGE — ${escalatedDiff.length} chars. Showing file summary instead]\n`,
                                    escalatedStat,
                                    `\nUse "git_diff_file" to review individual files.`,
                                ].join('\n');
                            }
                            const escalatedReviewMsg = [
                                `## Escalated Review — Pull Request #${ghPr.number}: ${prTitle}`,
                                `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                                `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                                `\n## Diff\n\n${escalatedDiffContent}`,
                                `\n## Context: This is an escalated review after ${reviewLimit} iterations. A higher-rank dev has already applied fixes.`,
                            ].join('\n');

                            try {
                                const escRevModel = getModelForRank(escalatedReviewerEntry.rank as DevRank);
                                const { outcome: escalatedOutcome, tokenUsage: escRevTokenUsage } = await invokeReviewerAgent(
                                    escalatedReviewer, escalatedReviewMsg, `escalated-${escalatedReviewerId}-pr${ghPr.number}`,
                                    `${escalatedReviewerId}-reviewer`, escRevModel,
                                );
                                if (escRevTokenUsage) allTokenUsage.push(escRevTokenUsage);
                                allOutcomes.push(escalatedOutcome);

                                // Sub-Plan 07: abstained escalated reviewer is NOT approved
                                const escalatedReviewOutput: ReviewOutput = escalatedOutcome.kind === 'abstained'
                                    ? { status: 'changes_requested', summary: `Escalated reviewer abstained: ${escalatedOutcome.detail}`, comments: [], criteriaVerdicts: [] }
                                    : escalatedOutcome.output;

                                escalatedReviewerLog.info(`Escalated decision: ${escalatedOutcome.kind} (${escalatedReviewOutput.comments?.length ?? 0} comments)`);
                                for (const c of escalatedReviewOutput.comments ?? []) {
                                    escalatedReviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                                }

                                allReviews.push({
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
                                    log.info(`Escalated reviewer approved PR #${ghPr.number}`);
                                    prStatus = 'approved';
                                } else {
                                    log.warn(`Escalated reviewer also requested changes for PR #${ghPr.number} — leaving open`);
                                    prStatus = 'open';
                                    allTranscript.push(msg('conductor', `Escalated reviewer rejected — PR left open`));
                                }
                            } catch (escRevErr: any) {
                                log.error(`Escalated review failed: ${escRevErr.message}`);
                            }
                        } else {
                            log.warn('No escalated reviewer available — leaving PR open for human intervention');
                        }
                    } catch (escErr: any) {
                        log.error(`Escalated dev failed: ${escErr.message}`);
                        allTranscript.push(msg('conductor', `Escalation failed: ${escErr.message}`));
                    } finally {
                        // Sub-Plan 06 §2: commit escalation dev work in finally
                        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                            `escalated dev fixes from ${escalatedDevId}`, gitContext);
                    }
                } else {
                    // Sub-Plan 07 §4: selectEscalationCandidate should never return null,
                    // but if it does (e.g. registry is empty), leave PR open.
                    log.warn('No escalation candidate found — leaving PR open');
                    allTranscript.push(msg('conductor', `No escalation candidate found — PR left open`));
                }
            }
        }

        // ── 3c. Strong Model Fixer (Sub-Plan 20) ────────────────────────
        // When the PR is still open after regular escalation (or instead of it
        // for 'fix-only' strategy) and STRONG_FIXER_ENABLED, invoke a powerful
        // model to do a comprehensive fix pass with full context.
        if (STRONG_FIXER_ENABLED && PR_EXHAUSTION_STRATEGY !== 'escalate-only'
            && prStatus === 'open') {
            // Budget check — do not run if budget is exhausted
            const { maxReviewIterations: budgetCheck } = getEffectiveLimits();
            if (budgetCheck <= 0) {
                log.warn('Strong fixer skipped: run budget exhausted');
            } else if (strongFixerZeroWriteBranches.has(branchName)) {
                // Plan 24 B2: one shot per branch — a previous zero-write pass means rerunning is waste
                log.info(`Strong fixer: skipped (zero-write pass already attempted on ${branchName})`);
            } else {
                // Plan 24 B2: precondition — only run when at least one blocker is an
                // unresolved review comment or a repairable gate failure (typecheck/lint/test).
                // Skip when blockers are exclusively non-fixer-repairable
                // ('Product verification failed', 'critical layout violation', 'Quorum not met'
                //  with zero review comments).
                const hasReviewComments = allReviews.some(r => r.comments.length > 0);
                const hasRepairableGateFailure = gateReport && !gateReport.passed && gateReport.results?.some(
                    (r: any) => !r.passed && !r.skipped && /typecheck|lint|test|build/i.test(r.step),
                );
                const productVerifyFailed = gateReport?.productVerify && !gateReport.productVerify.passed;
                const criticalLayoutOnly = integrityFindings.length > 0
                    && integrityFindings.every(f => f.severity === 'critical');
                const quorumNotMet = allOutcomes.filter(o => o.kind === 'approved').length < REVIEW_QUORUM
                    && !hasReviewComments;
                const onlyNonRepairable = !hasReviewComments && !hasRepairableGateFailure
                    && (productVerifyFailed || criticalLayoutOnly || quorumNotMet);

                const fixerBlockerSummary = [
                    ...(hasReviewComments ? ['review-comments'] : []),
                    ...(hasRepairableGateFailure ? ['repairable-gate-failure'] : []),
                    ...(productVerifyFailed ? ['product-verify-failed'] : []),
                    ...(quorumNotMet ? ['quorum-not-met'] : []),
                ].join(', ') || 'none';

                if (onlyNonRepairable) {
                    log.info(`Strong fixer: skipped (blockers not fixer-repairable: ${fixerBlockerSummary})`);
                } else {
                const fixerModel = STRONG_FIXER_MODEL || PRINCIPAL_DEV_MODEL;
                log.info(`Strong fixer: running (${STRONG_FIXER_MAX_TOOL_CALLS} turns, ${Math.round(STRONG_FIXER_MAX_INPUT_TOKENS / 1000)}k tokens, blockers: ${fixerBlockerSummary || 'review-comments-only'})`);
                allTranscript.push(msg('conductor', `Strong fixer invoked (model: ${fixerModel})`));
                emitRunEvent('pr:strong-fixer', { prNumber: ghPr.number, model: fixerModel, branch: branchName });

                // Collect ALL review comments from all iterations
                const allComments = allReviews.flatMap(r => r.comments);

                // Get the current full diff
                const fullDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...HEAD -- . ${DIFF_EXCLUDE_SPECS}`);
                // Truncate diff if too large
                const maxDiffChars = 30_000;
                const truncatedFixerDiff = fullDiff.length <= maxDiffChars
                    ? fullDiff
                    : fullDiff.slice(0, maxDiffChars) + `\n\n[... TRUNCATED — ${fullDiff.length - maxDiffChars} chars omitted ...]`;

                // Build the strong fixer agent
                const fixerConventions = resolveConventionFiles(['typescript', 'javascript'], techStack);
                const buildFixerFn = () => buildStrongFixerAgent(apiKey, worktreeWorkspace, gitContext, baseBranch, fixerConventions, isMaintainMode);
                const fixerAgent = buildFixerFn();

                const fixerMsg = [
                    `## STRONG FIXER — PR #${ghPr.number}: ${prTitle}`,
                    `\nYou are a SENIOR EXPERT developer taking over a PR that has exhausted its review iterations.`,
                    `Your job: read the task, understand the review feedback, and fix ALL issues to get this PR merged.`,
                    `\n## Original Task\n${contextPrompt}`,
                    `\n## Project Slug: ${projectSlug}`,
                    `\n## Your Branch: ${branchName}`,
                    `\nYou are already on this branch. Do NOT create or switch branches.`,
                    `\n## IMPORTANT: Workspace Context`,
                    `Your current working directory IS the project root.`,
                    `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
                    `\n## PR Description\n${prBody.slice(0, 3000)}`,
                    `\n## All Review Comments (${allComments.length} total)\n${JSON.stringify(allComments, null, 2)}`,
                    `\n## Current Diff\n\`\`\`diff\n${truncatedFixerDiff}\n\`\`\``,
                    gateReport ? `\n## Quality Gate Results\n${gateReportToMarkdown(gateReport)}` : '',
                    // Plan 24 B4: present major integrity findings as informational, not blockers
                    integrityFindings.filter(f => f.severity === 'critical').length > 0
                        ? `\n## Integrity Findings\n${tamperFindingsToMarkdown(integrityFindings.filter(f => f.severity === 'critical'))}`
                        : '',
                    integrityFindings.filter(f => f.severity === 'major').length > 0
                        ? `\n## Heuristic findings (informational)\n${tamperFindingsToMarkdown(integrityFindings.filter(f => f.severity === 'major'))}`
                        : '',
                    `\n## Instructions`,
                    `1. Read and understand ALL review comments.`,
                    `2. Fix every issue raised by reviewers.`,
                    `3. Ensure quality gates will pass (build, lint, test).`,
                    `4. Do NOT weaken tests or build configuration.`,
                    `5. Commit all changes when done.`,
                    ``,
                    `HARD CONSTRAINTS (enforced mechanically):`,
                    `- Do NOT modify \`scripts\` in any package.json (writes are REFUSED by your tools).`,
                    `- Do NOT delete, skip, or weaken tests. Do NOT add trivial tests for non-product code.`,
                    `- Do NOT relax tsconfig/eslint strictness or add source paths to .gitignore.`,
                    `- Fix the SOURCE CODE, not the build/test configuration.`,
                ].join('\n');

                try {
                    const { output: fixerOutput, tokenUsage: fixerTokenUsage } = await invokeDevAgent(
                        fixerAgent, fixerMsg, `strong-fixer-pr${ghPr.number}`,
                        'strong-fixer', fixerModel,
                        buildFixerFn, respawnCtx,
                    );
                    if (fixerTokenUsage) allTokenUsage.push(fixerTokenUsage);
                    const fixerChanges = reconcileClaims('strong-fixer', fixerOutput.fileChanges);
                    allFileChanges.push(...fixerChanges);
                    log.info(`Strong fixer completed: ${fixerChanges.length} verified file change(s)`);
                    allTranscript.push(msg('strong-fixer', `Strong fixer applied ${fixerChanges.length} file changes`));

                    // Plan 24 B2: track zero-write passes so we don't retry
                    if (fixerChanges.length === 0) {
                        strongFixerZeroWriteBranches.add(branchName);
                        log.info(`Strong fixer: zero writes on ${branchName} — branch marked for skip on retry`);
                    }

                    // Run quality gates after the fixer's changes
                    let fixerGateReport: GateReport | null = null;
                    try {
                        fixerGateReport = runQualityGates(worktreeWorkspace, {
                            timeoutMs: PR_TEST_TIMEOUT_MS,
                            installTimeoutMs: PR_TEST_INSTALL_TIMEOUT_MS,
                        });
                        log.info(`Quality gates after strong fixer: ${fixerGateReport?.passed ? 'passed' : 'failed'}`);
                    } catch (gateErr: any) {
                        log.warn(`Quality gates after strong fixer failed: ${gateErr.message}`);
                    }

                    // Final review with a principal-rank reviewer
                    // Plan 24 B1: pass the original author's devAgentId, not 'strong-fixer'
                    // ('strong-fixer' is not in DEV_AGENTS so selectEscalationCandidate returned null)
                    const finalReviewerId = selectEscalationCandidate(
                        assignments[0].devAgentId,
                        [...reviewerAgentIds, assignments[0].devAgentId],
                    );

                    if (finalReviewerId) {
                        const finalReviewerEntry = getDevAgent(finalReviewerId)!;
                        const finalReviewerLog = getLogger(`${finalReviewerEntry.tag} [STRONG-FIXER REVIEW]`, finalReviewerEntry.colorCode);
                        finalReviewerLog.info(`Final review of PR #${ghPr.number} after strong fixer`);

                        const finalReviewerConventions = resolveConventionFiles(finalReviewerEntry.languages, techStack);
                        const finalReviewer = buildReviewerAgent(apiKey, finalReviewerEntry, worktreeWorkspace, gitContext, baseBranch, finalReviewerConventions);
                        const fixerDiff = gitExec(worktreeWorkspace, `diff ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                        let fixerDiffContent: string;
                        if (fixerDiff.length <= MAX_DIFF_CHARS) {
                            fixerDiffContent = `\`\`\`diff\n${fixerDiff}\n\`\`\``;
                        } else {
                            const fixerDiffStat = gitExec(worktreeWorkspace, `diff --stat ${baseRef}...${branchName} -- . ${DIFF_EXCLUDE_SPECS}`);
                            fixerDiffContent = [
                                `[DIFF TOO LARGE — ${fixerDiff.length} chars. Showing file summary instead]\n`,
                                fixerDiffStat,
                                `\nUse "git_diff_file" to review individual files.`,
                            ].join('\n');
                        }
                        const finalReviewMsg = [
                            `## Final Review — Pull Request #${ghPr.number}: ${prTitle}`,
                            `\n## Base Branch: ${baseBranch} (already applied to all diff tools — never pass a baseBranch argument yourself)`,
                            `\n## PR Description\n\n${prBody.slice(0, 2000)}`,
                            `\n## Diff\n\n${fixerDiffContent}`,
                            `\n## Context: This is a final review after a strong model fixer has addressed all review comments.`,
                            fixerGateReport ? `\n## Quality Gate Results\n${gateReportToMarkdown(fixerGateReport)}` : '',
                        ].join('\n');

                        try {
                            const finalRevModel = getModelForRank(finalReviewerEntry.rank as DevRank);
                            const { outcome: finalOutcome, tokenUsage: finalRevTokenUsage } = await invokeReviewerAgent(
                                finalReviewer, finalReviewMsg, `strong-fixer-review-${finalReviewerId}-pr${ghPr.number}`,
                                `${finalReviewerId}-reviewer`, finalRevModel,
                            );
                            if (finalRevTokenUsage) allTokenUsage.push(finalRevTokenUsage);
                            allOutcomes.push(finalOutcome);

                            const finalReviewOutput: ReviewOutput = finalOutcome.kind === 'abstained'
                                ? { status: 'changes_requested', summary: `Final reviewer abstained: ${finalOutcome.detail}`, comments: [], criteriaVerdicts: [] }
                                : finalOutcome.output;

                            finalReviewerLog.info(`Final review decision: ${finalOutcome.kind} (${finalReviewOutput.comments?.length ?? 0} comments)`);
                            for (const c of finalReviewOutput.comments ?? []) {
                                finalReviewerLog.info(`  ${c.filePath}${c.line ? ':' + c.line : ''} — [${(c.severity ?? 'info').toUpperCase()}] ${c.body}`);
                            }

                            const reviewIterForFixer = (allReviews.reduce((m, r) => Math.max(m, r.iteration), 0)) + 1;
                            allReviews.push({
                                reviewerId: finalReviewerId,
                                status: finalOutcome.kind === 'approved' ? 'approved' : 'changes_requested',
                                comments: (finalReviewOutput.comments ?? []).map((c: any, idx: number) => ({
                                    id: `${finalReviewerId}-strong-fixer-${idx}`,
                                    reviewerId: finalReviewerId,
                                    filePath: c.filePath ?? '',
                                    line: c.line,
                                    body: c.body ?? '',
                                    severity: c.severity ?? 'info',
                                    resolved: false,
                                })),
                                iteration: reviewIterForFixer,
                            });

                            // Post the final review comment on the PR
                            try {
                                const statusTag = finalReviewOutput.status === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
                                const commentBody = [
                                    `[REVIEW: ${statusTag} by ${finalReviewerEntry.name} (${finalReviewerEntry.id})] — strong-fixer final review`,
                                    '',
                                    `**Summary:** ${finalReviewOutput.summary}`,
                                    ...(finalReviewOutput.comments ?? []).map((c: any) =>
                                        `- **\`${c.filePath}\`${c.line ? `:${c.line}` : ''}** — **[${(c.severity ?? 'INFO').toUpperCase()}]** ${c.body}`
                                    ),
                                ].join('\n');
                                await octokit.issues.createComment({
                                    owner: ghOwner, repo: ghRepo,
                                    issue_number: ghPr.number, body: commentBody,
                                });
                            } catch (commentErr: any) {
                                log.warn(`Failed to post strong-fixer review comment: ${commentErr.message}`);
                            }

                            if (finalOutcome.kind === 'approved') {
                                log.info(`Final reviewer approved PR #${ghPr.number} after strong fixer`);
                                prStatus = 'approved';
                            } else {
                                log.warn(`Final reviewer still requested changes for PR #${ghPr.number} after strong fixer — leaving as-is`);
                                allTranscript.push(msg('conductor', `Strong fixer final review: still requesting changes — PR left open`));
                            }
                        } catch (finalRevErr: any) {
                            log.error(`Strong fixer final review failed: ${finalRevErr.message}`);
                        }
                    } else {
                        log.warn('No reviewer available for strong fixer final review — leaving PR as-is');
                    }
                } catch (fixerErr: any) {
                    log.error(`Strong fixer failed: ${fixerErr.message}`);
                    allTranscript.push(msg('conductor', `Strong fixer failed: ${fixerErr.message}`));
                } finally {
                    // Sub-Plan 06 §2: commit strong fixer work in finally
                    commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                        `strong fixer pass (model: ${STRONG_FIXER_MODEL || PRINCIPAL_DEV_MODEL})`, gitContext);
                }
                } // Plan 24 B2: end of precondition-check else block
            }
        }

        // ── 4. Merge PR (Sub-Plan 07: evidence-based) ───────────────────
        // Collect evidence for decideMerge
        const allBlockingComments = allReviews
            .flatMap(r => r.comments)
            .filter(c => !c.resolved && (c.severity === 'critical' || c.severity === 'major'));
        const diffStatForMerge = gitExec(worktreeWorkspace, `diff --name-only ${baseRef}...HEAD`);
        const filesChangedCount = (diffStatForMerge && !diffStatForMerge.startsWith('Error:'))
            ? diffStatForMerge.split('\n').filter(f => f.trim()).length : 0;

        const unmetCriteriaCount = allOutcomes
            .filter((o): o is Extract<ReviewOutcome, { kind: 'approved' | 'changes_requested' }> => o.kind !== 'abstained')
            .reduce((sum, o) => sum + (o.output.criteriaVerdicts ?? []).filter(v => !v.met).length, 0);

        const mergeDecision = decideMerge({
            approvals: allOutcomes.filter(o => o.kind === 'approved').length,
            blockingComments: allBlockingComments,
            abstentions: allOutcomes.filter(o => o.kind === 'abstained').length,
            gateReport,
            integrityFindings,
            layoutViolations: [],
            filesChanged: filesChangedCount,
            iterationsUsed: getEffectiveLimits().maxReviewIterations,
            policy: REVIEW_MERGE_POLICY,
            quorum: REVIEW_QUORUM,
            unmetCriteriaCount,
        });

        if (!mergeDecision.merge && REVIEW_MERGE_POLICY !== 'legacy') {
            log.warn(`PR #${ghPr.number} blocked: ${mergeDecision.reason}`);
            prStatus = 'blocked';
            emitRunEvent('pr:blocked', { prNumber: ghPr.number, blockers: mergeDecision.blockers });
            allTranscript.push(msg('conductor', `PR #${ghPr.number} BLOCKED: ${mergeDecision.blockers.join('; ')}`));

            // Post blocker comment on the PR
            try {
                await octokit.issues.createComment({
                    owner: ghOwner, repo: ghRepo,
                    issue_number: ghPr.number,
                    body: `:x: **[BLOCKED]** This PR cannot be merged.\n\n${mergeDecision.blockers.map(b => `- ${b}`).join('\n')}`,
                });
            } catch (commentErr: any) {
                log.warn(`Failed to post blocker comment: ${commentErr.message}`);
            }
        }

        if (prStatus === 'approved' || (prStatus === 'open' && REVIEW_MERGE_POLICY === 'legacy')) {
            if (prStatus === 'open') {
                log.warn(`Max review iterations reached. Merging PR #${ghPr.number} despite pending reviews (legacy policy).`);
                allTranscript.push(msg('conductor', `WARNING: Max review iterations reached, merging anyway (legacy policy)`));
            }

            // Sub-Plan 06 §5c: Merge ladder (merge, not rebase — branch is already pushed/reviewed)
            gitExec(worktreeWorkspace, `fetch origin ${baseBranch}`);

            // Check if already up to date
            const isAncestor = gitExecVerbose(worktreeWorkspace, `merge-base --is-ancestor origin/${baseBranch} HEAD`);
            if (!isAncestor.ok) {
                // Need to integrate base changes
                const mergeResult = gitExecVerbose(worktreeWorkspace, `merge origin/${baseBranch} --no-edit`);
                if (!mergeResult.ok) {
                    // Merge failed — attempt auto-resolution
                    log.warn(`Merge conflict on ${branchName}, attempting auto-resolution...`);
                    const conflicted = listConflictedFiles(worktreeWorkspace);
                    let resolved = false;

                    if (conflicted.length > 0) {
                        const resolution = resolveKnownConflicts(worktreeWorkspace, conflicted, `origin/${baseBranch}`);
                        if (resolution.unresolved.length === 0) {
                            // All conflicts auto-resolved
                            gitExec(worktreeWorkspace, `commit --no-edit`);
                            resolved = true;
                            log.info(`All ${resolution.resolved.length} conflict(s) auto-resolved`);
                        } else {
                            // Some unresolved — give dev agent a chance
                            log.warn(`${resolution.unresolved.length} conflict(s) need manual resolution: ${resolution.unresolved.join(', ')}`);
                            for (let attempt = 0; attempt < MERGE_CONFLICT_FIX_ATTEMPTS; attempt++) {
                                try {
                                    const primaryDevId = assignments[0].devAgentId;
                                    const primaryEntry = getDevAgent(primaryDevId);
                                    if (!primaryEntry) break;

                                    const conflictConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                                    const buildConflictFn = () => buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, conflictConventions, isMaintainMode);
                                    const conflictAgent = buildConflictFn();

                                    // Read conflict markers (capped)
                                    const conflictDetails = resolution.unresolved.map(f => {
                                        try {
                                            const content = fs.readFileSync(path.join(worktreeWorkspace, f), 'utf-8');
                                            return `### ${f}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``;
                                        } catch { return `### ${f}\n(cannot read)`; }
                                    }).join('\n\n');

                                    const conflictMsg = [
                                        contextPrompt,
                                        `\n## Merge Conflict Resolution`,
                                        `\nYour branch \`${branchName}\` has merge conflicts with \`${baseBranch}\`.`,
                                        `\n## Conflicted Files\n\n${conflictDetails}`,
                                        `\n## Instructions`,
                                        `Resolve ALL conflict markers (<<<<<<< / ======= / >>>>>>>) in the listed files.`,
                                        `Keep YOUR changes where they represent intended functionality.`,
                                        `Keep BASE changes for shared config (package.json scripts, tsconfig).`,
                                        `After resolving, stage all files with git add.`,
                                    ].join('\n');

                                    const conflictModel = getModelForRank(primaryEntry.rank as DevRank);
                                    try {
                                        await invokeDevAgent(conflictAgent, conflictMsg, `conflict-${primaryEntry.id}-${branchName}`, primaryEntry.id, conflictModel, buildConflictFn, respawnCtx);
                                    } catch (devConflictErr: any) {
                                        log.warn(`Dev conflict resolution attempt ${attempt + 1} failed: ${devConflictErr.message}`);
                                    } finally {
                                        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                                            `resolve merge conflicts (attempt ${attempt + 1})`, gitContext);
                                    }

                                    // Check if conflicts are resolved
                                    const stillConflicted = listConflictedFiles(worktreeWorkspace);
                                    if (stillConflicted.length === 0) {
                                        resolved = true;
                                        log.info(`Merge conflicts resolved by dev agent (attempt ${attempt + 1})`);
                                        break;
                                    }
                                } catch (conflictErr: any) {
                                    log.error(`Conflict resolution attempt ${attempt + 1} failed: ${conflictErr.message}`);
                                }
                            }
                        }
                    }

                    if (!resolved) {
                        // Cannot resolve — salvage and mark as blocked
                        log.error(`Cannot resolve conflicts for ${branchName}`);
                        emitRunEvent('pr:conflict', { branch: branchName, baseBranch });
                        prStatus = 'open';
                        allTranscript.push(msg('conductor', `Merge blocked: unresolvable conflicts on ${branchName}`));
                    } else {
                        gitPush(worktreeWorkspace, branchName, gitContext);
                    }
                } else {
                    gitPush(worktreeWorkspace, branchName, gitContext);
                }
            }

            // Verify branch exists on remote before merging
            const lsRemote = gitExec(worktreeWorkspace, `ls-remote --heads origin ${branchName}`);
            if (!lsRemote || lsRemote.startsWith('Error:')) {
                log.error(`Branch ${branchName} not found on remote — skipping merge`);
                prStatus = 'open';
            }

            // Block merge when critical secrets were detected
            if (secretsBlockMerge) {
                log.error(`Merge blocked for PR #${ghPr.number}: critical secrets detected`);
                prStatus = 'open';
                allTranscript.push(msg('security-gates', `Merge blocked for PR #${ghPr.number}: critical secrets detected`));
                try {
                    await octokit.issues.createComment({
                        owner: ghOwner, repo: ghRepo,
                        issue_number: ghPr.number,
                        body: ':x: **Merge blocked by security gate** — critical secrets detected in this PR. Remove hard-coded credentials before merging.',
                    });
                } catch (commentErr: any) {
                    log.warn(`Failed to post security block comment: ${commentErr.message}`);
                }
            }

            if (!secretsBlockMerge && (prStatus === 'approved' || prStatus === 'open')) {
                // Plan 24, A1: assert PR head matches branchName before merge/deleteRef.
                // This guard prevents merging/deleting the wrong branch when findExistingPR
                // previously returned a PR for a different head.
                const prHeadRef = ghPr.head?.ref;
                if (prHeadRef && prHeadRef !== branchName) {
                    const err = new PrIdentityMismatchError(ghPr.number, branchName, prHeadRef);
                    log.error(err.message);
                    allTranscript.push(msg('conductor', err.message));
                    prStatus = 'open';
                } else {
                try {
                    await octokit.pulls.merge({
                        owner: ghOwner,
                        repo: ghRepo,
                        pull_number: ghPr.number,
                        merge_method: 'squash',
                    });
                    prStatus = 'merged';
                    log.info(`PR #${ghPr.number} merged to ${baseBranch}`);
                    emitRunEvent('pr:merged', { prNumber: ghPr.number, branch: branchName, baseBranch });
                    allTranscript.push(msg('conductor', `PR #${ghPr.number} merged to ${baseBranch}`));

                    // Delete the remote feature branch
                    try {
                        await octokit.git.deleteRef({
                            owner: ghOwner,
                            repo: ghRepo,
                            ref: `heads/${branchName}`,
                        });
                        log.info(`Deleted remote branch: ${branchName}`);
                    } catch (delErr: any) {
                        log.warn(`Failed to delete remote branch ${branchName}: ${delErr.message}`);
                    }
                } catch (err: any) {
                    log.error(`Merge failed: ${err.message}`);
                    allTranscript.push(msg('conductor', `Merge failed: ${err.message}`));
                    prStatus = 'open';
                }
                } // end Plan 24 A1 head-match else
            }
        }

        // ── 5. Build result ─────────────────────────────────────────────
        // If critical integrity findings exist in enforce mode, block the merge
        const criticalIntegrity = integrityFindings.filter(f => f.severity === 'critical');
        if (criticalIntegrity.length > 0 && GATE_INTEGRITY_MODE === 'enforce' && prStatus === 'approved') {
            log.warn(`PR blocked due to ${criticalIntegrity.length} critical integrity finding(s)`);
            prStatus = 'open';
        }

        // Sub-Plan 06 §6: Compute evidence-based completion
        let completionEvidence: CompletionEvidence[] | undefined;
        let salvageBranch: string | undefined;
        if (prStatus === 'merged') {
            // Count real source file changes on the merged branch
            const diffNames = gitExec(worktreeWorkspace, `diff --name-only ${baseRef}..HEAD`);
            const changedFiles = (diffNames && !diffNames.startsWith('Error:'))
                ? diffNames.split('\n').filter(f => f.trim() && !f.startsWith('docs/') && !f.startsWith('.agent/') && !f.startsWith('.conventions/') && !f.endsWith('-mission.md'))
                : [];

            completionEvidence = assignments.map(a => {
                // Check declared modules exist on disk
                const moduleIds = a.moduleIds ?? [];
                let declaredPresent = 0;
                for (const modId of moduleIds) {
                    // moduleId is a path like "src/game/GameEngine.ts"
                    if (fs.existsSync(path.join(worktreeWorkspace, modId))) {
                        declaredPresent++;
                    }
                }
                return {
                    assignmentId: a.id,
                    filesChanged: changedFiles.length,
                    declaredModulesPresent: declaredPresent,
                    declaredModulesTotal: moduleIds.length,
                    gatePassed: gateReport?.passed ?? false,
                    merged: true,
                };
            });
        } else if ((prStatus === 'open' || prStatus === 'blocked') && outputPath) {
            // Sub-Plan 06 §3: Salvage the branch
            salvageWorktree(worktreeWorkspace, gitRoot, baseRef, branchName,
                `PR #${ghPr.number} not merged (status: ${prStatus})`, outputPath);
            salvageBranch = branchName;
        }

        const pullRequest: PullRequest = {
            id: `PR-${ghPr.number}`,
            prNumber: ghPr.number,
            prUrl: ghPr.html_url,
            title: prTitle,
            description: prBody,
            branchName,
            authorAgentId: assignments[0].devAgentId,
            reviewerAgentIds,
            reviews: allReviews,
            status: prStatus,
            assignmentIds: assignments.map(a => a.id),
            taskType,
            currentState,
            ...(integrityFindings.length > 0 ? { integrityFindings } : {}),
        };

        return {
            pullRequest,
            fileChanges: allFileChanges,
            artifacts: allArtifacts,
            transcript: allTranscript,
            tokenUsage: allTokenUsage,
            completionEvidence,
            salvageBranch,
            phantomFileChanges: allPhantomFileChanges.length > 0 ? allPhantomFileChanges : undefined,
        };
    } finally {
        // ── Sub-Plan 06 §3: Worktree disposal ───────────────────────────
        // Successful merge → remove (as before).
        // Anything else  → move to .worktrees-failed/ for salvage, do not delete remote branch.
        if (fs.existsSync(worktreeDir)) {
            // Determine if this was a successful merge by checking if the branch was deleted
            // (remote branch deletion only happens on success path above)
            const branchStillExists = (() => {
                try {
                    const localBranches = gitExec(gitRoot, `branch --list ${branchName}`);
                    return localBranches.trim().length > 0;
                } catch { return true; }
            })();

            if (!branchStillExists) {
                // Success path — remove worktree
                gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
                log.info(`Cleaned up worktree: ${worktreeSlug}`);
            } else {
                // Failure path — preserve for salvage
                const failedDir = path.join(gitRoot, '.worktrees-failed');
                try {
                    fs.mkdirSync(failedDir, { recursive: true });
                    const failedPath = path.join(failedDir, worktreeSlug);
                    // Remove destination if it already exists
                    if (fs.existsSync(failedPath)) {
                        fs.rmSync(failedPath, { recursive: true, force: true });
                    }
                    // git worktree move requires the destination to NOT exist
                    const moveResult = gitExecVerbose(gitRoot, `worktree move "${worktreeDir}" "${failedPath}"`);
                    if (moveResult.ok) {
                        log.info(`Preserved failed worktree: ${worktreeSlug} → .worktrees-failed/`);
                    } else {
                        // Fallback: just rename the directory
                        fs.renameSync(worktreeDir, failedPath);
                        log.info(`Moved failed worktree directory: ${worktreeSlug} → .worktrees-failed/`);
                    }
                    evictStaleSalvageWorktrees(gitRoot);
                } catch (moveErr: any) {
                    log.warn(`Failed to preserve worktree (removing): ${moveErr.message}`);
                    gitExec(gitRoot, `worktree remove "${worktreeDir}" --force`);
                }
            }
        }
        // Prune any dangling worktree tracking entries (fixes A11 leak-proofing)
        gitExec(gitRoot, 'worktree prune');
        // Only delete local branch on success (remote branch already handled above)
        gitExec(gitRoot, `branch -D ${branchName}`);
    }
}
