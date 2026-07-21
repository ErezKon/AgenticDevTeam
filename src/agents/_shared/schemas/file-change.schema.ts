import { z } from 'zod';

// ─── File Changes (Developer output) ────────────────────────────────────────

export const FileChangeSchema = z.object({
    path: z.string().describe('File path relative to workspace root'),
    action: z.enum(['created', 'modified', 'deleted']).describe('What was done'),
    summary: z.string().describe('Brief description of the change'),
    storyId: z.string().describe('Assignment/story ID this change belongs to'),
    agentId: z.string().describe('Developer agent that made the change'),
});
export type FileChange = z.infer<typeof FileChangeSchema>;
