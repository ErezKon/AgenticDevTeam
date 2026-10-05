/**
 * What the model request really carries (Plan 30-06): a fake global `fetch`
 * captures the body the provider SDK sends for an agent built by buildAgent().
 *
 *   - Anthropic: automatic caching (top-level `cache_control`) plus the system
 *     and task breakpoints, never more than 4; no `cache_control` for OpenAI.
 *   - Soft landing: once the invocation has spent its effective-token budget, the
 *     next call can use no tool — Anthropic keeps the definitions (they head the
 *     cached prefix) with `tool_choice: none`; OpenAI-compatible calls get no tools.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_BASE_URL: '',
    OPENAI_API_KEY: 'sk-openai-test',
    LLM_BASE_URL: 'https://llm.test/v1',
    LLM_PROVIDER_DETECTION: 'auto',
    DEBUG_MODE: false,
    ANTHROPIC_PROMPT_CACHE_ENABLED: true,
    ANTHROPIC_AUTO_CACHE: true,
    HISTORY_COMPACTION_ENABLED: true,
    HISTORY_COMPACTION_MODE: 'epoch',
    INVOCATION_SOFT_LANDING_EFFECTIVE_TOKENS: 350_000,
    MAX_INVOCATION_INPUT_TOKENS: 1_500_000,
}));
jest.mock('../src/utils/logger');

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildAgent } from '../src/agents/_shared/agent-factory';
import { tokenTracker } from '../src/utils/token-tracker';

const readFile = tool(async () => 'file body', {
    name: 'read_file', description: 'Read a file', schema: z.object({ filePath: z.string() }),
});

/** A streamed Anthropic reply whose only content is `text`. */
function anthropicReply(text: string): Response {
    const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
    ];
    const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A non-streamed OpenAI chat completion whose only content is `text`. */
function openaiReply(text: string): Response {
    return new Response(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-oss-120b',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Request bodies sent to a model endpoint, in order. */
let bodies: any[] = [];

function fakeFetch(reply: () => Response): void {
    bodies = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        const href = typeof url === 'string' ? url : (url?.url ?? url?.href ?? String(url));
        // Anything else (e.g. tracing) gets an empty success and is not recorded
        if (!/\/v1\/messages|\/chat\/completions/.test(href)) {
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        bodies.push(JSON.parse(String(init?.body)));
        return reply();
    });
}

async function run(model: string, invocationId?: string) {
    const agent = buildAgent('unused-oauth-token', {
        id: `provider-request-${model}`, systemPrompt: 'You are a developer.', tools: [readFile], model,
        phase: 'development', toolBudgets: { reads: 5, writes: 5, shell: 5, turns: 5 },
    });
    if (invocationId) agent.setInvocationId(invocationId);
    await (agent as any).invoke(
        { messages: [{ role: 'user', content: 'Build the board.' }] },
        { configurable: { thread_id: `t-${model}-${Date.now()}` } },
    );
    return agent;
}

/** An invocation that has already spent 400k effective input tokens (no caching: effective = raw). */
function spentInvocation(model: string): string {
    const id = tokenTracker.startInvocation('provider-request-dev', 'development');
    tokenTracker.recordCall({
        agentId: 'provider-request-dev', model, phase: 'development',
        inputTokens: 400_000, outputTokens: 0, totalTokens: 400_000, timestamp: '', invocationId: id,
    });
    return id;
}

afterEach(() => tokenTracker.reset());

describe('Anthropic prompt cache in the request (Plan 30-06)', () => {
    it('sends automatic caching plus the system and task breakpoints — at most 4 in total', async () => {
        fakeFetch(() => anthropicReply('{"done":true}'));
        await run('claude-haiku-4-5');

        expect(bodies).toHaveLength(1);
        const [body] = bodies;
        expect(body.cache_control).toEqual({ type: 'ephemeral' });
        expect(body.system[body.system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
        expect(JSON.stringify(body.messages[0])).toContain('"cache_control"');
        const explicit = (JSON.stringify([body.tools, body.system, body.messages]).match(/"cache_control"/g) ?? []).length;
        expect(explicit + 1).toBeLessThanOrEqual(4);
    });

    it('sends no cache_control to an OpenAI-compatible model', async () => {
        fakeFetch(() => openaiReply('{"done":true}'));
        await run('gpt-oss-120b');

        expect(bodies).toHaveLength(1);
        expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
    });
});

describe('soft landing in the request (Plan 30-06)', () => {
    it('Anthropic: keeps the tool definitions but forbids tool use on the next call', async () => {
        fakeFetch(() => anthropicReply('{"done":true}'));
        const agent = await run('claude-haiku-4-5', spentInvocation('claude-haiku-4-5'));

        expect(bodies[0].tool_choice).toEqual({ type: 'none' });
        expect(bodies[0].tools).toHaveLength(1);
        expect(agent.softLanding()).toContain('effective input tokens');
    });

    it('OpenAI-compatible: sends the next call without tools and without tool_choice', async () => {
        fakeFetch(() => openaiReply('{"done":true}'));
        const agent = await run('gpt-oss-120b', spentInvocation('gpt-oss-120b'));

        expect(bodies[0].tools).toBeUndefined();
        expect(bodies[0].tool_choice).toBeUndefined();
        expect(agent.softLanding()).not.toBeNull();
    });

    it('below the threshold nothing is withheld', async () => {
        fakeFetch(() => anthropicReply('{"done":true}'));
        const agent = await run('claude-haiku-4-5', tokenTracker.startInvocation('provider-request-dev', 'development'));

        expect(bodies[0].tool_choice).toBeUndefined();
        expect(bodies[0].tools).toHaveLength(1);
        expect(agent.softLanding()).toBeNull();
    });
});
