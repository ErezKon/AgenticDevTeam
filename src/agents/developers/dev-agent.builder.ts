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
import { PRINCIPAL_DEV_MODEL, SENIOR_DEV_MODEL, JUNIOR_DEV_MODEL, DEV_GIT_TOOLS_ENABLED, STRONG_FIXER_MODEL, STRONG_FIXER_MAX_TOOL_CALLS } from '../../config';
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
 * @param conventionFiles  Optional list of convention file names to inject into the prompt
 * @param isMaintainMode  When true, appends maintain-mode instructions to the persona
 */
export function buildDevAgent(
    apiKey: string, entry: DevAgentEntry, workspaceRoot: string,
    gitContext?: GitContext | null, baseBranch?: string,
    conventionFiles?: string[],
    isMaintainMode?: boolean,
) {
    const systemPrompt = buildDevPersona({
        rank: entry.rank,
        domain: entry.domain,
        languages: entry.languages,
        tag: entry.tag,
        conventionFiles,
        isMaintainMode,
    });

    // Dev agents get workspace (fs) and shell tools. Git tools are only
    // included when DEV_GIT_TOOLS_ENABLED=true — the PR workflow already
    // commits and pushes for dev agents, so git tools are unnecessary
    // overhead (each schema is re-billed on every LLM call, and agents
    // waste 5-10 tool calls on git ceremony).
    const tools = [
        ...createWorkspaceTools(workspaceRoot),
        ...(DEV_GIT_TOOLS_ENABLED ? createGitTools(workspaceRoot, gitContext, baseBranch) : []),
        createShellTool(workspaceRoot),
    ];

    // Lowered ceilings since git ceremony calls are gone and history is
    // now compacted. The respawn mechanism (Step 8) handles the case
    // where an agent legitimately needs more calls — hitting the ceiling
    // now triggers a clean respawn instead of poisoning.
    const maxToolCalls = entry.rank === 'principal' ? 26
        : entry.rank === 'senior' ? 22
        : 18; // junior

    return buildAgent(apiKey, {
        id: entry.id,
        systemPrompt,
        tools,
        responseFormat: DeveloperOutputSchema,
        temperature: entry.temperature,
        model: getModelForRank(entry.rank),
        phase: 'development',
        maxToolCalls,
        topK: undefined,
        topP: undefined
    });
}

/**
 * Build a strong fixer agent — a principal-rank dev agent using a dedicated
 * powerful model (STRONG_FIXER_MODEL) to fix PRs that exhausted their review
 * iterations (Sub-Plan 20).
 *
 * Uses the principal persona for maximum capability, workspace + shell tools
 * (same as regular dev agents), and a higher tool-call budget.
 *
 * @param apiKey          LLM access token
 * @param workspaceRoot   The generated-project workspace directory
 * @param gitContext      Git context for tools
 * @param baseBranch      Base branch for git tools
 * @param conventionFiles Convention files to inject into the prompt
 * @param isMaintainMode  When true, appends maintain-mode instructions
 */
export function buildStrongFixerAgent(
    apiKey: string,
    workspaceRoot: string,
    gitContext?: GitContext | null,
    baseBranch?: string,
    conventionFiles?: string[],
    isMaintainMode?: boolean,
) {
    const fixerModel = STRONG_FIXER_MODEL || PRINCIPAL_DEV_MODEL;

    const systemPrompt = buildDevPersona({
        rank: 'principal',
        domain: 'fullstack',
        languages: ['typescript', 'javascript', 'python', 'java', 'go'],
        tag: '[STRONG-FIXER]',
        conventionFiles,
        isMaintainMode,
    });

    const tools = [
        ...createWorkspaceTools(workspaceRoot),
        ...(DEV_GIT_TOOLS_ENABLED ? createGitTools(workspaceRoot, gitContext, baseBranch) : []),
        createShellTool(workspaceRoot),
    ];

    return buildAgent(apiKey, {
        id: 'strong-fixer',
        systemPrompt,
        tools,
        responseFormat: DeveloperOutputSchema,
        temperature: 0.2,
        model: fixerModel,
        phase: 'development',
        maxToolCalls: STRONG_FIXER_MAX_TOOL_CALLS,
        topK: undefined,
        topP: undefined
    });
}
