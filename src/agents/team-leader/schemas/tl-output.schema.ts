import { z } from 'zod';
import { AssignmentSchema } from '../../_shared/base-schemas';

export const TeamLeaderOutputSchema = z.object({
    assignments: z.array(AssignmentSchema).describe('Developer assignments'),
});

export type TeamLeaderOutput = z.infer<typeof TeamLeaderOutputSchema>;
