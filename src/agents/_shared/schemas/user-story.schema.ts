import { z } from 'zod';

// ─── User Stories ───────────────────────────────────────────────────────────

export const UserStorySchema = z.object({
    id: z.string().describe('Unique story ID (e.g. "US-001")'),
    epicId: z.string().describe('Parent epic ID'),
    asA: z.string().describe('"As a..." role'),
    iWant: z.string().describe('"I want..." action'),
    soThat: z.string().describe('"So that..." value'),
    acceptanceCriteria: z.array(z.string()).describe('Testable acceptance criteria'),
});
export type UserStory = z.infer<typeof UserStorySchema>;
