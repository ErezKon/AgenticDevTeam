/**
 * Run helpers — start a full orchestration run in autonomous or HITL mode.
 */
import { createConductor } from './graph';
import { getLogger } from '../utils/logger';
import { tokenTracker } from '../utils/token-tracker';
import { refreshTokenReport } from '../utils/token-report';
import type { RunInput, RepoTarget } from '../agents/_shared/base-schemas';
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

    const conductor = createConductor();
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
    } catch (err) {
        // Mark the run as failed and flush the token report with whatever
        // data was collected before the crash — ensures the report exists.
        tokenTracker.setRunStatus('failed');
        try { refreshTokenReport(); } catch { /* best-effort */ }
        log.error(`Autonomous run failed — token report saved with partial data.`);
        throw err;
    }
}

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
    /** Resume the graph after a HITL approval. */
    resume: (approved: boolean, feedback?: string) => Promise<ProjectStateType | null>;
}

export async function runHumanInTheLoop(opts: RunOptions): Promise<RunSession> {
    log.info(`Starting HITL run for "${opts.systemName}"...`);

    const conductor = createConductor();
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
    } catch (err) {
        tokenTracker.setRunStatus('failed');
        try { refreshTokenReport(); } catch { /* best-effort */ }
        log.error(`HITL run failed during initial invoke — token report saved with partial data.`);
        throw err;
    }

    async function getState(): Promise<ProjectStateType> {
        const snapshot = await conductor.getState({ configurable: { thread_id: threadId } });
        return snapshot.values as ProjectStateType;
    }

    async function resume(approved: boolean, feedback?: string): Promise<ProjectStateType | null> {
        const state = await getState();

        if (!approved) {
            log.warn(`Phase "${state.phase}" denied by user. Feedback: ${feedback ?? 'none'}`);
            // Approval denied — add to transcript but do not advance
            return null;
        }

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
        } catch (err) {
            tokenTracker.setRunStatus('failed');
            try { refreshTokenReport(); } catch { /* best-effort */ }
            log.error(`HITL resume failed — token report saved with partial data.`);
            throw err;
        }
    }

    return { threadId, conductor, getState, resume };
}
