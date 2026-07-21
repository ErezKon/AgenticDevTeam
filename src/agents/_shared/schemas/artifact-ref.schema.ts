import { z } from 'zod';

// ─── Artifact Reference ─────────────────────────────────────────────────────

export const ArtifactRefSchema = z.object({
    agentId: z.string().describe('Agent that produced this artifact'),
    filePath: z.string().describe('Path to the markdown file'),
    title: z.string().describe('Artifact title'),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
