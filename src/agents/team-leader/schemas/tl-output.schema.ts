import { z } from 'zod';
import { AssignmentSchema } from '../../_shared/base-schemas';

export const TeamLeaderOutputSchema = z.object({
    assignments: z.array(AssignmentSchema).describe('Developer assignments'),
    /** Self-check: "20 stories, 26 tasks, 22 assignments, 0 unassigned". Forces the model to count. */
    coverageNote: z.string().optional().describe('Coverage self-check: "N stories, M tasks, K assignments, X unassigned"'),
});
