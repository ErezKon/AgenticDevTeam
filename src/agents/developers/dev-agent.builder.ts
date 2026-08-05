/**
 * Developer Agent Builder — creates a concrete dev agent from registry data.
 *
 * Uses the persona builder for the prompt and the agent factory for the LLM agent.
 */
import { buildAgent } from '../_shared/agent-factory';
import { buildDevPersona } from '../_shared/persona';
import type { DevRank } from '../_shared/persona';
import { DeveloperOutputSchema } from './schemas/dev-output.schema';
import { createWorkspaceTools } from '../../tools/fs/workspace-tools';
import { createGitTools } from '../../tools/git/git-tools';
import { createShellTool } from '../../tools/shell/shell-tools';
import { PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL, JUNIOR_DEV_MODEL } from '../../config';
import type { GitContext } from '../_shared/base-schemas';
import type { DevAgentEntry } from './registry';

/** Resolve the LLM model for a developer agent based on rank. */
function getModelForRank(rank: DevRank): string {
    switch (rank) {
        case 'principal': return PRINCIPAL_DEV_MODEL;
        case 'senior':    return SENIOR_DEV_MODEL;
        case 'junior':    return JUNIOR_DEV_MODEL;
    }
}

/**
 * Build a developer agent.
 *
 * @param apiKey  LLM access token
 * @param entry   Developer registry entry (rank, domain, languages, etc.)
 * @param workspaceRoot  The generated-project workspace directory
 */
export function buildDevAgent(
    apiKey: string, entry: DevAgentEntry, workspaceRoot: string,
    gitContext?: GitContext | null, baseBranch?: string,
) {
    const systemPrompt = buildDevPersona({
        rank: entry.rank,
        domain: entry.domain,
        languages: entry.languages,
        tag: entry.tag,
    });

    // Dev agents get workspace (fs), git, and shell tools.
    // No emitMermaidTool — the DeveloperOutputSchema has a `mermaidDiagram`
    // field for diagrams; giving devs the tool caused infinite loops.
    const tools = [
        ...createWorkspaceTools(workspaceRoot),
        ...createGitTools(workspaceRoot, gitContext, baseBranch),
        createShellTool(workspaceRoot),
    ];

    // Dev agents need more tool calls than pipeline agents:
    // read files, create/edit files, run tests, git add/commit/push per file.
    // Principal/Senior devs doing multi-file work need the most headroom.
    const maxToolCalls = entry.rank === 'principal' ? 40
        : entry.rank === 'senior' ? 35
        : 30; // junior

    return buildAgent(apiKey, {
        id: entry.id,
        systemPrompt,
        tools,
        responseFormat: DeveloperOutputSchema,
        temperature: entry.temperature,
        model: getModelForRank(entry.rank),
        phase: 'development',
        maxToolCalls,
    });
}
