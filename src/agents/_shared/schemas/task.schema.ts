import { z } from 'zod';

// ─── Tasks ──────────────────────────────────────────────────────────────────

export const TaskSchema = z.object({
    id: z.string().describe('Unique task ID (e.g. "TASK-001")'),
    storyId: z.string().optional().describe('Parent story ID if applicable'),
    title: z.string().describe('Short task title'),
    description: z.string().describe('Detailed description of what to build'),
    layer: z.string().describe('Architecture layer (frontend, backend, db, infra, testing)'),
    suggestedTech: z.string().describe('Technology to use for this task'),
});
export type Task = z.infer<typeof TaskSchema>;
