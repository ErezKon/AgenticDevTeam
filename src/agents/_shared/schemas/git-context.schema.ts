import { z } from 'zod';

// ─── Git Context ────────────────────────────────────────────────────────────

export const GitContextSchema = z.object({
    token: z.string().describe('GitHub PAT for this repo'),
    owner: z.string().describe('GitHub repo owner (org or user)'),
    repo: z.string().describe('GitHub repository name'),
    defaultBranch: z.string().default('main').describe('Default branch name'),
});
export type GitContext = z.infer<typeof GitContextSchema>;

// ─── Repo Target ────────────────────────────────────────────────────────────

export const RepoTargetSchema = z.object({
    type: z.enum(['same-repo', 'new-repo', 'existing-repo'])
        .describe('Where the project should be hosted'),
    repoName: z.string().optional()
        .describe('Repository name (for new-repo or existing-repo)'),
    isPrivate: z.boolean().default(true)
        .describe('Whether the new repo should be private (for new-repo)'),
});
export type RepoTarget = z.infer<typeof RepoTargetSchema>;
