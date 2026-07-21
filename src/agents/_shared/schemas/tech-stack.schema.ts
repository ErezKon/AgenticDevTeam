import { z } from 'zod';

// ─── Tech Stack ─────────────────────────────────────────────────────────────

export const TechDecisionSchema = z.object({
    layer: z.string().describe('Architecture layer (e.g. "frontend", "backend", "database", "infra", "auth", "messaging")'),
    choice: z.string().describe('Chosen technology (e.g. "React", "Go", "PostgreSQL")'),
    alternatives: z.array(z.string()).describe('Alternatives considered'),
    rationale: z.string().describe('Why this technology was chosen over the alternatives'),
});
export type TechDecision = z.infer<typeof TechDecisionSchema>;
