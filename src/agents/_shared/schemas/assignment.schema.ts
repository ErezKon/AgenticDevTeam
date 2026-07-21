import { z } from 'zod';

// ─── Assignments (Team Leader → Developers) ─────────────────────────────────

export const AssignmentSchema = z.object({
    id: z.string().describe('Unique assignment ID (e.g. "ASSIGN-001")'),
    storyId: z.string().describe('Story or task ID being assigned'),
    devAgentId: z.string().describe('Developer agent ID (e.g. "junior-react", "senior-backend")'),
    rank: z.enum(['principal', 'senior', 'junior']).describe('Developer rank'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('Priority'),
    complexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very-complex']).describe('Estimated complexity'),
    estimate: z.string().describe('Rough effort estimate'),
    description: z.string().describe('What the developer should do'),
    dependsOn: z.array(z.string()).describe('Assignment IDs this depends on'),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
