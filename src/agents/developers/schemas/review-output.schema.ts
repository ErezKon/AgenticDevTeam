import { z } from 'zod';

// ─── Reviewer Agent Output ──────────────────────────────────────────────────

export const ReviewCommentSchema = z.object({
    filePath: z.string().describe('File path relative to repo root'),
    line: z.number().optional().describe('Line number in the file'),
    body: z.string().describe('Review comment text'),
    severity: z.enum(['critical', 'major', 'minor', 'suggestion']).describe('How important this comment is'),
});

export const ReviewOutputSchema = z.object({
    status: z.enum(['approved', 'changes_requested']).describe('Overall review decision'),
    summary: z.string().describe('Overall review summary'),
    comments: z.array(ReviewCommentSchema).describe('Specific review comments on files/lines'),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
