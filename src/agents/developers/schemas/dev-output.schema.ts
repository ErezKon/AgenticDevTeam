import { z } from 'zod';
import { FileChangeSchema } from '../../_shared/base-schemas';

export const DeveloperOutputSchema = z.object({
    fileChanges: z.array(FileChangeSchema).describe('All files created or modified'),
    notes: z.string().optional().describe('Developer notes, assumptions, or blockers'),
    mermaidDiagram: z.string().optional().describe('Optional Mermaid diagram for complex interactions'),
});

export type DeveloperOutput = z.infer<typeof DeveloperOutputSchema>;
