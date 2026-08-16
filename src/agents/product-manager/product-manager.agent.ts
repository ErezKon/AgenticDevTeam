import { buildAgent } from '../_shared/agent-factory';
import { productManagerSystemPrompt } from './product-manager.prompt';
import { ProductManagerOutputSchema } from './schemas/pm-output.schema';
import { PRODUCT_MANAGER_MODEL, PLANNING_MAX_OUTPUT_TOKENS } from '../../config';

export const createProductManagerAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'product-manager',
        systemPrompt: productManagerSystemPrompt,
        tools: [],
        responseFormat: ProductManagerOutputSchema,
        temperature: 0.3,
        model: PRODUCT_MANAGER_MODEL,
        maxOutputTokens: PLANNING_MAX_OUTPUT_TOKENS,
        keepSchemaDescriptions: true,
        topK: undefined,
        topP: undefined
    });
};
