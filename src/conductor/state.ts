/**
 * LangGraph shared Project State — the single source of truth for a run.
 *
 * All agents read from and write to this state. Reducers define how
 * updates are merged: arrays append, scalars/objects replace.
 */
import { Annotation } from '@langchain/langgraph';
import type {
    RunInput,
    PhaseName,
    ArchitectureDoc,
    TechDecision,
    Epic,
    UserStory,
    Task,
    Assignment,
    FileChange,
    DbDesign,
    TestPlan,
    TestReport,
    Bug,
    DevOpsPlan,
    Approval,
    ArtifactRef,
    TranscriptMessage,
    CodebaseAnalysis,
    PullRequest,
    BranchAssignment,
    TokenCallRecord,
    GitContext,
} from '../agents/_shared/base-schemas';
import type { RepoContract } from '../agents/_shared/schemas/repo-contract.schema';
// TechDecision is already imported above via base-schemas — mergeByLayerReducer uses it.
import type { ConfigBaseline } from './gate-integrity';
import type { AcceptanceReport, DispatchRound } from './acceptance-gate';
import type { GateReport } from './quality-gates';
import type { CompletionEvidence } from './assignment-policy';

// ─── Reducers ───────────────────────────────────────────────────────────────

/** Append-only reducer for arrays. */
function appendReducer<T>(existing: T[], incoming: T[]): T[] {
    return existing.concat(incoming);
}

/** Replace reducer (last-write wins). */
function replaceReducer<T>(existing: T, incoming: T): T {
    return incoming;
}

/** Replace elements with the same `id`, append new ones. Prevents HITL re-runs from duplicating a plan. */
function mergeByIdReducer<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
    const map = new Map<string, T>();
    for (const item of existing) map.set(item.id, item);
    for (const item of incoming) map.set(item.id, item);
    return [...map.values()];
}

/** Merge reducer for tech stack (keyed on layer+technology, no `id`). */
function mergeByLayerReducer(existing: TechDecision[], incoming: TechDecision[]): TechDecision[] {
    const map = new Map<string, TechDecision>();
    for (const item of existing) map.set(`${item.layer}:${item.choice}`, item);
    for (const item of incoming) map.set(`${item.layer}:${item.choice}`, item);
    return [...map.values()];
}

/** Merge reducer for bug attempt counts — takes the max of each key. */
function bugAttemptsReducer(
    existing: Record<string, number>,
    incoming: Record<string, number>,
): Record<string, number> {
    const merged = { ...existing };
    for (const [key, count] of Object.entries(incoming)) {
        merged[key] = Math.max(merged[key] ?? 0, count);
    }
    return merged;
}

// ─── State Definition ───────────────────────────────────────────────────────

export const ProjectState = Annotation.Root({
    // ── Run input (set once at start) ────────────────────────────────────
    input: Annotation<RunInput>({
        reducer: replaceReducer,
        default: () => ({
            systemName: '',
            requirementsText: '',
            mode: 'human' as const,
            runType: 'greenfield' as const,
        }),
    }),

    // ── Workspace paths (set once at start) ──────────────────────────────
    workspacePath: Annotation<string>({
        reducer: replaceReducer,
        default: () => '',
    }),
    outputPath: Annotation<string>({
        reducer: replaceReducer,
        default: () => '',
    }),

    // ── System branch (project/<system-name>) ────────────────────────────
    systemBranch: Annotation<string>({
        reducer: replaceReducer,
        default: () => '',
    }),

    // ── Git context (multi-repo targeting) ───────────────────────────────
    gitContext: Annotation<GitContext | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Codebase analysis (maintain mode only) ───────────────────────────
    codebaseAnalysis: Annotation<CodebaseAnalysis | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Architect outputs ────────────────────────────────────────────────
    architecture: Annotation<ArchitectureDoc | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Repo Contract (Sub-Plan 05) ──────────────────────────────────────
    repoContract: Annotation<RepoContract | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    epics: Annotation<Epic[]>({
        reducer: mergeByIdReducer,
        default: () => [],
    }),
    techStack: Annotation<TechDecision[]>({
        reducer: mergeByLayerReducer,
        default: () => [],
    }),

    // ── DBA output ───────────────────────────────────────────────────────
    dbDesign: Annotation<DbDesign | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Product Manager outputs ──────────────────────────────────────────
    userStories: Annotation<UserStory[]>({
        reducer: mergeByIdReducer,
        default: () => [],
    }),
    tasks: Annotation<Task[]>({
        reducer: mergeByIdReducer,
        default: () => [],
    }),

    // ── Team Leader outputs ──────────────────────────────────────────────
    assignments: Annotation<Assignment[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Completed assignment ids (prevents bug-fix loop re-runs) ──────────
    completedAssignmentIds: Annotation<string[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Developer outputs ────────────────────────────────────────────────
    fileChanges: Annotation<FileChange[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── QA outputs ───────────────────────────────────────────────────────
    testPlan: Annotation<TestPlan | null>({
        reducer: replaceReducer,
        default: () => null,
    }),
    testReports: Annotation<TestReport[]>({
        reducer: appendReducer,
        default: () => [],
    }),
    bugs: Annotation<Bug[]>({
        reducer: appendReducer,
        default: () => [],
    }),
    fixedBugIds: Annotation<string[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── DevOps outputs ───────────────────────────────────────────────────
    devopsPlan: Annotation<DevOpsPlan | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Running containers (for teardown in finalize) ────────────────────
    runningContainers: Annotation<string[]>({
        reducer: replaceReducer,
        default: () => [],
    }),

    // ── PR & branching ────────────────────────────────────────────────────
    pullRequests: Annotation<PullRequest[]>({
        reducer: appendReducer,
        default: () => [],
    }),
    branchAssignments: Annotation<BranchAssignment[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Orchestration metadata ───────────────────────────────────────────
    phase: Annotation<PhaseName>({
        reducer: replaceReducer,
        default: () => 'intake' as PhaseName,
    }),
    iteration: Annotation<{ bugfix: number }>({
        reducer: replaceReducer,
        default: () => ({ bugfix: 0 }),
    }),

    // ── HITL approvals ───────────────────────────────────────────────────
    approvals: Annotation<Approval[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── HITL re-run support ──────────────────────────────────────────────

    /** When set, the named phase will re-run itself once (cleared by the node at re-entry). */
    pendingRerun: Annotation<PhaseName | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    /** Accumulated user feedback per phase. Entries concatenate across enhance rounds. */
    phaseFeedback: Annotation<Record<string, string[]>>({
        reducer: (existing: Record<string, string[]>, incoming: Record<string, string[]>) => {
            const merged = { ...existing };
            for (const [key, values] of Object.entries(incoming)) {
                merged[key] = (merged[key] ?? []).concat(values);
            }
            return merged;
        },
        default: () => ({}),
    }),

    /** Set to true when a HITL deny is issued, so the graph routes to finalize. */
    cancelled: Annotation<boolean>({
        reducer: replaceReducer,
        default: () => false,
    }),

    // ── Agent artifacts (markdown mission reports) ───────────────────────
    artifacts: Annotation<ArtifactRef[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Transcript (human-readable event log) ────────────────────────────
    transcript: Annotation<TranscriptMessage[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Token usage tracking ─────────────────────────────────────────────
    tokenUsage: Annotation<TokenCallRecord[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Config baseline (gate integrity, Sub-Plan 02) ────────────────────
    configBaseline: Annotation<ConfigBaseline | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Acceptance gate (Sub-Plan 03) ────────────────────────────────────

    /** Latest acceptance gate result (replace reducer — always the freshest). */
    acceptance: Annotation<AcceptanceReport | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    /** Latest quality gate report (replace reducer — unambiguous "current" signal). */
    latestGateReport: Annotation<GateReport | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    /** True when no further pipeline work can change the outcome. */
    unrecoverable: Annotation<{ flag: boolean; reason: string } | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    /** Verification stage crashes — so acceptance gate marks criteria inconclusive, not green. */
    verificationErrors: Annotation<Array<{ stage: string; message: string }>>({
        reducer: appendReducer,
        default: () => [],
    }),

    /** Per-dispatch-round progress counters (append reducer). */
    dispatchRounds: Annotation<DispatchRound[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    /** Bug ids that triage has sent to development (informational — actual fix verified later). */
    attemptedBugIds: Annotation<string[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    /** Per-bug attempt count: how many times triage has dispatched a fix for each bug id. */
    bugAttempts: Annotation<Record<string, number>>({
        reducer: bugAttemptsReducer,
        default: () => ({}),
    }),

    // ── Planning integrity (Sub-Plan 04) ─────────────────────────────────

    /** Output integrity issues from agent invocations (truncation, lossy repair, invalid schema). */
    outputIntegrity: Annotation<Array<{ agent: string; phase: PhaseName; issue: 'truncated' | 'repair-lossy' | 'schema-invalid'; detail: string }>>({
        reducer: appendReducer,
        default: () => [],
    }),

    /** Planning coverage violations detected between PM and TL phases. */
    planViolations: Annotation<Array<{ kind: string; severity: string; id: string; detail: string }>>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── PR Workflow / Work Preservation (Sub-Plan 06) ─────────────────────

    /** Evidence that each assignment was completed with real file changes. */
    completionEvidence: Annotation<CompletionEvidence[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    /** Branches salvaged (failed to merge but patches exported). */
    salvageBranches: Annotation<string[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Agent Budgets & File Reconciliation (Sub-Plan 08) ─────────────────

    /** Phantom file changes: claimed by agents but not found on disk. */
    phantomFileChanges: Annotation<FileChange[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── QA Real Execution (Sub-Plan 09) ──────────────────────────────────

    /** Discrepancies between QA agent's self-report and the real runner output. */
    qaClaimDiscrepancies: Annotation<Array<{ field: string; claimed: number | string; actual: number | string }>>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── DevOps & E2E Hardening (Sub-Plan 11) ──────────────────────────────

    /** Terminal E2E outcome. 'not-run' is the initial value and must never be conflated with 'passed'. */
    e2eStatus: Annotation<'not-run' | 'passed' | 'failed' | 'skipped-no-services' | 'skipped-disabled' | 'error'>({
        reducer: replaceReducer,
        default: () => 'not-run',
    }),

    /** Human-readable reason when E2E is skipped or errors out. */
    e2eSkipReason: Annotation<string | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    /** E2E evidence from Playwright or smoke test: screenshots, console errors, visited URLs. */
    e2eEvidence: Annotation<{ screenshots: string[]; consoleErrors: string[]; urlsVisited: string[] } | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Observability (Sub-Plan 12) ──────────────────────────────────────

    /** Run invariant violations detected at phase boundaries. */
    invariantViolations: Annotation<Array<{ id: string; phase: string; detail: string }>>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Continue Run (Plan 23, Sub-Plan 04) ──────────────────────────────

    /** When true, this is a continuation of a previously stopped run. Nodes
     *  before `_resumePhase` skip execution (idempotency guard). */
    _isContinuation: Annotation<boolean>({
        reducer: replaceReducer,
        default: () => false,
    }),

    /** The phase to resume from on a continuation run. Set by `continueRun()`
     *  based on the Phase Resolver result. Null for normal (non-continuation) runs. */
    _resumePhase: Annotation<PhaseName | null>({
        reducer: replaceReducer,
        default: () => null,
    }),
});

/** TypeScript type for the full Project State. */
export type ProjectStateType = typeof ProjectState.State;
