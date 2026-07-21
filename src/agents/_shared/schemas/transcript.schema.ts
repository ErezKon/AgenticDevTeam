import { z } from 'zod';
import { PhaseNameSchema } from './phase.schema';

// ─── Transcript Message ─────────────────────────────────────────────────────

export const TranscriptMessageSchema = z.object({
    timestamp: z.string().describe('ISO timestamp'),
    agentId: z.string().describe('Agent that produced this message'),
    phase: PhaseNameSchema,
    message: z.string().describe('Human-readable event description'),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
