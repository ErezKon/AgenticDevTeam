import { z } from 'zod';
import { PhaseNameSchema } from './phase.schema';

// ─── Approval (HITL) ───────────────────────────────────────────────────────

export const ApprovalSchema = z.object({
    phase: PhaseNameSchema,
    decision: z.enum(['approve', 'deny', 'enhance']).describe('User decision'),
    feedback: z.string().optional().describe('User feedback (for deny/enhance)'),
    timestamp: z.string().describe('ISO timestamp of the decision'),
});
export type Approval = z.infer<typeof ApprovalSchema>;
