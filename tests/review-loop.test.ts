/**
 * Review-loop policy helpers — unit tests.
 *
 * Tests the pure functions extracted to src/conductor/review-policy.ts.
 * These control whether a review iteration is skipped (no-progress
 * detection) and whether review comments are blocking (severity check).
 *
 * Test cases from Sub-Plan 5 verification spec:
 *   - Only suggestions/minor → not blocking
 *   - One critical → blocking
 *   - Missing severity → not blocking
 *   - Same SHA → skip
 *   - Different SHA → do not skip
 *   - Empty/missing SHA → do not skip
 */
import {
    isBlockingReview, shouldSkipReview, evaluateProgress, MAX_NO_PROGRESS_ITERATIONS,
} from '../src/conductor/review-policy';

// ─── isBlockingReview ───────────────────────────────────────────────────────

describe('isBlockingReview', () => {
    it('returns false when all comments are minor/suggestion only', () => {
        const comments = [
            { severity: 'minor' },
            { severity: 'suggestion' },
            { severity: 'minor' },
        ];
        expect(isBlockingReview(comments)).toBe(false);
    });

    it('returns true when at least one comment is critical', () => {
        const comments = [
            { severity: 'minor' },
            { severity: 'critical' },
            { severity: 'suggestion' },
        ];
        expect(isBlockingReview(comments)).toBe(true);
    });

    it('returns true when at least one comment is major', () => {
        const comments = [
            { severity: 'suggestion' },
            { severity: 'major' },
        ];
        expect(isBlockingReview(comments)).toBe(true);
    });

    it('returns true when severity is missing (Sub-Plan 07: unknown = blocking)', () => {
        const comments = [
            { severity: undefined },
            {},
        ];
        expect(isBlockingReview(comments)).toBe(true);
    });

    it('returns false for an empty comments array', () => {
        expect(isBlockingReview([])).toBe(false);
    });

    it('handles mixed case severity strings', () => {
        expect(isBlockingReview([{ severity: 'CRITICAL' }])).toBe(true);
        expect(isBlockingReview([{ severity: 'Major' }])).toBe(true);
        expect(isBlockingReview([{ severity: 'MINOR' }])).toBe(false);
    });
});

// ─── shouldSkipReview ───────────────────────────────────────────────────────

describe('shouldSkipReview', () => {
    it('returns true when previous and head SHA are the same', () => {
        const sha = 'abc123def456';
        expect(shouldSkipReview(sha, sha)).toBe(true);
    });

    it('returns false when SHAs differ', () => {
        expect(shouldSkipReview('abc123', 'def456')).toBe(false);
    });

    it('returns false when previous SHA is empty (first iteration)', () => {
        expect(shouldSkipReview('', 'abc123')).toBe(false);
    });

    it('returns false when head SHA is empty', () => {
        expect(shouldSkipReview('abc123', '')).toBe(false);
    });

    it('returns false when both SHAs are empty', () => {
        expect(shouldSkipReview('', '')).toBe(false);
    });

    it('returns false when the head SHA is a gitExec error string', () => {
        expect(shouldSkipReview('Error: fatal', 'Error: fatal')).toBe(false);
    });
});

// ─── evaluateProgress ───────────────────────────────────────────────────────

describe('evaluateProgress', () => {
    it('never skips the first iteration and records the SHA', () => {
        const d = evaluateProgress(1, 'sha-a', '', 0);
        expect(d.skipReview).toBe(false);
        expect(d.endLoop).toBe(false);
        expect(d.lastReviewedSha).toBe('sha-a');
        expect(d.noProgressCount).toBe(0);
    });

    it('does NOT skip when HEAD moved since the last review', () => {
        // Regression: an earlier implementation stored the new SHA before the
        // comparison, which made every iteration > 1 look like no-progress and
        // silently disabled all re-reviews.
        const d = evaluateProgress(2, 'sha-b', 'sha-a', 0);
        expect(d.skipReview).toBe(false);
        expect(d.lastReviewedSha).toBe('sha-b');
        expect(d.noProgressCount).toBe(0);
    });

    it('skips (without ending the loop) on the first no-progress iteration', () => {
        const d = evaluateProgress(2, 'sha-a', 'sha-a', 0);
        expect(d.skipReview).toBe(true);
        expect(d.endLoop).toBe(false);
        expect(d.lastReviewedSha).toBe('sha-a');
        expect(d.noProgressCount).toBe(1);
    });

    it('ends the loop after MAX_NO_PROGRESS_ITERATIONS consecutive no-progress iterations', () => {
        const d = evaluateProgress(3, 'sha-a', 'sha-a', MAX_NO_PROGRESS_ITERATIONS - 1);
        expect(d.skipReview).toBe(true);
        expect(d.endLoop).toBe(true);
        expect(d.noProgressCount).toBe(MAX_NO_PROGRESS_ITERATIONS);
    });

    it('resets the no-progress counter once a new commit appears', () => {
        const d = evaluateProgress(3, 'sha-c', 'sha-a', 1);
        expect(d.skipReview).toBe(false);
        expect(d.noProgressCount).toBe(0);
        expect(d.lastReviewedSha).toBe('sha-c');
    });

    it('simulating the loop: review → fix → review (reviewers run every iteration)', () => {
        let lastSha = '';
        let count = 0;
        const shas = ['sha-1', 'sha-2', 'sha-3'];
        const skipped: boolean[] = [];
        for (let iteration = 1; iteration <= 3; iteration++) {
            const d = evaluateProgress(iteration, shas[iteration - 1], lastSha, count);
            lastSha = d.lastReviewedSha;
            count = d.noProgressCount;
            skipped.push(d.skipReview);
        }
        expect(skipped).toEqual([false, false, false]);
    });
});
