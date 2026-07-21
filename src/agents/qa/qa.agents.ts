import { buildAgent } from '../_shared/agent-factory';
import { qaLeadSystemPrompt } from './qa-lead.prompt';
import { qaUnitSystemPrompt } from './qa-unit.prompt';
import { qaE2eSystemPrompt } from './qa-e2e.prompt';
import { QaLeadOutputSchema, QaUnitOutputSchema, QaE2eOutputSchema } from './schemas/qa-output.schema';
import { createWorkspaceTools } from '../../tools/fs/workspace-tools';
import { createShellTool } from '../../tools/shell/shell-tools';
import { emitMermaidTool } from '../../tools/diagram/diagram-tools';

export const createQaLeadAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'qa-lead',
        systemPrompt: qaLeadSystemPrompt,
        tools: [emitMermaidTool],
        responseFormat: QaLeadOutputSchema,
        temperature: 0.2,
    });
};

export const createQaUnitAgent = (apiKey: string, workspaceRoot: string) => {
    return buildAgent(apiKey, {
        id: 'qa-unit',
        systemPrompt: qaUnitSystemPrompt,
        tools: [
            ...createWorkspaceTools(workspaceRoot),
            createShellTool(workspaceRoot),
        ],
        responseFormat: QaUnitOutputSchema,
        temperature: 0.2,
    });
};

/**
 * Create the E2E QA agent with Playwright MCP tools.
 *
 * @param apiKey       LLM token
 * @param mcpTools     Playwright MCP tools loaded via MultiServerMCPClient
 */
export const createQaE2eAgent = (apiKey: string, mcpTools: any[]) => {
    return buildAgent(apiKey, {
        id: 'qa-e2e',
        systemPrompt: qaE2eSystemPrompt,
        tools: mcpTools,
        responseFormat: QaE2eOutputSchema,
        temperature: 0.1,
    });
};
