import { buildAgent } from '../_shared/agent-factory';
import { buildDevOpsPrompt, devopsSystemPrompt } from './devops.prompt';
import { DevOpsOutputSchema } from './schemas/devops-output.schema';
import { createWorkspaceTools } from '../../tools/fs/workspace-tools';
import { createShellTool } from '../../tools/shell/shell-tools';
import { DEVOPS_MODEL, TOOL_PIPELINE_MAX_TOOL_CALLS } from '../../config';

export const createDevOpsAgent = (apiKey: string, workspaceRoot: string, conventionFiles?: string[]) => {
    return buildAgent(apiKey, {
        id: 'devops',
        systemPrompt: conventionFiles ? buildDevOpsPrompt(conventionFiles) : devopsSystemPrompt,
        tools: [
            ...createWorkspaceTools(workspaceRoot),
            createShellTool(workspaceRoot),
        ],
        responseFormat: DevOpsOutputSchema,
        temperature: 0.2,
        model: DEVOPS_MODEL,
        phase: 'devops',
        maxToolCalls: TOOL_PIPELINE_MAX_TOOL_CALLS,
    });
};
