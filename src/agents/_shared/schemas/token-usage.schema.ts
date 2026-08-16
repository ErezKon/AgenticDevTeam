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
    // Plan 22 D2: prompt-cache accounting. Present for providers that report it
    // (Anthropic); absent for the rest. A run whose cacheReadTokens stay at 0 is
    // paying full price for a byte-identical preamble on every call.
    cacheReadTokens: z.number().optional().describe('Input tokens served from the provider prompt cache'),
    cacheCreationTokens: z.number().optional().describe('Input tokens written to the provider prompt cache'),
    timestamp: z.string().describe('ISO timestamp'),
});
export type TokenCallRecord = z.infer<typeof TokenCallRecordSchema>;
