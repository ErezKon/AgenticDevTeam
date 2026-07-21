import { z } from 'zod';
import { UserStorySchema, TaskSchema } from '../../_shared/base-schemas';

export const ProductManagerOutputSchema = z.object({
    userStories: z.array(UserStorySchema).describe('User stories with acceptance criteria'),
    tasks: z.array(TaskSchema).describe('Concrete development tasks'),
});

export type ProductManagerOutput = z.infer<typeof ProductManagerOutputSchema>;
