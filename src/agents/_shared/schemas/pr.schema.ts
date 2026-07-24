import { z } from 'zod';

// ─── PR Review Comments ─────────────────────────────────────────────────────

export const PRReviewCommentSchema = z.object({
    id: z.string().describe('Comment ID'),
    reviewerId: z.string().describe('Reviewer agent ID'),
    filePath: z.string().describe('File path the comment refers to'),
    line: z.number().optional().describe('Line number'),
    body: z.string().describe('Review comment text'),
    severity: z.string().default('info').describe('Comment severity: critical, major, minor, suggestion, info'),
    resolved: z.boolean().default(false).describe('Whether the comment has been addressed'),
});
export type PRReviewComment = z.infer<typeof PRReviewCommentSchema>;

// ─── PR Reviews ─────────────────────────────────────────────────────────────

export const PRReviewSchema = z.object({
    reviewerId: z.string().describe('Reviewer agent ID'),
    status: z.enum(['pending', 'commented', 'changes_requested', 'approved']),
    comments: z.array(PRReviewCommentSchema),
    iteration: z.number().describe('Which review round this is'),
});
export type PRReview = z.infer<typeof PRReviewSchema>;

// ─── Pull Requests ──────────────────────────────────────────────────────────

export const PullRequestSchema = z.object({
    id: z.string().describe('Internal PR ID (e.g. "PR-001")'),
    prNumber: z.number().describe('GitHub PR number'),
    prUrl: z.string().describe('GitHub PR URL'),
    title: z.string().describe('PR title'),
    description: z.string().describe('PR body/description'),
    branchName: z.string().describe('Feature branch name'),
    authorAgentId: z.string().describe('Developer agent who created the PR'),
    reviewerAgentIds: z.array(z.string()).describe('Assigned reviewer agent IDs'),
    reviews: z.array(PRReviewSchema).describe('Review history'),
    status: z.enum(['open', 'approved', 'merged', 'closed', 'escalated_open']),
    assignmentIds: z.array(z.string()).describe('Assignment IDs covered by this PR'),
    taskType: z.enum(['feature', 'bug', 'fix', 'refactor', 'chore']).describe('Type of work'),
    currentState: z.string().optional().describe('For bug/fix/refactor: description of current state before changes'),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

// ─── Branch Assignments ─────────────────────────────────────────────────────

export const BranchAssignmentSchema = z.object({
    branchName: z.string().describe('Feature branch name'),
    assignmentIds: z.array(z.string()).describe('Assignments that share this branch'),
    agentIds: z.array(z.string()).describe('All agent IDs working on this branch'),
    isShared: z.boolean().describe('Whether multiple agents collaborate on this branch'),
});
export type BranchAssignment = z.infer<typeof BranchAssignmentSchema>;
