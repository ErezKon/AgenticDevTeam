/**
 * Run helpers — start a full orchestration run in autonomous or HITL mode,
 * or continue a previously stopped run.
 */
import { createConductor } from './graph';
import { getLogger } from '../utils/logger';
import { tokenTracker } from '../utils/token-tracker';
import { refreshTokenReport } from '../utils/token-report';
import { writeStateSnapshot, writeRunManifest } from '../utils/run-snapshot';
import { appendLedger } from '../utils/run-ledger';
import { collectRunState, reconstructState, reconcileGitState } from './continue';
import { rehydrateSingletons } from './continue/singleton-rehydration';
import type { RepoTarget, PhaseName } from '../agents/_shared/base-schemas';
import type { ProjectStateType } from './state';

const log = getLogger('[Run]', 46);

export interface RunOptions {
    /** System name for the generated product. */
    systemName: string;
    /** Full text of the requirements document. */
    requirementsText?: string;
    /** Path to the requirements file (alternative to requirementsText). */
    requirementsDocPath?: string;
    /** Run mode override. */
    mode?: 'autonomous' | 'human';
    /** Run type: 'greenfield' (new project) or 'maintain' (existing project). */
    runType?: 'greenfield' | 'maintain';
    /** Absolute path to the existing project root (required for maintain mode). */
    existingProjectPath?: string;
    /** Where the generated project should be hosted (greenfield only). */
    repoTarget?: RepoTarget;
}

/**
 * Start an autonomous run — the full pipeline executes start-to-finish.
 * Returns the final ProjectState snapshot.
 */
export async function runAutonomous(opts: RunOptions): Promise<ProjectStateType> {
    log.info(`Starting autonomous run for "${opts.systemName}"...`);

    const conductor = createConductor({ mode: 'autonomous' });
    const threadId = `run-${opts.systemName}-${Date.now()}`;

    const input: Partial<ProjectStateType> = {
        input: {
            systemName: opts.systemName,
            requirementsText: opts.requirementsText ?? '',
            requirementsDocPath: opts.requirementsDocPath,
            mode: 'autonomous',
            runType: opts.runType ?? 'greenfield',
            existingProjectPath: opts.existingProjectPath,
            repoTarget: opts.repoTarget,
        },
    };

    try {
        const finalState = await conductor.invoke(input, {
            configurable: { thread_id: threadId },
        });

        log.info('Autonomous run complete.');
        return finalState as ProjectStateType;
    } catch (err: any) {
        // Mark the run as failed and flush the token report with whatever
        // data was collected before the crash — ensures the report exists.
        tokenTracker.setRunStatus('failed');
        try { refreshTokenReport(); } catch { /* best-effort */ }

        // Best-effort crash snapshot — outputPath may not exist yet if
        // the crash happened before intakeNode completed.
        try {
            const snapshot = await conductor.getState({ configurable: { thread_id: threadId } });
            const crashState = snapshot?.values as ProjectStateType | undefined;
            if (crashState?.outputPath) {
                writeStateSnapshot(crashState.outputPath, crashState);
                writeRunManifest(crashState.outputPath, crashState, 'crashed');
            }
        } catch { /* best-effort */ }

        log.error(`Autonomous run failed: ${err?.message ?? err}`);
        if (err?.stack) log.error(err.stack);
        throw err;
    }
}

// ─── HITL decision type ─────────────────────────────────────────────────────

export type HitlDecision = 'approve' | 'deny' | 'enhance';

/**
 * Start a human-in-the-loop run.
 *
 * Returns a RunSession that the CLI or dashboard can drive step-by-step
 * via resume() calls after each interrupt.
 */
export interface RunSession {
    threadId: string;
    conductor: ReturnType<typeof createConductor>;
    /** Get the current state snapshot. */
    getState: () => Promise<ProjectStateType>;
    /**
     * Resume the graph after a HITL decision.
     *
     * @param decision  'approve' | 'deny' | 'enhance'
     * @param feedback  User feedback (required for 'enhance', optional for others)
     *
     * @deprecated Use the three-argument form `resume(decision, feedback)`.
     *             The old two-argument form `resume(approved: boolean, feedback?)` is
     *             still accepted for backward compatibility: `true` → 'approve',
     *             `false` → 'deny'.
     */
    resume: (decision: HitlDecision | boolean, feedback?: string) => Promise<ProjectStateType | null>;
}

export async function runHumanInTheLoop(opts: RunOptions): Promise<RunSession> {
    log.info(`Starting HITL run for "${opts.systemName}"...`);

    const conductor = createConductor({ mode: 'human' });
    const threadId = `run-${opts.systemName}-${Date.now()}`;

    const input: Partial<ProjectStateType> = {
        input: {
            systemName: opts.systemName,
            requirementsText: opts.requirementsText ?? '',
            requirementsDocPath: opts.requirementsDocPath,
            mode: 'human',
            runType: opts.runType ?? 'greenfield',
            existingProjectPath: opts.existingProjectPath,
            repoTarget: opts.repoTarget,
        },
    };

    // Start — will pause at the first interrupt point
    try {
        await conductor.invoke(input, {
            configurable: { thread_id: threadId },
        });
    } catch (err: any) {
        tokenTracker.setRunStatus('failed');
        try { refreshTokenReport(); } catch { /* best-effort */ }
        try {
            const snapshot = await conductor.getState({ configurable: { thread_id: threadId } });
            const crashState = snapshot?.values as ProjectStateType | undefined;
            if (crashState?.outputPath) {
                writeStateSnapshot(crashState.outputPath, crashState);
                writeRunManifest(crashState.outputPath, crashState, 'crashed');
            }
        } catch { /* best-effort */ }
        log.error(`HITL run failed during initial invoke: ${err?.message ?? err}`);
        if (err?.stack) log.error(err.stack);
        throw err;
    }

    async function getState(): Promise<ProjectStateType> {
        const snapshot = await conductor.getState({ configurable: { thread_id: threadId } });
        return snapshot.values as ProjectStateType;
    }

    async function resume(decisionOrBool: HitlDecision | boolean, feedback?: string): Promise<ProjectStateType | null> {
        // Backward-compat: boolean → HitlDecision
        let decision: HitlDecision;
        if (typeof decisionOrBool === 'boolean') {
            decision = decisionOrBool ? 'approve' : 'deny';
        } else {
            decision = decisionOrBool;
        }

        const state = await getState();

        const config = { configurable: { thread_id: threadId } };

        // ── Enhance ─────────────────────────────────────────────────────
        if (decision === 'enhance') {
            if (!feedback || feedback.trim() === '') {
                throw new Error('Enhance requires non-empty feedback — an enhance with no feedback is an infinite loop.');
            }
            log.info(`Phase "${state.phase}" enhance requested with feedback.`);
            const approval = {
                phase: state.phase,
                decision: 'enhance' as const,
                feedback,
                timestamp: new Date().toISOString(),
            };
            try {
                // Merge state updates into the checkpoint, then resume from
                // the interrupt — invoke(null) continues from the checkpoint
                // instead of re-starting from __start__.
                await conductor.updateState(config, {
                    approvals: [approval],
                    pendingRerun: state.phase as PhaseName,
                    phaseFeedback: { [state.phase]: [feedback] },
                });
                const result = await conductor.invoke(null, config);
                return result as ProjectStateType;
            } catch (err: any) {
                tokenTracker.setRunStatus('failed');
                try { refreshTokenReport(); } catch { /* best-effort */ }
                try {
                    const crashState = await getState();
                    if (crashState?.outputPath) {
                        writeStateSnapshot(crashState.outputPath, crashState);
                        writeRunManifest(crashState.outputPath, crashState, 'crashed');
                    }
                } catch { /* best-effort */ }
                log.error(`HITL enhance failed: ${err?.message ?? err}`);
                if (err?.stack) log.error(err.stack);
                throw err;
            }
        }

        // ── Deny ────────────────────────────────────────────────────────
        if (decision === 'deny') {
            log.warn(`Phase "${state.phase}" denied by user. Feedback: ${feedback ?? 'none'}`);
            tokenTracker.setRunStatus('cancelled');
            const approval = {
                phase: state.phase,
                decision: 'deny' as const,
                feedback,
                timestamp: new Date().toISOString(),
            };
            try {
                await conductor.updateState(config, {
                    approvals: [approval],
                    cancelled: true,
                });
                const result = await conductor.invoke(null, config);
                return result as ProjectStateType;
            } catch (err: any) {
                tokenTracker.setRunStatus('failed');
                try { refreshTokenReport(); } catch { /* best-effort */ }
                try {
                    const crashState = await getState();
                    if (crashState?.outputPath) {
                        writeStateSnapshot(crashState.outputPath, crashState);
                        writeRunManifest(crashState.outputPath, crashState, 'crashed');
                    }
                } catch { /* best-effort */ }
                log.error(`HITL deny failed: ${err?.message ?? err}`);
                if (err?.stack) log.error(err.stack);
                throw err;
            }
        }

        // ── Approve ─────────────────────────────────────────────────────
        log.info(`Phase "${state.phase}" approved. Resuming...`);

        const approval = {
            phase: state.phase,
            decision: 'approve' as const,
            feedback,
            timestamp: new Date().toISOString(),
        };

        try {
            await conductor.updateState(config, { approvals: [approval] });
            const result = await conductor.invoke(null, config);
            return result as ProjectStateType;
        } catch (err: any) {
            tokenTracker.setRunStatus('failed');
            try { refreshTokenReport(); } catch { /* best-effort */ }
            try {
                const crashState = await getState();
                if (crashState?.outputPath) {
                    writeStateSnapshot(crashState.outputPath, crashState);
                    writeRunManifest(crashState.outputPath, crashState, 'crashed');
                }
            } catch { /* best-effort */ }
            log.error(`HITL resume failed: ${err?.message ?? err}`);
            if (err?.stack) log.error(err.stack);
            throw err;
        }
    }

    return { threadId, conductor, getState, resume };
}

// ─── Resume a crashed / interrupted run ─────────────────────────────────────

/**
 * Resume a run from a saved checkpoint.
 *
 * With `CHECKPOINT_PERSIST=true`, a crashed or interrupted run's checkpoint
 * is persisted to `<outputPath>/checkpoints.json`. This function rebuilds the
 * conductor with the file checkpointer pointing at `outputPath` and resumes
 * from the last completed phase.
 */
export async function resumeRun(
    threadId: string,
    outputPath: string,
    opts?: { mode?: 'autonomous' | 'human' },
): Promise<RunSession | ProjectStateType> {
    const { FileCheckpointer } = await import('./file-checkpointer');
    const checkpointer = new FileCheckpointer(outputPath);

    const resolvedMode = opts?.mode ?? 'human';
    const conductor = createConductor({
        mode: resolvedMode,
        checkpointer,
        outputPath,
    });

    log.info(`Resuming run "${threadId}" from ${outputPath}...`);

    if (resolvedMode === 'autonomous') {
        try {
            const result = await conductor.invoke(null, {
                configurable: { thread_id: threadId },
            });
            log.info('Resumed autonomous run complete.');
            return result as ProjectStateType;
        } catch (err: any) {
            tokenTracker.setRunStatus('failed');
            try { refreshTokenReport(); } catch { /* best-effort */ }
            log.error(`Resumed autonomous run failed: ${err?.message ?? err}`);
            throw err;
        }
    }

    // HITL resume — return a session
    async function getState(): Promise<ProjectStateType> {
        const snapshot = await conductor.getState({ configurable: { thread_id: threadId } });
        return snapshot.values as ProjectStateType;
    }

    async function resume(decisionOrBool: HitlDecision | boolean, feedback?: string): Promise<ProjectStateType | null> {
        let decision: HitlDecision;
        if (typeof decisionOrBool === 'boolean') {
            decision = decisionOrBool ? 'approve' : 'deny';
        } else {
            decision = decisionOrBool;
        }

        const state = await getState();
        const config = { configurable: { thread_id: threadId } };

        if (decision === 'enhance') {
            if (!feedback || feedback.trim() === '') {
                throw new Error('Enhance requires non-empty feedback.');
            }
            const approval = {
                phase: state.phase,
                decision: 'enhance' as const,
                feedback,
                timestamp: new Date().toISOString(),
            };
            await conductor.updateState(config, {
                approvals: [approval],
                pendingRerun: state.phase as PhaseName,
                phaseFeedback: { [state.phase]: [feedback] },
            });
            const result = await conductor.invoke(null, config);
            return result as ProjectStateType;
        }

        if (decision === 'deny') {
            tokenTracker.setRunStatus('cancelled');
            const approval = {
                phase: state.phase,
                decision: 'deny' as const,
                feedback,
                timestamp: new Date().toISOString(),
            };
            await conductor.updateState(config, {
                approvals: [approval],
                cancelled: true,
            });
            const result = await conductor.invoke(null, config);
            return result as ProjectStateType;
        }

        const approval = {
            phase: state.phase,
            decision: 'approve' as const,
            feedback,
            timestamp: new Date().toISOString(),
        };
        await conductor.updateState(config, { approvals: [approval] });
        const result = await conductor.invoke(null, config);
        return result as ProjectStateType;
    }

    return { threadId, conductor, getState, resume };
}

// ─── Continue a stopped run (Plan 23, Sub-Plan 04) ──────────────────────────

export interface ContinueRunOptions {
    /** Absolute path to the stopped run's output directory (or an identifier for findRunOutputs). */
    outputPath: string;
    /** Run mode override. Defaults to 'autonomous'. */
    mode?: 'autonomous' | 'human';
    /** Optional thread ID. Auto-generated when omitted. */
    threadId?: string;
}

/**
 * Continue a previously stopped run from the last completed phase.
 *
 * 1. Collects all artifacts from the stopped run's output directory
 * 2. Reconstructs a valid ProjectState from state.json + ledger + git
 * 3. Resolves the correct phase to resume from
 * 4. Rehydrates global singletons (logger, ledger, response log, token tracker)
 * 5. Injects the reconstructed state into a new graph invocation with
 *    `_isContinuation=true` and `_resumePhase` set — completed nodes skip
 *    via the idempotency guard in shouldSkipOnContinue()
 *
 * Returns the final ProjectState (autonomous) or a RunSession (human).
 */
export async function continueRun(
    opts: ContinueRunOptions,
): Promise<RunSession | ProjectStateType> {
    const continueLog = getLogger('[ContinueRun]', 177);
    continueLog.info(`Continuing run from: ${opts.outputPath}`);

    // ── 1. Collect artifacts ─────────────────────────────────────────────
    const collected = collectRunState(opts.outputPath);

    if (!collected.workspaceExists) {
        throw new Error(
            `Cannot continue run — workspace directory not found: "${collected.workspacePath || '(unknown)'}". ` +
            `The generated project must exist on disk to continue.`,
        );
    }

    // ── 2. Reconstruct state ─────────────────────────────────────────────
    const { state: reconstructedState, resumePhase, confidence, warnings } = reconstructState(collected);

    continueLog.info(`Reconstruction confidence: ${confidence}`);
    continueLog.info(`Resume phase: ${resumePhase}`);
    if (warnings.length > 0) {
        for (const w of warnings) continueLog.warn(`  Warning: ${w}`);
    }

    if (confidence === 'minimal') {
        continueLog.warn(
            'Only minimal state reconstruction was possible. ' +
            'The continued run may repeat significant work.',
        );
    }

    // ── 3. Rehydrate singletons ──────────────────────────────────────────
    // These are normally initialised by intakeNode, which will be skipped
    // during continuation (its idempotency guard detects existing paths).
    rehydrateSingletons(collected, reconstructedState);

    // ── 3b. Git state reconciliation ─────────────────────────────────────
    // Verify and fix workspace git state before resuming. This cleans up
    // stale worktrees, lock files, and branches from the previous run.
    if (collected.workspaceIsGitRepo) {
        const reconciliation = reconcileGitState(collected, reconstructedState);
        if (reconciliation.warnings.length > 0) {
            for (const w of reconciliation.warnings) continueLog.warn(`  Git: ${w}`);
        }
        if (!reconciliation.ok) {
            continueLog.warn(
                'Git reconciliation completed with issues. The continued run may encounter git errors.',
            );
        }
    }

    // ── 4. Build the graph and invoke ────────────────────────────────────
    const resolvedMode = opts.mode ?? 'autonomous';
    const conductor = createConductor({
        mode: resolvedMode,
        outputPath: collected.outputPath,
    });
    const threadId = opts.threadId ?? `continue-${Date.now()}`;
    const config = { configurable: { thread_id: threadId } };

    // Inject the continuation flags into the state.
    // Plan 25: clear cancelled and _stopReason from the previous run — the user
    // is explicitly continuing, so budget/provider stops should not carry over.
    const initialState: Partial<ProjectStateType> = {
        ...reconstructedState as Partial<ProjectStateType>,
        _isContinuation: true,
        _resumePhase: resumePhase,
        cancelled: false,
        _stopReason: null,
    };

    // Append a ledger entry marking the continuation
    appendLedger({
        kind: 'phase',
        phase: resumePhase,
        event: 'start',
    });

    if (resolvedMode === 'autonomous') {
        try {
            const finalState = await conductor.invoke(initialState, config);
            continueLog.info('Continued autonomous run complete.');
            return finalState as ProjectStateType;
        } catch (err: any) {
            tokenTracker.setRunStatus('failed');
            try { refreshTokenReport(); } catch { /* best-effort */ }
            try {
                const snapshot = await conductor.getState(config);
                const crashState = snapshot?.values as ProjectStateType | undefined;
                if (crashState?.outputPath) {
                    writeStateSnapshot(crashState.outputPath, crashState);
                    writeRunManifest(crashState.outputPath, crashState, 'crashed');
                }
            } catch { /* best-effort */ }
            continueLog.error(`Continued autonomous run failed: ${err?.message ?? err}`);
            if (err?.stack) continueLog.error(err.stack);
            throw err;
        }
    }

    // ── HITL mode: return a session ──────────────────────────────────────
    try {
        await conductor.invoke(initialState, config);
    } catch (err: any) {
        tokenTracker.setRunStatus('failed');
        try { refreshTokenReport(); } catch { /* best-effort */ }
        try {
            const snapshot = await conductor.getState(config);
            const crashState = snapshot?.values as ProjectStateType | undefined;
            if (crashState?.outputPath) {
                writeStateSnapshot(crashState.outputPath, crashState);
                writeRunManifest(crashState.outputPath, crashState, 'crashed');
            }
        } catch { /* best-effort */ }
        continueLog.error(`Continued HITL run failed during initial invoke: ${err?.message ?? err}`);
        if (err?.stack) continueLog.error(err.stack);
        throw err;
    }

    async function getState(): Promise<ProjectStateType> {
        const snapshot = await conductor.getState(config);
        return snapshot.values as ProjectStateType;
    }

    async function resume(decisionOrBool: HitlDecision | boolean, feedback?: string): Promise<ProjectStateType | null> {
        let decision: HitlDecision;
        if (typeof decisionOrBool === 'boolean') {
            decision = decisionOrBool ? 'approve' : 'deny';
        } else {
            decision = decisionOrBool;
        }

        const state = await getState();

        if (decision === 'enhance') {
            if (!feedback || feedback.trim() === '') {
                throw new Error('Enhance requires non-empty feedback.');
            }
            const approval = {
                phase: state.phase,
                decision: 'enhance' as const,
                feedback,
                timestamp: new Date().toISOString(),
            };
            await conductor.updateState(config, {
                approvals: [approval],
                pendingRerun: state.phase as PhaseName,
                phaseFeedback: { [state.phase]: [feedback] },
            });
            const result = await conductor.invoke(null, config);
            return result as ProjectStateType;
        }

        if (decision === 'deny') {
            tokenTracker.setRunStatus('cancelled');
            const approval = {
                phase: state.phase,
                decision: 'deny' as const,
                feedback,
                timestamp: new Date().toISOString(),
            };
            await conductor.updateState(config, {
                approvals: [approval],
                cancelled: true,
            });
            const result = await conductor.invoke(null, config);
            return result as ProjectStateType;
        }

        const approval = {
            phase: state.phase,
            decision: 'approve' as const,
            feedback,
            timestamp: new Date().toISOString(),
        };
        await conductor.updateState(config, { approvals: [approval] });
        const result = await conductor.invoke(null, config);
        return result as ProjectStateType;
    }

    return { threadId, conductor, getState, resume };
}


