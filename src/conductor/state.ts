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
} from '../agents/_shared/base-schemas';

// ─── Reducers ───────────────────────────────────────────────────────────────

/** Append-only reducer for arrays. */
function appendReducer<T>(existing: T[], incoming: T[]): T[] {
    return existing.concat(incoming);
}

/** Replace reducer (last-write wins). */
function replaceReducer<T>(existing: T, incoming: T): T {
    return incoming;
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
    epics: Annotation<Epic[]>({
        reducer: appendReducer,
        default: () => [],
    }),
    techStack: Annotation<TechDecision[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── DBA output ───────────────────────────────────────────────────────
    dbDesign: Annotation<DbDesign | null>({
        reducer: replaceReducer,
        default: () => null,
    }),

    // ── Product Manager outputs ──────────────────────────────────────────
    userStories: Annotation<UserStory[]>({
        reducer: appendReducer,
        default: () => [],
    }),
    tasks: Annotation<Task[]>({
        reducer: appendReducer,
        default: () => [],
    }),

    // ── Team Leader outputs ──────────────────────────────────────────────
    assignments: Annotation<Assignment[]>({
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

    // ── DevOps outputs ───────────────────────────────────────────────────
    devops: Annotation<DevOpsPlan | null>({
        reducer: replaceReducer,
        default: () => null,
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
});

/** TypeScript type for the full Project State. */
export type ProjectStateType = typeof ProjectState.State;
