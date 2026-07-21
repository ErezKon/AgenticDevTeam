/**
 * Reviewer Agent Builder — creates a code-review agent from a developer registry entry.
 *
 * Uses the same developer agents but with a reviewer persona prompt.
 * Reviewers get git tools (for reading diffs) and GitHub tools (for posting reviews).
 */
import { buildAgent } from '../_shared/agent-factory';
import { buildReviewerPersona } from '../_shared/persona';
import { ReviewOutputSchema } from './schemas/review-output.schema';
import { createGitTools } from '../../tools/git/git-tools';
import { createGitHubTools } from '../../tools/git/github-tools';
import type { DevAgentEntry } from './registry';

/**
 * Build a reviewer agent from a developer registry entry.
 *
 * @param apiKey        LLM access token
 * @param entry         Developer registry entry (rank, domain, languages, etc.)
 * @param workspaceRoot The generated-project workspace directory
 */
export function buildReviewerAgent(apiKey: string, entry: DevAgentEntry, workspaceRoot: string) {
    const systemPrompt = buildReviewerPersona({
        rank: entry.rank,
        domain: entry.domain,
        languages: entry.languages,
        tag: entry.tag,
    });

    const tools = [
        ...createGitTools(workspaceRoot),
        ...createGitHubTools(),
    ];

    return buildAgent(apiKey, {
        id: `${entry.id}-reviewer`,
        systemPrompt,
        tools,
        responseFormat: ReviewOutputSchema,
        temperature: 0.1,
    });
}
