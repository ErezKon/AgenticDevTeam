import { z } from 'zod';

// ─── Bugs ───────────────────────────────────────────────────────────────────

export const BugSchema = z.object({
    id: z.string().describe('Unique bug ID (e.g. "BUG-001")'),
    title: z.string().describe('Short bug title'),
    severity: z.enum(['critical', 'major', 'minor', 'trivial']).describe('Bug severity'),
    stepsToReproduce: z.string().describe('How to reproduce the bug'),
    expectedBehavior: z.string().describe('What should happen'),
    actualBehavior: z.string().describe('What actually happens'),
    failingTestId: z.string().optional().describe('ID of the failing test that found this'),
    suspectedArea: z.string().describe('Code area likely responsible'),
    suggestedAssignee: z.string().optional().describe('Suggested developer agent to fix'),
    reportedBy: z.string().describe('QA agent ID that reported it'),
});
export type Bug = z.infer<typeof BugSchema>;
