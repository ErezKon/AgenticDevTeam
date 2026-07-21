import { buildAgent } from '../_shared/agent-factory';
import { codebaseAnalyzerSystemPrompt } from './codebase-analyzer.prompt';
import { CodebaseAnalysisSchema } from '../_shared/base-schemas';
import { createWorkspaceTools } from '../../tools/fs/workspace-tools';

/**
 * Create a Codebase Analyzer agent.
 *
 * This agent gets READ-ONLY workspace tools (read_file, list_dir, search_code)
 * and produces a structured CodebaseAnalysis of an existing project.
 */
export const createCodebaseAnalyzerAgent = (apiKey: string, workspacePath: string) => {
    // Use workspace tools but only the read-only subset
    const allTools = createWorkspaceTools(workspacePath);
    const readOnlyTools = allTools.filter(t =>
        ['read_file', 'list_dir', 'search_code'].includes(t.name)
    );

    return buildAgent(apiKey, {
        id: 'codebase-analyzer',
        systemPrompt: codebaseAnalyzerSystemPrompt,
        tools: readOnlyTools,
        responseFormat: CodebaseAnalysisSchema,
        temperature: 0.1,
    });
};
