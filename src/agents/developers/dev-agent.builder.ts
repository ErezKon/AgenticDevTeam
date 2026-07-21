/**
 * Developer Agent Builder — creates a concrete dev agent from registry data.
 *
 * Uses the persona builder for the prompt and the agent factory for the LLM agent.
 */
import { buildAgent } from '../_shared/agent-factory';
import { buildDevPersona } from '../_shared/persona';
import { DeveloperOutputSchema } from './schemas/dev-output.schema';
import { createWorkspaceTools } from '../../tools/fs/workspace-tools';
import { createGitTools } from '../../tools/git/git-tools';
import { createShellTool } from '../../tools/shell/shell-tools';
import { emitMermaidTool } from '../../tools/diagram/diagram-tools';
import type { DevAgentEntry } from './registry';

/**
 * Build a developer agent.
 *
 * @param apiKey  LLM access token
 * @param entry   Developer registry entry (rank, domain, languages, etc.)
 * @param workspaceRoot  The generated-project workspace directory
 */
export function buildDevAgent(apiKey: string, entry: DevAgentEntry, workspaceRoot: string) {
    const systemPrompt = buildDevPersona({
        rank: entry.rank,
        domain: entry.domain,
        languages: entry.languages,
        tag: entry.tag,
    });

    const tools = [
        ...createWorkspaceTools(workspaceRoot),
        ...createGitTools(workspaceRoot),
        createShellTool(workspaceRoot),
        emitMermaidTool,
    ];

    return buildAgent(apiKey, {
        id: entry.id,
        systemPrompt,
        tools,
        responseFormat: DeveloperOutputSchema,
        temperature: entry.temperature,
    });
}
