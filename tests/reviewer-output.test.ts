/**
 * Reviewer Output — unit tests for Sub-Plan 07's reviewer output schema changes.
 *
 * Tests criteriaVerdicts validation and consistency enforcement.
 */
import { ReviewOutputSchema } from '../src/agents/developers/schemas/review-output.schema';
import { enforceCriteriaVerdicts, type ReviewOutcome } from '../src/conductor/review-policy';

describe('ReviewOutputSchema', () => {
    it('accepts output with criteriaVerdicts', () => {
        const data = {
            status: 'approved',
            summary: 'LGTM',
            comments: [],
            criteriaVerdicts: [
                { storyId: 'US-001', acIndex: 0, met: true, evidence: 'src/app.ts:10' },
                { storyId: 'US-001', acIndex: 1, met: true, evidence: 'src/db.ts:22' },
            ],
        };
        const result = ReviewOutputSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.criteriaVerdicts).toHaveLength(2);
        }
    });

    it('defaults criteriaVerdicts to empty array when not provided', () => {
        const data = {
            status: 'approved',
            summary: 'LGTM',
            comments: [],
        };
        const result = ReviewOutputSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.criteriaVerdicts).toEqual([]);
        }
    });

    it('rejects criteriaVerdicts with missing required fields', () => {
        const data = {
            status: 'approved',
            summary: 'LGTM',
            comments: [],
            criteriaVerdicts: [
                { storyId: 'US-001' }, // missing acIndex, met, evidence
            ],
        };
        const result = ReviewOutputSchema.safeParse(data);
        expect(result.success).toBe(false);
    });
});

describe('enforceCriteriaVerdicts consistency', () => {
    it('downgrades approved with unmet verdict to changes_requested', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'looks good',
                comments: [],
                criteriaVerdicts: [
                    { storyId: 'US-001', acIndex: 0, met: false, evidence: 'not implemented' },
                ],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, true);
        expect(result.kind).toBe('changes_requested');
        if (result.kind === 'changes_requested') {
            expect(result.output.status).toBe('changes_requested');
        }
    });

    it('treats empty criteriaVerdicts on assignment with criteria as abstained', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'approved',
                comments: [],
                criteriaVerdicts: [],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, true);
        expect(result.kind).toBe('abstained');
        if (result.kind === 'abstained') {
            expect(result.reason).toBe('empty-output');
        }
    });

    it('allows empty criteriaVerdicts when assignment has no criteria', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'approved',
                comments: [],
                criteriaVerdicts: [],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, false);
        expect(result.kind).toBe('approved');
    });
});
