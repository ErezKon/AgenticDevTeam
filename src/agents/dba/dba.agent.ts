import { buildAgent } from '../_shared/agent-factory';
import { dbaSystemPrompt } from './dba.prompt';
import { DbaOutputSchema } from './schemas/dba-output.schema';
import { emitMermaidTool } from '../../tools/diagram/diagram-tools';

export const createDbaAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'dba',
        systemPrompt: dbaSystemPrompt,
        tools: [emitMermaidTool],
        responseFormat: DbaOutputSchema,
        temperature: 0.2,
    });
};
