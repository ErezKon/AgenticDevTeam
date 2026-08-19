/**
 * Node guards and preamble utilities — shared by all pipeline phase nodes.
 *
 * Includes:
 * - ts()            — ISO timestamp helper
 * - msg()           — TranscriptMessage factory (emits run event)
 * - buildFeedbackSection() — reviewer feedback for HITL enhance
 * - checkRerun()    — pendingRerun flag check
 * - shouldSkipOnContinue() — continue-run idempotency guard
 * - checkBudgetStop()      — budget-exhaustion guard
 * - phaseNode()     — decorator that wraps a node body with the standard preamble
 */
import { getLogger } from '../../utils/logger';
import { emitRunEvent } from '../../utils/event-bus';
import { shouldStopRun, getBudgetStatus } from '../../utils/run-budget';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import { appendLedger } from '../../utils/run-ledger';
import { setLastKnownState } from '../../utils/run-context';
import { haltIfUnrecoverable } from '../acceptance-gate';
import { RUN_FAIL_POLICY } from '../../config';
import type { ProjectStateType } from '../state';
import type { PhaseName, TranscriptMessage } from '../../agents/_shared/base-schemas';

// ─── Timestamp ──────────────────────────────────────────────────────────────

export function ts(): string { return new Date().toISOString(); }

// ─── Transcript message factory ─────────────────────────────────────────────

export function msg(agentId: string, phase: PhaseName, message: string): TranscriptMessage {
    emitRunEvent('transcript', { agentId, phase, message });
    return { timestamp: ts(), agentId, phase, message };
}

// ─── Reviewer feedback ──────────────────────────────────────────────────────

/**
 * Build a highest-priority feedback section for a phase's user message when
 * `state.phaseFeedback[phase]` is non-empty.
 *
 * This is the change that makes "enhance" real — the user's feedback is
 * injected into the agent's prompt so it can address the specific concerns.
 */
export function buildFeedbackSection(state: ProjectStateType, phase: PhaseName): string {
    const feedback = state.phaseFeedback?.[phase];
    if (!feedback || feedback.length === 0) return '';
    const numbered = feedback.map((f, i) => `${i + 1}. ${f}`).join('\n');
    return `## Reviewer Feedback — you MUST address this\n${numbered}`;
}

// ─── Rerun check ────────────────────────────────────────────────────────────

/**
 * Check if this node is being re-run via pendingRerun, and return
 * partial state updates to clear the flag. Also logs the re-run.
 */
export function checkRerun(state: ProjectStateType, phase: PhaseName, logger: ReturnType<typeof getLogger>): Partial<ProjectStateType> | null {
    if (state.pendingRerun === phase) {
        logger.info(`Re-running ${phase} with user feedback`);
        return { pendingRerun: null as any };
    }
    return null;
}

// ─── Continue-run idempotency (Plan 23, Sub-Plan 04) ────────────────────────

/**
 * Phase ordering for continue-run skip logic.
 * Must match the pipeline flow defined in graph.ts.
 */
export const CONTINUE_PHASE_ORDER: PhaseName[] = [
    'intake',
    'codebase-analyzer',
    'architect',
    'product-manager',
    'dba',
    'team-leader',
    'development',
    'qa',
    'bugfix-triage',
    'devops',
    'e2e',
    'acceptance-gate',
    'finalize',
];
const CONTINUE_PHASE_INDEX = new Map(CONTINUE_PHASE_ORDER.map((p, i) => [p, i]));

/**
 * Check whether a node should skip execution during a continuation run.
 *
 * Returns `true` when:
 *   1. `state._isContinuation` is true, AND
 *   2. `state._resumePhase` is set, AND
 *   3. The current phase's index is strictly before the resume phase's index
 *
 * Nodes at or after the resume phase execute normally.
 * This guard is intentionally conservative — if the indices cannot be resolved,
 * it returns `false` (execute the node).
 */
export function shouldSkipOnContinue(
    state: ProjectStateType,
    currentPhase: PhaseName,
    logger: ReturnType<typeof getLogger>,
): boolean {
    if (!state._isContinuation || !state._resumePhase) return false;

    const currentIdx = CONTINUE_PHASE_INDEX.get(currentPhase);
    const resumeIdx = CONTINUE_PHASE_INDEX.get(state._resumePhase);

    if (currentIdx === undefined || resumeIdx === undefined) return false;

    if (currentIdx < resumeIdx) {
        logger.info(
            `Skipping ${currentPhase} — continuation resume target is ${state._resumePhase}`,
        );
        return true;
    }

    return false;
}

// ─── Budget guard ───────────────────────────────────────────────────────────

/**
 * Plan 25: Check if the run should stop due to budget exhaustion.
 * Returns a partial state update that sets `cancelled=true` and `_stopReason`
 * if the budget has reached 'stop' level, or `null` if the run should continue.
 *
 * Call this at the start of each node (after the continue-run skip check).
 * The graph's conditional edges already check `cancelled` and route to finalize.
 */
export function checkBudgetStop(
    state: ProjectStateType,
    phase: PhaseName,
    logger: ReturnType<typeof getLogger>,
): Partial<ProjectStateType> | null {
    if (!shouldStopRun()) return null;

    const budget = getBudgetStatus();
    const reason = `budget-exhausted:${budget.binding}`;
    logger.warn(
        `Budget exhausted (${budget.binding} at ${(budget.utilisation * 100).toFixed(1)}%) ` +
        `— stopping run gracefully at phase "${phase}" for continue-run pickup`,
    );
    emitRunEvent('run:budget-stop', {
        phase,
        binding: budget.binding,
        utilisation: budget.utilisation,
        usedTokens: budget.usedTokens,
        estCostUsd: budget.estCostUsd,
        elapsedMs: budget.elapsedMs,
    });

    // Write a snapshot so continue-run has the latest state
    writePeriodicSnapshot(state.outputPath, state, phase);

    return {
        phase,
        cancelled: true,
        _stopReason: reason,
        transcript: [msg('conductor', phase, `Run stopped: budget exhausted (${budget.binding} at ${(budget.utilisation * 100).toFixed(1)}%)`)],
    };
}

// ─── Phase node decorator ───────────────────────────────────────────────────

/**
 * Options for the phaseNode decorator.
 */
export interface PhaseNodeOpts {
    /** Check budget and stop if exhausted (default: true). */
    budgetCheck?: boolean;
    /** Check for pendingRerun (default: true). */
    rerunCheck?: boolean;
    /** Check haltIfUnrecoverable (default: false). */
    haltCheck?: boolean;
}

/**
 * Decorator that wraps a node body with the standard 7-line preamble:
 *
 *   1. shouldSkipOnContinue → return early
 *   2. emitRunEvent('phase:start')
 *   3. writePeriodicSnapshot
 *   4. (optional) checkBudgetStop
 *   5. (optional) haltIfUnrecoverable
 *   6. (optional) checkRerun
 *   7. call body(state, ctx)
 *
 * Eliminates the 11-copy preamble pattern across all middle phase nodes.
 */
export function phaseNode(
    phase: PhaseName,
    log: ReturnType<typeof getLogger>,
    opts: PhaseNodeOpts,
    body: (state: ProjectStateType, ctx: { rerunUpdate: Partial<ProjectStateType> | null }) => Promise<Partial<ProjectStateType>>,
): (state: ProjectStateType) => Promise<Partial<ProjectStateType>> {
    const doBudget = opts.budgetCheck !== false;
    const doRerun = opts.rerunCheck !== false;
    const doHalt = opts.haltCheck === true;

    return async (state: ProjectStateType): Promise<Partial<ProjectStateType>> => {
        // 1. Continue-run idempotency
        if (shouldSkipOnContinue(state, phase, log)) {
            return { phase };
        }

        // 2. Phase start event
        emitRunEvent('phase:start', { phase });

        // 3. Periodic snapshot
        writePeriodicSnapshot(state.outputPath, state, phase);

        // 4. Budget guard
        if (doBudget) {
            const budgetStop = checkBudgetStop(state, phase, log);
            if (budgetStop) return budgetStop;
        }

        // 5. Halt guard
        if (doHalt) {
            const haltUpdate = haltIfUnrecoverable(state, log, RUN_FAIL_POLICY);
            if (haltUpdate) return { ...haltUpdate, phase };
        }

        // 6. Rerun check
        let rerunUpdate: Partial<ProjectStateType> | null = null;
        if (doRerun) {
            rerunUpdate = checkRerun(state, phase, log);
        }

        // 7. Update last known state for graceful shutdown (Plan 27-G)
        setLastKnownState(state as Record<string, any>);

        // 8. Ledger: phase start (Plan 27-F)
        appendLedger({ kind: 'phase', phase, event: 'start' });
        const phaseStartMs = Date.now();

        // 9. Body
        const result = await body(state, { rerunUpdate });

        // 10. Ledger: phase end (Plan 27-F)
        appendLedger({ kind: 'phase', phase, event: 'end', durationMs: Date.now() - phaseStartMs });

        return result;
    };
}
