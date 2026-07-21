import { z } from 'zod';

// ─── Run Input ──────────────────────────────────────────────────────────────

export const RunInputSchema = z.object({
    systemName: z.string().describe('Name of the system being built'),
    requirementsText: z.string().describe('Full text of the requirements document'),
    requirementsDocPath: z.string().optional().describe('Path to the original requirements file'),
    mode: z.enum(['autonomous', 'human']).describe('Run mode'),
    runType: z.enum(['greenfield', 'maintain']).default('greenfield')
        .describe('Whether this is a new project build or maintenance of an existing codebase'),
    existingProjectPath: z.string().optional()
        .describe('Absolute path to the existing project root (required for maintain mode)'),
});
export type RunInput = z.infer<typeof RunInputSchema>;
