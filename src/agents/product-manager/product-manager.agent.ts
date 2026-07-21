import { buildAgent } from '../_shared/agent-factory';
import { productManagerSystemPrompt } from './product-manager.prompt';
import { ProductManagerOutputSchema } from './schemas/pm-output.schema';
import { emitMermaidTool } from '../../tools/diagram/diagram-tools';

export const createProductManagerAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'product-manager',
        systemPrompt: productManagerSystemPrompt,
        tools: [emitMermaidTool],
        responseFormat: ProductManagerOutputSchema,
        temperature: 0.3,
    });
};
