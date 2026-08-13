import { buildAgent } from '../_shared/agent-factory';
import { teamLeaderSystemPrompt } from './team-leader.prompt';
import { TeamLeaderOutputSchema } from './schemas/tl-output.schema';
import { TEAM_LEADER_MODEL, PLANNING_MAX_OUTPUT_TOKENS } from '../../config';

export const createTeamLeaderAgent = (apiKey: string) => {
    return buildAgent(apiKey, {
        id: 'team-leader',
        systemPrompt: teamLeaderSystemPrompt,
        tools: [],
        responseFormat: TeamLeaderOutputSchema,
        temperature: 0.2,
        model: TEAM_LEADER_MODEL,
        maxOutputTokens: PLANNING_MAX_OUTPUT_TOKENS,
        keepSchemaDescriptions: true,
    });
};
