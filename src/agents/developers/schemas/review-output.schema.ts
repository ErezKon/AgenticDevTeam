import { z } from 'zod';

// ─── Reviewer Agent Output ──────────────────────────────────────────────────

export const ReviewCommentSchema = z.object({
    filePath: z.string().describe('File path relative to repo root'),
    line: z.number().optional().describe('Line number in the file'),
    body: z.string().describe('Review comment text'),
    severity: z.enum(['critical', 'major', 'minor', 'suggestion']).describe('How important this comment is'),
});

// ─── Per-AC Criteria Verdicts (Sub-Plan 07 §5.3) ────────────────────────────

export const CriteriaVerdictSchema = z.object({
    storyId: z.string().describe('User story ID (e.g. "US-003")'),
    acIndex: z.number().int().describe('Acceptance criterion index within the story'),
    met: z.boolean().describe('Whether the criterion is satisfied by the diff'),
    evidence: z.string().describe('file:line proving satisfaction, or "not implemented"'),
});

export const ReviewOutputSchema = z.object({
    status: z.enum(['approved', 'changes_requested']).describe('Overall review decision'),
    summary: z.string().describe('Overall review summary'),
    comments: z.array(ReviewCommentSchema).describe('Specific review comments on files/lines'),
    /** Per-acceptance-criterion verdict. The reviewer must account for every criterion in the assignment. */
    criteriaVerdicts: z.array(CriteriaVerdictSchema).default([]).describe(
        'Per-acceptance-criterion verdict — account for every AC in the assignment',
    ),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
