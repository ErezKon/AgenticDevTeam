/**
 * Agent invocation helpers — dev and reviewer agent invocation with respawn.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { getLogger } from '../../utils/logger';
import { gitExec } from '../../utils/git-exec';
import { retryWithBackoff } from '../../utils/retry';
import { buildHandoff, renderHandoff, madeProgress } from '../agent-respawn';
import { getEffectiveLimits, InvocationBudgetExceededError } from '../../utils/run-budget';
import {
    DEV_RECURSION_LIMIT, REVIEWER_RECURSION_LIMIT,
    PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL, JUNIOR_DEV_MODEL,
    AGENT_RESPAWN_ENABLED, AGENT_RESPAWN_MAX_GENERATIONS,
    MAX_INVOCATION_INPUT_TOKENS,
} from '../../config';
import { parseAgentJson, validateAgentOutput, extractAgentText } from '../../utils/structured-output';
import { logAgentResponse } from '../../utils/response-log';
import { DeveloperOutputSchema } from '../../agents/developers/schemas/dev-output.schema';
import { ReviewOutputSchema } from '../../agents/developers/schemas/review-output.schema';
import { extractTokenUsageFromMessages } from '../../utils/token-usage-extractor';
import { tokenTracker, type TokenCallRecord } from '../../utils/token-tracker';
import { emitRunEvent } from '../../utils/event-bus';
import {
    isBlockingReview, type ReviewOutcome,
    enforceCriteriaVerdicts,
} from '../review-policy';
import type { DeveloperOutput } from '../../agents/developers/schemas/dev-output.schema';
import type { ReviewOutput } from '../../agents/developers/schemas/review-output.schema';
import type { DevRank } from '../../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

/**
 * Consecutive no-progress respawn generations tolerated before termination
 * (Plan 22, C3). One retry is worth it — the handoff may unblock the agent;
 * four are not: `junior-react` spent 4 respawns and 882k input tokens on
 * reconnaissance in the pacmanclaude run.
 */
const MAX_CONSECUTIVE_ZERO_WRITE_GENERATIONS = 1;

/** Resolve the LLM model name for a developer/reviewer rank. */
export function getModelForRank(rank: DevRank): string {
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
export function parseDevResult(
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
export async function invokeDevAgent(
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
export async function invokeReviewerAgent(
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

// ─── Base-ref resolution ─────────────────────────────────────────────────────

/**
 * Resolve baseBranch to a ref that exists in the worktree.
 * Worktrees don't have local branches for the base — only origin/ remotes.
 */
export function resolveBaseRef(worktreeDir: string, baseBranch: string): string {
    // Try local branch first
    const localCheck = gitExec(worktreeDir, `rev-parse --verify --quiet ${baseBranch}`);
    if (localCheck && !localCheck.startsWith('Error')) return baseBranch;
    // Fall back to origin/<baseBranch>
    const remoteCheck = gitExec(worktreeDir, `rev-parse --verify --quiet origin/${baseBranch}`);
    if (remoteCheck && !remoteCheck.startsWith('Error')) return `origin/${baseBranch}`;
    // Last resort: return as-is
    return baseBranch;
}
