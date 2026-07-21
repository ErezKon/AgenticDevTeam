import { z } from 'zod';

// ─── Epics ──────────────────────────────────────────────────────────────────

export const EpicSchema = z.object({
    id: z.string().describe('Unique epic ID (e.g. "EPIC-001")'),
    title: z.string().describe('Short epic title'),
    description: z.string().describe('What this epic delivers'),
    components: z.array(z.string()).describe('Architecture components involved'),
});
export type Epic = z.infer<typeof EpicSchema>;
