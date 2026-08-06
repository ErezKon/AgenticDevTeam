/**
 * Run helpers — start a full orchestration run in autonomous or HITL mode.
 */
import { createConductor, type ConductorOptions } from './graph';
import { getLogger } from '../utils/logger';
import { tokenTracker } from '../utils/token-tracker';
import { refreshTokenReport } from '../utils/token-report';
import { writeStateSnapshot, writeRunManifest } from '../utils/run-snapshot';
import type { RunInput, RepoTarget, PhaseName } from '../agents/_shared/base-schemas';
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
                const result = await conductor.invoke(
                    {
                        approvals: [approval],
                        pendingRerun: state.phase as PhaseName,
                        phaseFeedback: { [state.phase]: [feedback] },
                    },
                    { configurable: { thread_id: threadId } },
                );
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
                const result = await conductor.invoke(
                    {
                        approvals: [approval],
                        cancelled: true,
                    },
                    { configurable: { thread_id: threadId } },
                );
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

        // Add approval to state
        const approval = {
            phase: state.phase,
            decision: 'approve' as const,
            feedback,
            timestamp: new Date().toISOString(),
        };

        try {
            const result = await conductor.invoke(
                { approvals: [approval] },
                { configurable: { thread_id: threadId } },
            );

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
            const result = await conductor.invoke(
                {
                    approvals: [approval],
                    pendingRerun: state.phase as PhaseName,
                    phaseFeedback: { [state.phase]: [feedback] },
                },
                { configurable: { thread_id: threadId } },
            );
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
            const result = await conductor.invoke(
                { approvals: [approval], cancelled: true },
                { configurable: { thread_id: threadId } },
            );
            return result as ProjectStateType;
        }

        const approval = {
            phase: state.phase,
            decision: 'approve' as const,
            feedback,
            timestamp: new Date().toISOString(),
        };
        const result = await conductor.invoke(
            { approvals: [approval] },
            { configurable: { thread_id: threadId } },
        );
        return result as ProjectStateType;
    }

    return { threadId, conductor, getState, resume };
}
