/**
 * Review-loop policy helpers (Sub-Plan 07 rewrite).
 *
 * Pure functions extracted from pr-workflow.ts so they can be unit-tested
 * without pulling in the full workflow machinery.
 *
 * Sub-Plan 07 changes:
 *   - ReviewOutcome type replaces coercing every failure into ReviewOutput.
 *   - Abstentions never count toward the approval quorum.
 *   - decideMerge() uses evidence, not a timer, for the terminal merge/block decision.
 *   - selectEscalationCandidate() always returns a candidate (cross-domain fallback).
 *   - Unknown severity treated as blocking (inverts the old 'info' default).
 */
import type { ReviewOutput } from '../agents/developers/schemas/review-output.schema';
import type { GateReport } from './quality-gates';
import type { TamperFinding } from './gate-integrity';
import { DEV_AGENTS, getDevAgent } from '../agents/developers/registry';

// ─── Review Outcomes ────────────────────────────────────────────────────────

export type ReviewOutcome =
    | { kind: 'approved';           reviewerId: string; output: ReviewOutput }
    | { kind: 'changes_requested';  reviewerId: string; output: ReviewOutput }
    | { kind: 'abstained';          reviewerId: string; reason: AbstainReason; detail: string };

export type AbstainReason = 'recursion-limit' | 'empty-output' | 'schema-invalid' | 'error';

// ─── Blocking severity check ─────────────────────────────────────────────────

/**
 * Only critical/major findings justify another dev+review round trip.
 * Cosmetic comments are still recorded and posted to the PR — they just
 * do not block the merge.
 *
 * Sub-Plan 07: unknown/missing severity is now treated as **blocking** ('major'),
 * not as non-blocking ('info'). This inverts the old default that allowed
 * un-labelled garbage to count as approval.
 */
const BLOCKING_SEVERITIES = new Set(['critical', 'major']);

/**
 * Return `true` if any comment in the array has a blocking severity.
 *
 * A missing or empty severity is treated as blocking (assumes `'major'`).
 */
export function isBlockingReview(comments: { severity?: string }[]): boolean {
    return comments.some(c => {
        const sev = String(c.severity ?? '').toLowerCase();
        // Missing/empty → blocking. Known non-blocking values are explicit.
        if (!sev || sev === '') return true;
        if (sev === 'minor' || sev === 'suggestion' || sev === 'info') return false;
        return BLOCKING_SEVERITIES.has(sev) || true; // unknown → blocking
    });
}

// ─── Quorum evaluation ──────────────────────────────────────────────────────

export interface QuorumResult {
    approvals: number;
    abstentions: number;
    rejections: number;
    met: boolean;
    allAbstained: boolean;
}

/**
 * Evaluate review outcomes against the quorum requirement.
 * Abstentions do NOT count toward the quorum.
 */
export function evaluateQuorum(outcomes: ReviewOutcome[], quorum: number): QuorumResult {
    let approvals = 0;
    let abstentions = 0;
    let rejections = 0;
    for (const o of outcomes) {
        if (o.kind === 'approved') approvals++;
        else if (o.kind === 'abstained') abstentions++;
        else rejections++;
    }
    return {
        approvals,
        abstentions,
        rejections,
        met: approvals >= quorum && rejections === 0,
        allAbstained: outcomes.length > 0 && abstentions === outcomes.length,
    };
}

// ─── Merge decision ─────────────────────────────────────────────────────────

export interface MergeDecision {
    merge: boolean;
    reason: string;
    /** Hard blockers that must be resolved by a human or a later iteration. */
    blockers: string[];
}

export interface LayoutViolation {
    kind: string;
    severity: 'critical' | 'major' | 'minor';
    path: string;
    detail: string;
}

export interface DecideMergeInput {
    approvals: number;
    blockingComments: { severity?: string; body?: string; filePath?: string }[];
    abstentions: number;
    gateReport: GateReport | null;
    integrityFindings: TamperFinding[];
    layoutViolations: LayoutViolation[];
    filesChanged: number;
    iterationsUsed: number;
    policy: 'strict' | 'permissive' | 'legacy';
    quorum: number;
    /** Number of unmet criteriaVerdicts from all reviewers. */
    unmetCriteriaCount: number;
}

/**
 * Evidence-based merge decision.
 *
 * Under `strict` (the new default), **no timer overrides any hard blocker**.
 * Under `permissive`, only hard integrity/gate blockers (1-4) prevent merge.
 * Under `legacy`, the pre-Plan-19 behaviour: merge anything that isn't secrets-blocked.
 */
export function decideMerge(input: DecideMergeInput): MergeDecision {
    const blockers: string[] = [];

    if (input.policy === 'legacy') {
        return { merge: true, reason: 'legacy policy — merge unconditionally', blockers: [] };
    }

    // 1. Gate must pass
    if (input.gateReport && !input.gateReport.passed) {
        blockers.push(`Quality gates not passed (${input.gateReport.results?.filter((r: any) => !r.passed && !r.skipped).length ?? '?'} failures)`);
    }

    // 2. Product verification
    if (input.gateReport?.productVerify && !input.gateReport.productVerify.passed) {
        blockers.push(`Product verification failed: ${input.gateReport.productVerify.summary ?? 'unknown'}`);
    }

    // 3. Critical integrity findings
    const criticalTamper = input.integrityFindings.filter(f => f.severity === 'critical');
    if (criticalTamper.length > 0) {
        blockers.push(`${criticalTamper.length} critical integrity finding(s): ${criticalTamper.map(f => f.detail).join('; ').slice(0, 200)}`);
    }

    // 4. Critical layout violations
    const criticalLayout = input.layoutViolations.filter(v => v.severity === 'critical');
    if (criticalLayout.length > 0) {
        blockers.push(`${criticalLayout.length} critical layout violation(s): ${criticalLayout.map(v => v.detail).join('; ').slice(0, 200)}`);
    }

    // Blockers 1-4 are hard under both strict and permissive
    if (input.policy === 'permissive' && blockers.length === 0) {
        return { merge: true, reason: 'permissive policy — hard blockers clear', blockers: [] };
    }

    // Blockers 5-7 are strict-only
    if (input.policy === 'strict') {
        // 5. Unresolved critical review comments
        const criticalComments = input.blockingComments.filter(
            c => String(c.severity ?? '').toLowerCase() === 'critical',
        );
        if (criticalComments.length > 0) {
            blockers.push(`${criticalComments.length} unresolved critical review comment(s)`);
        }

        // 6. Zero file changes
        if (input.filesChanged === 0) {
            blockers.push('No files were changed (empty PR)');
        }

        // 7. Quorum not met
        if (input.approvals < input.quorum) {
            blockers.push(`Quorum not met: ${input.approvals}/${input.quorum} approvals (${input.abstentions} abstention(s))`);
        }
    }

    if (blockers.length > 0) {
        return { merge: false, reason: blockers.join(' | '), blockers };
    }
    return { merge: true, reason: 'All evidence checks passed', blockers: [] };
}

// ─── Escalation candidate selection ─────────────────────────────────────────

/**
 * Find a higher-rank agent for escalation. Never returns null for a valid author.
 *
 * Selection rules:
 *   1. Higher rank in the same domain.
 *   2. If no same-domain candidate, cross-domain principal.
 *   3. If author IS the only principal, the other domain's principal.
 *   4. Last resort: the same principal with escalation framing.
 *
 * Guaranteed non-empty for every (rank, domain) pair in the registry.
 */
export function selectEscalationCandidate(
    authorId: string,
    excludeIds: string[],
): string | null {
    const author = getDevAgent(authorId);

    // Plan 24 B1: if the authorId is not a valid dev agent (e.g. 'strong-fixer'),
    // fall back to the first principal dev agent not in excludeIds.
    if (!author) {
        const excludeSet = new Set(excludeIds);
        const fallback = DEV_AGENTS
            .filter(a => !excludeSet.has(a.id) && a.rank === 'principal')
            .sort((a, b) => a.id.localeCompare(b.id));
        if (fallback.length > 0) return fallback[0].id;
        // No principal available — pick any agent not excluded
        const anyAgent = DEV_AGENTS
            .filter(a => !excludeSet.has(a.id))
            .sort((a, b) => a.id.localeCompare(b.id));
        return anyAgent.length > 0 ? anyAgent[0].id : null;
    }

    const rankOrder: Record<string, number> = { junior: 0, senior: 1, principal: 2 };
    const authorRank = rankOrder[author.rank] ?? 0;
    const excludeSet = new Set([...excludeIds, authorId]);

    // Phase 1: same-domain, higher rank
    const sameDomainHigher = DEV_AGENTS
        .filter(a => !excludeSet.has(a.id) && a.domain === author.domain && (rankOrder[a.rank] ?? 0) > authorRank)
        .sort((a, b) => (rankOrder[a.rank] ?? 0) - (rankOrder[b.rank] ?? 0));
    if (sameDomainHigher.length > 0) return sameDomainHigher[0].id;

    // Phase 2: cross-domain principal (not excluded)
    const crossDomainPrincipal = DEV_AGENTS
        .filter(a => !excludeSet.has(a.id) && a.rank === 'principal' && a.domain !== author.domain)
        .sort((a, b) => a.id.localeCompare(b.id));
    if (crossDomainPrincipal.length > 0) return crossDomainPrincipal[0].id;

    // Phase 3: any principal at all (even if excluded by reviewerIds — escalation overrides)
    const anyPrincipal = DEV_AGENTS
        .filter(a => a.id !== authorId && a.rank === 'principal')
        .sort((a, b) => a.id.localeCompare(b.id));
    if (anyPrincipal.length > 0) return anyPrincipal[0].id;

    // Phase 4: same principal with self-escalation (author IS the only principal)
    if (author.rank === 'principal') return authorId;

    // Phase 5: any higher-rank agent regardless of domain
    const anyHigher = DEV_AGENTS
        .filter(a => !excludeSet.has(a.id) && (rankOrder[a.rank] ?? 0) > authorRank)
        .sort((a, b) => (rankOrder[a.rank] ?? 0) - (rankOrder[b.rank] ?? 0));
    if (anyHigher.length > 0) return anyHigher[0].id;

    return null;
}

// ─── Review-comment bug synthesis ───────────────────────────────────────────

/**
 * Convert unresolved major review comments into Bug objects so the bugfix loop
 * picks them up instead of losing them on merge.
 */
export function reviewCommentsToBugs(
    prNumber: number,
    comments: { filePath?: string; body?: string; severity?: string }[],
): Array<{
    id: string;
    title: string;
    severity: string;
    stepsToReproduce: string;
    expectedBehavior: string;
    actualBehavior: string;
    suspectedArea: string;
    reportedBy: string;
}> {
    const majors = comments.filter(c => {
        const s = String(c.severity ?? '').toLowerCase();
        return s === 'major';
    });
    return majors.map((c, i) => ({
        id: `REVIEW-${prNumber}-${i}`,
        title: `Unresolved review comment on ${c.filePath ?? 'unknown file'}`,
        severity: 'major',
        stepsToReproduce: `Review PR #${prNumber}, file ${c.filePath ?? 'unknown'}`,
        expectedBehavior: c.body ?? 'Review comment should be addressed',
        actualBehavior: 'Comment was not resolved before merge',
        suspectedArea: c.filePath ?? 'unknown',
        reportedBy: 'review-policy',
    }));
}

/**
 * Synthesise a critical Bug for a blocked PR so the bugfix loop retries the branch.
 */
export function blockedPrBug(
    branchName: string,
    prNumber: number,
    blockers: string[],
): {
    id: string;
    title: string;
    severity: string;
    stepsToReproduce: string;
    expectedBehavior: string;
    actualBehavior: string;
    suspectedArea: string;
    reportedBy: string;
} {
    return {
        id: `PR-BLOCKED-${branchName}`,
        title: `PR #${prNumber} blocked on ${branchName}`,
        severity: 'critical',
        stepsToReproduce: `Merge PR #${prNumber} on branch ${branchName}`,
        expectedBehavior: 'PR should merge cleanly with all gates passing',
        actualBehavior: `Blocked: ${blockers.join('; ')}`,
        suspectedArea: branchName,
        reportedBy: 'review-policy',
    };
}

// ─── Criteria-verdict enforcement ───────────────────────────────────────────

/**
 * If a reviewer approved but has unmet criteria verdicts, downgrade to changes_requested.
 * If criteriaVerdicts is empty on an assignment with criteria, treat as abstained.
 *
 * Returns the corrected ReviewOutcome.
 */
export function enforceCriteriaVerdicts(
    outcome: ReviewOutcome,
    assignmentHasCriteria: boolean,
): ReviewOutcome {
    if (outcome.kind !== 'approved') return outcome;

    const verdicts = outcome.output.criteriaVerdicts ?? [];

    // Empty verdicts on an assignment with criteria → abstained
    if (assignmentHasCriteria && verdicts.length === 0) {
        return {
            kind: 'abstained',
            reviewerId: outcome.reviewerId,
            reason: 'empty-output',
            detail: 'Reviewer approved without providing criteriaVerdicts for an assignment with acceptance criteria',
        };
    }

    // Any unmet verdict → downgrade to changes_requested
    const unmet = verdicts.filter(v => !v.met);
    if (unmet.length > 0) {
        return {
            kind: 'changes_requested',
            reviewerId: outcome.reviewerId,
            output: {
                ...outcome.output,
                status: 'changes_requested',
            },
        };
    }

    return outcome;
}

// ─── No-progress detection ───────────────────────────────────────────────────

/**
 * Return `true` when the HEAD commit hasn't changed since the last review,
 * meaning reviewers would re-analyse identical code and waste an iteration.
 *
 * A `gitExec` failure (the string starts with `Error`) is never treated as
 * "no progress" — we cannot prove the SHA, so the review must run.
 */
export function shouldSkipReview(prevSha: string, headSha: string): boolean {
    if (!prevSha || !headSha) return false;
    if (headSha.startsWith('Error')) return false;
    return prevSha === headSha;
}

/** Consecutive no-progress iterations tolerated before ending the review loop. */
export const MAX_NO_PROGRESS_ITERATIONS = 2;

export interface ProgressDecision {
    /** Skip the review phase this iteration (nothing new to review). */
    skipReview: boolean;
    /** End the review loop entirely (repeated no-progress). */
    endLoop: boolean;
    /** SHA to carry forward as "last reviewed". */
    lastReviewedSha: string;
    /** Updated consecutive no-progress counter. */
    noProgressCount: number;
}

/**
 * Decide what a review iteration should do based on whether HEAD moved.
 *
 * Kept as a pure function (rather than inline in the review loop) because the
 * order of "compare SHAs" vs. "remember SHA" is easy to get wrong: updating
 * `lastReviewedSha` before the comparison makes every later iteration look
 * like a no-progress iteration and silently disables all re-reviews.
 */
export function evaluateProgress(
    iteration: number,
    headSha: string,
    lastReviewedSha: string,
    noProgressCount: number,
): ProgressDecision {
    if (iteration > 1 && shouldSkipReview(lastReviewedSha, headSha)) {
        const nextCount = noProgressCount + 1;
        return {
            skipReview: true,
            endLoop: nextCount >= MAX_NO_PROGRESS_ITERATIONS,
            lastReviewedSha,
            noProgressCount: nextCount,
        };
    }
    return {
        skipReview: false,
        endLoop: false,
        lastReviewedSha: headSha,
        noProgressCount: 0,
    };
}
