import { z } from 'zod';
import { DbDesignSchema } from '../../_shared/base-schemas';

export const DbaOutputSchema = z.object({
    dbDesign: DbDesignSchema.describe('Complete database design'),
});
