/**
 * Review-loop policy helpers.
 *
 * Pure functions extracted from pr-workflow.ts so they can be unit-tested
 * without pulling in the full workflow machinery. Used by Sub-Plan 5 to
 * prevent wasted review iterations and cosmetic-only blocking.
 */

// ─── Blocking severity check ─────────────────────────────────────────────────

/**
 * Only critical/major findings justify another dev+review round trip.
 * Runs 5 & 6 burned whole iterations on [MINOR]/[SUGGESTION] comments.
 * Cosmetic comments are still recorded and posted to the PR — they just
 * do not block the merge.
 */
const BLOCKING_SEVERITIES = new Set(['critical', 'major']);

/**
 * Return `true` if any comment in the array has a blocking severity.
 *
 * A missing or empty severity is treated as non-blocking (`'info'`).
 */
export function isBlockingReview(comments: { severity?: string }[]): boolean {
    return comments.some(
        c => BLOCKING_SEVERITIES.has(String(c.severity ?? 'info').toLowerCase()),
    );
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
