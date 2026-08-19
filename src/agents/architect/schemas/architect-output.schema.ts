import { z } from 'zod';
import { ArchitectureDocSchema, TechDecisionSchema, EpicSchema } from '../../_shared/base-schemas';
import { RepoContractSchema } from '../../_shared/schemas/repo-contract.schema';

export const ArchitectOutputSchema = z.object({
    architecture: ArchitectureDocSchema.describe('Complete architecture document'),
    techStack: z.array(TechDecisionSchema).describe('Technology decisions for every layer'),
    epics: z.array(EpicSchema).describe('High-level epics derived from the requirements'),
    repoContract: RepoContractSchema.describe('Machine-checkable repo layout and module contract'),
});
