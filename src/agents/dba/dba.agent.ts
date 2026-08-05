import { buildAgent } from '../_shared/agent-factory';
import { dbaSystemPrompt } from './dba.prompt';
import { DbaOutputSchema } from './schemas/dba-output.schema';
import { DBA_MODEL } from '../../config';

export const createDbaAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'dba',
        systemPrompt: dbaSystemPrompt,
        tools: [],
        responseFormat: DbaOutputSchema,
        temperature: 0.2,
        model: DBA_MODEL,
    });
};
