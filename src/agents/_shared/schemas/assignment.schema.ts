import { z } from 'zod';

// ─── Assignments (Team Leader → Developers) ─────────────────────────────────

export const AssignmentSchema = z.object({
    id: z.string().describe('Unique assignment ID (e.g. "ASSIGN-001")'),
    /** Primary user story this assignment delivers. MUST be a US-* id from the plan. */
    storyId: z.string().describe('Primary user story ID this assignment delivers (e.g. "US-001"). MUST match a real story id from the plan.'),
    /** Additional stories delivered by this assignment (when work is legitimately batched). */
    additionalStoryIds: z.array(z.string()).default([]).describe('Extra story ids delivered on this branch when batching related stories. Every story MUST appear in exactly one assignment.'),
    /** Task ids from the Product Manager plan that this assignment implements. MUST be non-empty. */
    taskIds: z.array(z.string()).min(1).describe('Task ids (e.g. ["TASK-001","TASK-002"]) from the PM plan that this assignment implements.'),
    /** Indices into the story acceptanceCriteria that this assignment is responsible for. Empty = all. */
    acIndexes: z.array(z.number().int().nonnegative()).default([]).describe('Indices into the story acceptanceCriteria array. Empty means all criteria.'),
    devAgentId: z.string().describe('Developer agent ID (e.g. "junior-react", "senior-backend")'),
    rank: z.enum(['principal', 'senior', 'junior']).describe('Developer rank'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('Priority'),
    complexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very-complex']).describe('Estimated complexity'),
    estimate: z.string().describe('Rough effort estimate'),
    description: z.string().describe('What the developer should do'),
    dependsOn: z.array(z.string()).describe('Assignment IDs this depends on'),
    branchName: z.string().optional().describe('Feature branch for this assignment (set by Team Leader for shared branches)'),
    reviewerAgentIds: z.array(z.string()).optional().describe('Assigned reviewer agent IDs'),
    taskType: z.enum(['feature', 'bug', 'fix', 'refactor', 'chore']).default('feature').describe('Type of work'),
    /** Module ids from the repo contract that this assignment owns. Must come from the contract. */
    moduleIds: z.array(z.string()).default([]).describe('Module ids from the repo contract owned by this assignment'),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
