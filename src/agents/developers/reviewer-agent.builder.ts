/**
 * Reviewer Agent Builder — creates a code-review agent from a developer registry entry.
 *
 * Uses the same developer agents but with a reviewer persona prompt.
 * Reviewers get READ-ONLY git tools for diff inspection only.
 * The PR workflow handles posting reviews to GitHub — reviewers produce
 * structured JSON output, they do NOT post reviews via tools.
 */
import { buildAgent } from '../_shared/agent-factory';
import { buildReviewerPersona } from '../_shared/persona';
import type { DevRank } from '../_shared/persona';
import { ReviewOutputSchema } from './schemas/review-output.schema';
import { createGitTools } from '../../tools/git/git-tools';
import { PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL, JUNIOR_DEV_MODEL } from '../../config';
import type { GitContext } from '../_shared/base-schemas';
import type { DevAgentEntry } from './registry';

/** Resolve the LLM model for a reviewer agent based on rank. */
function getModelForRank(rank: DevRank): string {
    switch (rank) {
        case 'principal': return PRINCIPAL_DEV_MODEL;
        case 'senior':    return SENIOR_DEV_MODEL;
        case 'junior':    return JUNIOR_DEV_MODEL;
    }
}

/**
 * Read-only git tool names for reviewers (diff inspection only).
 *
 * NOTE: `git_diff` is intentionally excluded. It shows unstaged working-tree
 * changes, but by the time reviewers run, all code is committed and pushed,
 * so `git_diff` always returns "(no diff)". This caused reviewers (especially
 * llama-3-3-70b-instruct) to loop calling git_diff repeatedly.
 * Use `git_merge_base_diff` to see the actual PR changes against the base branch.
 */
const REVIEWER_GIT_TOOLS = new Set([
    'git_merge_base_diff',
    'git_diff_file',
    'git_diff_stat',
    'git_log',
    'git_current_branch',
    'git_status',
]);

/**
 * Build a reviewer agent from a developer registry entry.
 *
 * @param apiKey        LLM access token
 * @param entry         Developer registry entry (rank, domain, languages, etc.)
 * @param workspaceRoot The generated-project workspace directory
 */
export function buildReviewerAgent(apiKey: string, entry: DevAgentEntry, workspaceRoot: string, gitContext?: GitContext | null) {
    const systemPrompt = buildReviewerPersona({
        rank: entry.rank,
        domain: entry.domain,
        languages: entry.languages,
        tag: entry.tag,
    });

    // Reviewers only get read-only git tools for inspecting diffs.
    // No GitHub tools — the PR workflow posts reviews on their behalf.
    const allGitTools = createGitTools(workspaceRoot, gitContext);
    const readOnlyGitTools = allGitTools.filter(t => REVIEWER_GIT_TOOLS.has(t.name));

    return buildAgent(apiKey, {
        id: `${entry.id}-reviewer`,
        systemPrompt,
        tools: readOnlyGitTools,
        responseFormat: ReviewOutputSchema,
        temperature: 0.1,
        model: getModelForRank(entry.rank),
        phase: 'review',
    });
}
