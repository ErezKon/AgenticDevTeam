import { buildAgent } from '../_shared/agent-factory';
import { architectSystemPrompt } from './architect.prompt';
import { ArchitectOutputSchema } from './schemas/architect-output.schema';
import { ARCHITECT_MODEL, PLANNING_MAX_OUTPUT_TOKENS } from '../../config';

export const createArchitectAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'architect',
        systemPrompt: architectSystemPrompt,
        tools: [],
        responseFormat: ArchitectOutputSchema,
        temperature: 0.3,
        model: ARCHITECT_MODEL,
        maxOutputTokens: PLANNING_MAX_OUTPUT_TOKENS,
        keepSchemaDescriptions: true,
    });
};
