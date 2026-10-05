/**
 * Shared type definitions for gates, acceptance reports, and dispatch rounds.
 *
 * Extracted to break the circular type dependency:
 *   state.ts -> acceptance-gate.ts -> state.ts
 *
 * These types are used by both state.ts (channel declarations) and
 * acceptance-gate.ts (implementation), so they must live in a module
 * that neither imports.
 *
 * Sub-Plan 25-10: Added unified Gate abstraction types — GateStatus,
 * GateFinding, GateOutcome, and WorkspaceIndex.
 */

import type { Bug } from '../agents/_shared/schemas/bug.schema';

// ─── Unified Gate Abstraction (Sub-Plan 25-10) ─────────────────────────────

/** Standard gate outcome status — all gates must use one of these. */
export type GateStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped';

/** Severity for gate findings — shared across all gate modules. */
export type FindingSeverity = 'critical' | 'major' | 'minor';

/** A single finding from any gate. */
export interface GateFinding {
    /** Stable id for de-duplication across bug-fix iterations. */
    id: string;
    severity: FindingSeverity;
    /** Human-readable detail. */
    detail: string;
    /** Optional file path relative to workspace. */
    file?: string;
    /** Optional line number. */
    line?: number;
}

/**
 * Standard gate outcome — all gate modules produce this via toGateOutcome().
 *
 * Callers can use `outcome.status` for uniform pass/fail/inconclusive logic,
 * or access `outcome.detail` for the gate-specific result type.
 */
export interface GateOutcome<R = unknown> {
    /** Gate identifier (e.g. 'quality-gates', 'security-gates'). */
    gate: string;
    status: GateStatus;
    /** Structured findings (each gate maps its native findings to this shape). */
    findings: GateFinding[];
    /** Original gate-specific result for callers that need detailed data. */
    detail: R;
    /** Pre-rendered markdown summary. */
    markdown: string;
    /** Synthesised bugs for bugfix triage. */
    bugs: Bug[];
}

/** Pre-built workspace file index — constructed once, passed to all gates. */
export interface WorkspaceIndex {
    /** Workspace root absolute path. */
    workspacePath: string;
    /** All files in the workspace (relative paths from workspace root). */
    allFiles: string[];
    /** Source files only (narrow: .ts, .tsx, .js, .jsx, .mjs, .cjs, .vue, .svelte). */
    sourceFiles: string[];
    /** Test files only (matching test/spec patterns). */
    testFiles: string[];
    /** Product source files (non-test source files). */
    productSourceFiles: string[];
    /** Files grouped by extension (key = extension with dot, e.g. '.ts'). */
    byExt: Map<string, string[]>;
}

// ─── Acceptance Types ───────────────────────────────────────────────────────

export type AcceptanceStatus = 'accepted' | 'partial' | 'rejected' | 'inconclusive';

export interface AcceptanceCriterionResult {
    /** Criterion identifier. */
    id: string;
    label: string;
    required: boolean;
    passed: boolean;
    inconclusive: boolean;
    /** One-line detail, quotable in a report. */
    detail: string;
}

export interface AcceptanceReport {
    status: AcceptanceStatus;
    criteria: AcceptanceCriterionResult[];
    /** Ordered, human-readable list of what must be fixed. Goes in the manifest and the final log. */
    blockers: string[];
    /** True when no further pipeline work can plausibly change the outcome. */
    unrecoverable: boolean;
    unrecoverableReason?: string;
}

export interface DispatchRound {
    /** File changes claimed this round, merged or not — not a progress signal (Plan 30-05). */
    fileChanges: number;
    /** PRs merged this round — the progress signal. `PR-SKIPPED-*` placeholders (status `closed`,
     *  prNumber 0) are recorded for every no-commit branch and never count. Plan 30-05: was `prs`. */
    merged: number;
    /** Assignments whose agent ran for the first time this round (Plan 30-05). */
    executed: number;
    /** Assignments a branch budget left for the next round (Plan 30-05): work in flight, not a stall. */
    deferred: number;
    completed: number;
}

/** One bug-fix triage round (Plan 30-05). */
export interface TriageRound {
    iteration: number;
    /** `state.bugs.length` when triage ran: the bugs after it are what the next evaluation raised. */
    bugCursor: number;
    /** The bugs handed to the Team Leader (`selectTriageBugs`). */
    bugIds: string[];
}
