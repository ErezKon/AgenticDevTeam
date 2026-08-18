/**
 * Shared type definitions for gates, acceptance reports, and dispatch rounds.
 *
 * Extracted to break the circular type dependency:
 *   state.ts -> acceptance-gate.ts -> state.ts
 *
 * These types are used by both state.ts (channel declarations) and
 * acceptance-gate.ts (implementation), so they must live in a module
 * that neither imports.
 */

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
    fileChanges: number;
    /** **Merged** PRs only. `PR-SKIPPED-*` placeholders (status `closed`, prNumber 0)
     *  are recorded for every no-commit branch and must never count as progress. */
    prs: number;
    completed: number;
}
