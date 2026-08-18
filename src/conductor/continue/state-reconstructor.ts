/**
 * State Reconstructor — builds a valid ProjectState from collected run
 * artifacts and determines the correct phase to resume from.
 *
 * Combines Sub-Plan 02 (State Reconstructor) and Sub-Plan 03 (Phase Resolver).
 *
 * Primary path: state.json exists — restore all fields, rehydrate secrets.
 * Fallback path: state.json missing — reconstruct minimal state from
 * run-manifest.json + ledger + agent artifacts (degraded mode).
 */
import { getLogger } from '../../utils/logger';
import {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GIT_DEFAULT_BRANCH,
    GITHUB_PROJECT_TOKEN, GITHUB_PROJECT_OWNER,
} from '../../config';
import { gitExec } from '../../utils/git-exec';
import type { PhaseName } from '../../agents/_shared/schemas/phase.schema';
import type { LedgerEntry } from '../../utils/run-ledger';
import type { CollectedRunState } from './state-collector';

const log = getLogger('[StateReconstructor]', 220);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Confidence level of the reconstruction. */
export type ReconstructionConfidence = 'full' | 'partial' | 'minimal';

/** Result of state reconstruction. */
export interface ReconstructedState {
    /** The reconstructed state object, ready to inject into the graph. */
    state: Record<string, any>;
    /** The phase to resume from (the first incomplete phase). */
    resumePhase: PhaseName;
    /** How much of the state we were able to reconstruct. */
    confidence: ReconstructionConfidence;
    /** Warnings about missing or degraded data. */
    warnings: string[];
}

// ─── Phase ordering ─────────────────────────────────────────────────────────

/** Ordered list of all pipeline phases (matches the pipeline flow). */
const PHASE_ORDER: PhaseName[] = [
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

/** Index of each phase in the pipeline. */
const PHASE_INDEX = new Map(PHASE_ORDER.map((p, i) => [p, i]));

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Reconstruct a valid ProjectState from collected run artifacts.
 *
 * Never throws — returns a result with warnings for any issues encountered.
 */
export function reconstructState(collected: CollectedRunState): ReconstructedState {
    const warnings: string[] = [];

    if (collected.stateSnapshot) {
        return reconstructFromStateJson(collected, warnings);
    }

    if (collected.manifest) {
        return reconstructFromManifest(collected, warnings);
    }

    // Neither state.json nor manifest — we can barely do anything
    warnings.push(
        'Neither state.json nor run-manifest.json found. ' +
        'Only ledger-based reconstruction is possible (very limited).',
    );
    return reconstructFromLedgerOnly(collected, warnings);
}

// ─── Primary path: state.json ───────────────────────────────────────────────

function reconstructFromStateJson(
    collected: CollectedRunState,
    warnings: string[],
): ReconstructedState {
    const snapshot = collected.stateSnapshot!;
    const state: Record<string, any> = { ...snapshot };

    // ── Rehydrate secrets ────────────────────────────────────────────────
    rehydrateSecrets(state, warnings);

    // ── Restore paths (in case the run output or workspace moved) ────────
    if (collected.workspaceExists && state.workspacePath !== collected.workspacePath) {
        // Workspace path from disk takes precedence when it exists
        if (collected.workspacePath && state.workspacePath) {
            warnings.push(
                `Workspace path mismatch: state.json says "${state.workspacePath}" ` +
                `but disk has "${collected.workspacePath}". Using disk path.`,
            );
        }
    }
    if (collected.workspacePath && collected.workspaceExists) {
        state.workspacePath = collected.workspacePath;
    }

    // Output path should point to the actual output directory
    state.outputPath = collected.outputPath;

    // ── Validate key state fields ────────────────────────────────────────
    validateStateFields(state, warnings);

    // ── Determine resume phase ───────────────────────────────────────────
    const resumePhase = resolveResumePhase(state, collected, warnings);

    // ── Determine confidence ─────────────────────────────────────────────
    let confidence: ReconstructionConfidence = 'full';
    if (warnings.length > 0) {
        confidence = warnings.some(w => w.includes('Critical'))
            ? 'partial'
            : 'full';
    }

    log.info(`Reconstructed state from state.json (confidence=${confidence}, resumePhase=${resumePhase})`);
    return { state, resumePhase, confidence, warnings };
}

// ─── Fallback: manifest only ────────────────────────────────────────────────

function reconstructFromManifest(
    collected: CollectedRunState,
    warnings: string[],
): ReconstructedState {
    const manifest = collected.manifest!;
    warnings.push(
        'state.json not found — reconstructing from run-manifest.json (degraded mode). ' +
        'Only limited continuation is possible.',
    );

    const state: Record<string, any> = {
        input: {
            systemName: manifest.systemName ?? '',
            requirementsText: '',
            mode: 'autonomous',
            runType: manifest.runType ?? 'greenfield',
        },
        workspacePath: collected.workspacePath,
        outputPath: collected.outputPath,
        systemBranch: '',
        gitContext: null,
        phase: (manifest.finalPhase ?? 'intake') as PhaseName,
        iteration: { bugfix: 0 },
        // All arrays start empty — we lost the structured data
        epics: [],
        techStack: [],
        userStories: [],
        tasks: [],
        assignments: [],
        completedAssignmentIds: [],
        fileChanges: [],
        testPlan: null,
        testReports: [],
        bugs: [],
        fixedBugIds: [],
        pullRequests: [],
        approvals: [],
        artifacts: [],
        transcript: [],
        tokenUsage: [],
        verificationErrors: [],
        dispatchRounds: [],
        attemptedBugIds: [],
        bugAttempts: {},
        planViolations: [],
        completionEvidence: [],
        salvageBranches: [],
        phantomFileChanges: [],
        qaClaimDiscrepancies: [],
        invariantViolations: [],
        // Scalars
        codebaseAnalysis: null,
        architecture: null,
        repoContract: null,
        dbDesign: null,
        devopsPlan: null,
        runningContainers: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        acceptance: null,
        latestGateReport: null,
        unrecoverable: null,
        e2eStatus: 'not-run',
        e2eSkipReason: null,
        e2eEvidence: null,
    };

    // Rehydrate secrets
    rehydrateSecrets(state, warnings);

    // Try to detect system branch from git
    if (collected.workspaceIsGitRepo && collected.workspacePath) {
        const systemBranch = detectSystemBranch(collected);
        if (systemBranch) {
            state.systemBranch = systemBranch;
        }
    }

    // Determine the resume phase from ledger evidence
    const resumePhase = resolveResumePhaseFromLedger(
        collected.ledgerEntries,
        state,
        warnings,
    );

    log.info(`Reconstructed state from manifest (confidence=partial, resumePhase=${resumePhase})`);
    return { state, resumePhase, confidence: 'partial', warnings };
}

// ─── Fallback: ledger only ──────────────────────────────────────────────────

function reconstructFromLedgerOnly(
    collected: CollectedRunState,
    warnings: string[],
): ReconstructedState {
    const state: Record<string, any> = {
        input: {
            systemName: '',
            requirementsText: '',
            mode: 'autonomous',
            runType: 'greenfield',
        },
        workspacePath: collected.workspacePath,
        outputPath: collected.outputPath,
        systemBranch: '',
        gitContext: null,
        phase: 'intake' as PhaseName,
        iteration: { bugfix: 0 },
        epics: [],
        techStack: [],
        userStories: [],
        tasks: [],
        assignments: [],
        completedAssignmentIds: [],
        fileChanges: [],
        testPlan: null,
        testReports: [],
        bugs: [],
        fixedBugIds: [],
        pullRequests: [],
        approvals: [],
        artifacts: [],
        transcript: [],
        tokenUsage: [],
        verificationErrors: [],
        dispatchRounds: [],
        attemptedBugIds: [],
        bugAttempts: {},
        planViolations: [],
        completionEvidence: [],
        salvageBranches: [],
        phantomFileChanges: [],
        qaClaimDiscrepancies: [],
        invariantViolations: [],
        codebaseAnalysis: null,
        architecture: null,
        repoContract: null,
        dbDesign: null,
        devopsPlan: null,
        runningContainers: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        acceptance: null,
        latestGateReport: null,
        unrecoverable: null,
        e2eStatus: 'not-run',
        e2eSkipReason: null,
        e2eEvidence: null,
    };

    rehydrateSecrets(state, warnings);

    const resumePhase = resolveResumePhaseFromLedger(
        collected.ledgerEntries,
        state,
        warnings,
    );

    log.info(`Reconstructed state from ledger only (confidence=minimal, resumePhase=${resumePhase})`);
    return { state, resumePhase, confidence: 'minimal', warnings };
}

// ─── Secret Rehydration ─────────────────────────────────────────────────────

const REDACTED_SENTINEL = '***REDACTED***';

/**
 * Restore secrets that were redacted when state.json was written.
 *
 * The token resolution follows the same priority as intakeNode:
 *   1. GITHUB_PROJECT_TOKEN (project-specific PAT)
 *   2. GITHUB_TOKEN (global PAT)
 *
 * Owner/repo are preserved from the original state when present, falling
 * back to env vars only when the state value was redacted or absent.
 */
function rehydrateSecrets(state: Record<string, any>, warnings: string[]): void {
    const gitContext = state.gitContext;
    if (!gitContext) {
        // No git context — try to create one from env vars
        const token = GITHUB_PROJECT_TOKEN || GITHUB_TOKEN;
        if (token) {
            state.gitContext = {
                token,
                owner: GITHUB_PROJECT_OWNER || GITHUB_OWNER,
                repo: GITHUB_REPO,
                defaultBranch: GIT_DEFAULT_BRANCH,
            };
            log.info('Created gitContext from environment variables');
        } else {
            warnings.push('No git context and no GITHUB_TOKEN in environment — git operations will fail');
        }
        return;
    }

    // Rehydrate the token
    if (!gitContext.token || gitContext.token === REDACTED_SENTINEL) {
        const token = GITHUB_PROJECT_TOKEN || GITHUB_TOKEN;
        if (token) {
            gitContext.token = token;
            log.info('Rehydrated gitContext.token from environment');
        } else {
            warnings.push(
                'gitContext.token was redacted and no GITHUB_TOKEN or GITHUB_PROJECT_TOKEN ' +
                'found in environment — git push/PR operations will fail',
            );
            gitContext.token = '';
        }
    }

    // Owner and repo are not sensitive but may need fallback
    if (!gitContext.owner) {
        gitContext.owner = GITHUB_PROJECT_OWNER || GITHUB_OWNER;
    }
    if (!gitContext.repo) {
        gitContext.repo = GITHUB_REPO;
    }
    if (!gitContext.defaultBranch) {
        gitContext.defaultBranch = GIT_DEFAULT_BRANCH;
    }

    // Walk the entire state tree and replace any remaining redacted sentinels
    // in nested objects (e.g. input.repoTarget, approval tokens)
    deepRehydrate(state, warnings);
}

/**
 * Walk the state tree and warn about any remaining '***REDACTED***' values.
 * We don't have generic env-var mapping for arbitrary nested secrets,
 * so we just log them as warnings.
 */
function deepRehydrate(obj: any, warnings: string[], path: string[] = []): void {
    if (obj === null || obj === undefined || typeof obj !== 'object') return;

    for (const [key, value] of Object.entries(obj)) {
        if (value === REDACTED_SENTINEL) {
            const fieldPath = [...path, key].join('.');
            // gitContext.token is handled above — skip it here
            if (fieldPath === 'gitContext.token') continue;
            warnings.push(
                `Redacted value at "${fieldPath}" could not be rehydrated — ` +
                `ensure the corresponding environment variable is set`,
            );
        } else if (typeof value === 'object' && value !== null) {
            deepRehydrate(value, warnings, [...path, key]);
        }
    }
}

// ─── Field Validation ───────────────────────────────────────────────────────

/**
 * Best-effort validation of key state fields. We don't fail on invalid
 * fields — just log warnings so the user knows the state may be degraded.
 */
function validateStateFields(state: Record<string, any>, warnings: string[]): void {
    // Ensure arrays are actually arrays
    const arrayFields = [
        'epics', 'techStack', 'userStories', 'tasks', 'assignments',
        'completedAssignmentIds', 'fileChanges', 'testReports', 'bugs',
        'fixedBugIds', 'pullRequests', 'approvals',
        'artifacts', 'transcript', 'tokenUsage', 'verificationErrors',
        'dispatchRounds', 'attemptedBugIds',
        'planViolations', 'completionEvidence', 'salvageBranches',
        'phantomFileChanges', 'qaClaimDiscrepancies', 'invariantViolations',
        'runningContainers',
    ];

    for (const field of arrayFields) {
        if (state[field] !== undefined && !Array.isArray(state[field])) {
            warnings.push(`Field "${field}" is not an array — resetting to []`);
            state[field] = [];
        }
    }

    // Ensure objects are objects
    const objectFields = [
        'input', 'iteration', 'phaseFeedback', 'bugAttempts',
    ];
    for (const field of objectFields) {
        if (state[field] !== undefined && (typeof state[field] !== 'object' || state[field] === null)) {
            warnings.push(`Field "${field}" is not an object — resetting to default`);
            if (field === 'input') {
                state[field] = { systemName: '', requirementsText: '', mode: 'autonomous', runType: 'greenfield' };
            } else if (field === 'iteration') {
                state[field] = { bugfix: 0 };
            } else {
                state[field] = {};
            }
        }
    }

    // Ensure phase is a valid PhaseName
    if (state.phase && !PHASE_INDEX.has(state.phase)) {
        warnings.push(`Invalid phase "${state.phase}" — resetting to "intake"`);
        state.phase = 'intake';
    }

    // Ensure iteration.bugfix is a number
    if (state.iteration && typeof state.iteration.bugfix !== 'number') {
        warnings.push('iteration.bugfix is not a number — resetting to 0');
        state.iteration.bugfix = 0;
    }

    // Ensure cancelled is boolean
    if (typeof state.cancelled !== 'boolean') {
        state.cancelled = false;
    }

    // Ensure e2eStatus is valid
    const validE2eStatuses = ['not-run', 'passed', 'failed', 'skipped-no-services', 'skipped-disabled', 'error'];
    if (state.e2eStatus && !validE2eStatuses.includes(state.e2eStatus)) {
        warnings.push(`Invalid e2eStatus "${state.e2eStatus}" — resetting to "not-run"`);
        state.e2eStatus = 'not-run';
    }
}

// ─── Phase Resolution ───────────────────────────────────────────────────────

/**
 * Determine which phase to resume from based on state evidence.
 *
 * Algorithm:
 * 1. Read state.phase — the phase active when the run stopped
 * 2. Cross-validate with ledger phase start/end events
 * 3. Check state contents for evidence of completion
 * 4. Resume from the FIRST phase whose evidence is incomplete
 *
 * Special cases:
 * - If crashed during development, check which assignments completed
 * - If crashed during QA, re-run QA (depends on current code state)
 * - If in a bugfix loop, resume from bugfix-triage
 * - finalize is always re-run (writes final reports)
 */
function resolveResumePhase(
    state: Record<string, any>,
    collected: CollectedRunState,
    warnings: string[],
): PhaseName {
    const activePhase = state.phase as PhaseName;
    const runType = state.input?.runType ?? 'greenfield';
    const completedPhases = getCompletedPhases(collected.ledgerEntries);

    log.info(`Active phase at crash: ${activePhase}`);
    log.info(`Completed phases from ledger: [${[...completedPhases].join(', ')}]`);

    // finalize is complete → run was actually finished, nothing to resume
    if (completedPhases.has('finalize')) {
        warnings.push('Run appears to be completed (finalize phase finished). Re-running finalize.');
        return 'finalize';
    }

    // Walk through phases in order and find the first incomplete one
    for (const phase of PHASE_ORDER) {
        // Skip codebase-analyzer for greenfield runs
        if (phase === 'codebase-analyzer' && runType !== 'maintain') {
            continue;
        }

        // intake is always skipped on continue (workspace already exists)
        if (phase === 'intake') {
            if (!state.workspacePath || !state.outputPath) {
                warnings.push('Critical: intake did not complete — workspacePath or outputPath missing');
                return 'intake';
            }
            continue;
        }

        if (isPhaseComplete(phase, state, completedPhases, runType)) {
            continue;
        }

        // This phase is incomplete — resume from here
        log.info(`Resuming from phase: ${phase} (incomplete)`);

        // Special handling for development phase
        if (phase === 'development') {
            const pendingCount = countPendingAssignments(state);
            if (pendingCount === 0 && (state.pullRequests?.length ?? 0) > 0) {
                // All assignments completed but development phase didn't finish cleanly
                log.info('All assignments appear completed — advancing past development');
                continue;
            }
            if (pendingCount > 0) {
                log.info(`${pendingCount} pending assignments remaining`);
            }
        }

        return phase;
    }

    // All phases complete — re-run finalize
    warnings.push('All phases appear complete — re-running finalize');
    return 'finalize';
}

/**
 * Determine the resume phase using only ledger entries (for degraded mode).
 */
function resolveResumePhaseFromLedger(
    ledgerEntries: LedgerEntry[],
    state: Record<string, any>,
    warnings: string[],
): PhaseName {
    const completedPhases = getCompletedPhases(ledgerEntries);

    if (completedPhases.size === 0) {
        warnings.push('No completed phases found in ledger — resuming from intake');
        return 'intake';
    }

    const runType = state.input?.runType ?? 'greenfield';

    // Find the first incomplete phase
    for (const phase of PHASE_ORDER) {
        if (phase === 'codebase-analyzer' && runType !== 'maintain') continue;
        if (phase === 'intake') continue; // always skip
        if (completedPhases.has(phase)) continue;
        return phase;
    }

    return 'finalize';
}

/**
 * Extract the set of completed phases from ledger entries.
 *
 * A phase is complete when it has a `kind='phase'` entry with `event='end'`.
 */
function getCompletedPhases(ledgerEntries: LedgerEntry[]): Set<PhaseName> {
    const completed = new Set<PhaseName>();
    for (const entry of ledgerEntries) {
        if (entry.kind === 'phase' && entry.event === 'end') {
            completed.add(entry.phase);
        }
    }
    return completed;
}

/**
 * Check whether a phase has evidence of successful completion in the state.
 *
 * This is a cross-validation against ledger data — both must agree for
 * a phase to be considered complete.
 */
function isPhaseComplete(
    phase: PhaseName,
    state: Record<string, any>,
    completedPhases: Set<PhaseName>,
    runType: string,
): boolean {
    // If the ledger says the phase completed, check state evidence too
    const ledgerComplete = completedPhases.has(phase);

    switch (phase) {
        case 'intake':
            return !!(state.workspacePath && state.outputPath);

        case 'codebase-analyzer':
            if (runType !== 'maintain') return true; // not applicable
            return ledgerComplete && state.codebaseAnalysis != null;

        case 'architect':
            return ledgerComplete && state.architecture != null && (state.epics?.length ?? 0) > 0;

        case 'product-manager':
            return ledgerComplete && (state.userStories?.length ?? 0) > 0 && (state.tasks?.length ?? 0) > 0;

        case 'dba':
            // DBA may legitimately produce null dbDesign if the project needs no DB
            return ledgerComplete;

        case 'team-leader':
            return ledgerComplete && (state.assignments?.length ?? 0) > 0;

        case 'development':
            // Development is complete if ledger says so AND we have file changes or PRs
            return ledgerComplete && (
                (state.fileChanges?.length ?? 0) > 0 ||
                (state.pullRequests?.length ?? 0) > 0
            );

        case 'qa':
            // QA should be re-run even if ledger says complete (depends on code state)
            // But if we're past it in the pipeline, honor that
            return ledgerComplete && (state.testReports?.length ?? 0) > 0;

        case 'bugfix-triage':
            // Bugfix triage is iterative — check the iteration context
            return ledgerComplete;

        case 'devops':
            return ledgerComplete && state.devopsPlan != null;

        case 'e2e':
            // E2E should be re-run (depends on running containers)
            return ledgerComplete && state.e2eStatus !== 'not-run';

        case 'acceptance-gate':
            return ledgerComplete && state.acceptance != null;

        case 'finalize':
            // Always re-run finalize
            return false;

        default:
            return ledgerComplete;
    }
}

/**
 * Count assignments that haven't been completed yet.
 * Uses the same logic as `selectPendingAssignments` from assignment-policy.ts.
 */
function countPendingAssignments(state: Record<string, any>): number {
    const assignments: Array<{ id: string }> = state.assignments ?? [];
    const completedIds = new Set<string>(state.completedAssignmentIds ?? []);

    const seen = new Set<string>();
    let pending = 0;
    for (const a of assignments) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (!completedIds.has(a.id)) pending++;
    }
    return pending;
}

// ─── Git Helpers ────────────────────────────────────────────────────────────

/**
 * Detect the system branch (project/<slug>) from git branches.
 *
 * Looks for branches matching the `project/` prefix in the workspace.
 */
function detectSystemBranch(collected: CollectedRunState): string {
    // Check current branch first
    if (collected.workspacePath) {
        const currentBranch = gitExec(collected.workspacePath, 'rev-parse --abbrev-ref HEAD');
        if (!currentBranch.startsWith('Error:') && currentBranch.startsWith('project/')) {
            return currentBranch;
        }
    }

    // Scan local branches for project/* pattern
    for (const branch of collected.gitBranches.local) {
        if (branch.startsWith('project/')) {
            return branch;
        }
    }

    return '';
}
