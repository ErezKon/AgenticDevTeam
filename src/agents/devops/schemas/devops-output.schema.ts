import { z } from 'zod';
import { DevOpsPlanSchema, FileChangeSchema } from '../../_shared/base-schemas';

export const DevOpsOutputSchema = z.object({
    devops: DevOpsPlanSchema.describe('DevOps plan with build/run statuses'),
    fileChanges: z.array(FileChangeSchema).optional().describe('Infrastructure files created'),
});

export type DevOpsOutput = z.infer<typeof DevOpsOutputSchema>;
