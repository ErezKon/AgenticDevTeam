import { z } from 'zod';

// ─── Token Usage ────────────────────────────────────────────────────────────

/** A single LLM call's token usage record (stored in state). */
export const TokenCallRecordSchema = z.object({
    agentId: z.string().describe('Agent that made the LLM call'),
    model: z.string().describe('Model name used'),
    phase: z.string().describe('Pipeline phase'),
    inputTokens: z.number().describe('Input/prompt tokens'),
    outputTokens: z.number().describe('Output/completion tokens'),
    totalTokens: z.number().describe('Total tokens (input + output)'),
    timestamp: z.string().describe('ISO timestamp'),
});
export type TokenCallRecord = z.infer<typeof TokenCallRecordSchema>;
