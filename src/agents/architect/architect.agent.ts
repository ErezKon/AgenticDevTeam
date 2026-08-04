import { buildAgent } from '../_shared/agent-factory';
import { architectSystemPrompt } from './architect.prompt';
import { ArchitectOutputSchema } from './schemas/architect-output.schema';
import { emitMermaidTool } from '../../tools/diagram/diagram-tools';
import { ARCHITECT_MODEL } from '../../config';

export const createArchitectAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'architect',
        systemPrompt: architectSystemPrompt,
        tools: [emitMermaidTool],
        responseFormat: ArchitectOutputSchema,
        temperature: 0.3,
        model: ARCHITECT_MODEL,
    });
};
