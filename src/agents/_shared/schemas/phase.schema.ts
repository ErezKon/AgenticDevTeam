import { z } from 'zod';

// ─── Phase ──────────────────────────────────────────────────────────────────

export const PhaseNameSchema = z.enum([
    'intake',
    'codebase-analyzer',
    'architect',
    'product-manager',
    'dba',
    'team-leader',
    'development',
    'qa',
    'bugfix-triage',
    'devops',
    'finalize',
]);
export type PhaseName = z.infer<typeof PhaseNameSchema>;
