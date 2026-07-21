import { buildAgent } from '../_shared/agent-factory';
import { devopsSystemPrompt } from './devops.prompt';
import { DevOpsOutputSchema } from './schemas/devops-output.schema';
import { createWorkspaceTools } from '../../tools/fs/workspace-tools';
import { createShellTool } from '../../tools/shell/shell-tools';

export const createDevOpsAgent = (apiKey: string, workspaceRoot: string) => {
    return buildAgent(apiKey, {
        id: 'devops',
        systemPrompt: devopsSystemPrompt,
        tools: [
            ...createWorkspaceTools(workspaceRoot),
            createShellTool(workspaceRoot),
        ],
        responseFormat: DevOpsOutputSchema,
        temperature: 0.2,
    });
};
