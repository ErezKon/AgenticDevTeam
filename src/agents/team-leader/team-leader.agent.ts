import { buildAgent } from '../_shared/agent-factory';
import { teamLeaderSystemPrompt } from './team-leader.prompt';
import { TeamLeaderOutputSchema } from './schemas/tl-output.schema';

export const createTeamLeaderAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'team-leader',
        systemPrompt: teamLeaderSystemPrompt,
        tools: [],
        responseFormat: TeamLeaderOutputSchema,
        temperature: 0.2,
    });
};
