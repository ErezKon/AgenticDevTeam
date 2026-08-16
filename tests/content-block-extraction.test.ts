/**
 * Content-block text extraction — the guard against silently empty phases.
 *
 * Two providers return `AIMessage.content` as an array of content blocks
 * instead of a plain string:
 *   - Anthropic with `streaming: true`  -> `[{ type: 'text', text: '...' }]`
 *   - OpenAI Responses API (`*codex*`)  -> `[{ type: 'text', text: '...', annotations: [] }]`
 *
 * A `typeof content === 'string'` guard therefore bypassed JSON parsing AND
 * schema validation for those providers, so `architectNode` wrote a mission
 * report full of `undefined` while reporting no error at all (the codex/sonnet
 * architect failures). These tests pin the extraction contract.
 */
import {
    extractTextFromContentBlocks,
    extractAgentText,
    describeContentBlocks,
    normaliseContentToString,
} from '../src/utils/structured-output';

const aiMsg = (content: unknown, extra: Record<string, unknown> = {}) => ({
    _getType: () => 'ai',
    content,
    ...extra,
});

const toolMsg = (content: unknown) => ({ _getType: () => 'tool', content });

describe('extractTextFromContentBlocks', () => {
    it('extracts text from the OpenAI Responses API block shape', () => {
        const content = [{ type: 'text', text: '{"architecture":{}}', annotations: [] }];
        expect(extractTextFromContentBlocks(content)).toBe('{"architecture":{}}');
    });

    it('extracts and concatenates Anthropic streaming text blocks', () => {
        const content = [
            { type: 'text', text: '{"epics":' },
            { type: 'text', text: '[]}' },
        ];
        expect(extractTextFromContentBlocks(content)).toBe('{"epics":[]}');
    });

    it('accepts the raw Responses-API output_text block type', () => {
        expect(extractTextFromContentBlocks([{ type: 'output_text', text: '{"a":1}' }])).toBe('{"a":1}');
    });

    it('skips reasoning and thinking blocks so they cannot corrupt the payload', () => {
        const content = [
            { type: 'reasoning', reasoning: 'Let me think about the layers…' },
            { type: 'thinking', thinking: 'more thoughts' },
            { type: 'text', text: '{"ok":true}' },
        ];
        expect(extractTextFromContentBlocks(content)).toBe('{"ok":true}');
    });

    it('returns null for a reasoning-only response (no payload at all)', () => {
        expect(extractTextFromContentBlocks([{ type: 'reasoning', reasoning: 'thinking…' }])).toBeNull();
    });

    it('returns null for tool-call content and for whitespace-only text', () => {
        expect(extractTextFromContentBlocks([{ type: 'tool_use', id: 't1', input: {} }])).toBeNull();
        expect(extractTextFromContentBlocks([{ type: 'text', text: '   \n ' }])).toBeNull();
    });

    it('returns null for non-array content', () => {
        expect(extractTextFromContentBlocks('plain string')).toBeNull();
        expect(extractTextFromContentBlocks(null)).toBeNull();
    });
});

describe('extractAgentText', () => {
    it('reads a plain string final message', () => {
        const res = extractAgentText([aiMsg('{"a":1}')]);
        expect(res).toMatchObject({ text: '{"a":1}', source: 'string', messageIndex: 0 });
    });

    it('reads content blocks from the final message (regression: architect empty output)', () => {
        const res = extractAgentText([
            { _getType: () => 'human', content: 'requirements' },
            aiMsg([{ type: 'text', text: '{"architecture":{"style":"layered"}}', annotations: [] }]),
        ]);
        expect(res.source).toBe('content-blocks');
        expect(JSON.parse(res.text!)).toEqual({ architecture: { style: 'layered' } });
    });

    it('falls back to the last AI message when the final message is empty', () => {
        const res = extractAgentText([
            aiMsg('{"status":"pass"}'),
            aiMsg(''),
        ]);
        expect(res).toMatchObject({ text: '{"status":"pass"}', source: 'earlier-message', messageIndex: 0 });
    });

    it('never adopts tool output as the agent payload', () => {
        const res = extractAgentText([
            toolMsg('{"file":"contents of some file"}'),
            aiMsg([{ type: 'reasoning', reasoning: 'thinking…' }]),
        ]);
        expect(res.text).toBeNull();
        expect(res.source).toBe('none');
    });

    it('reports the block census when nothing usable is found', () => {
        const res = extractAgentText([aiMsg([{ type: 'reasoning', reasoning: 'x' }, { type: 'reasoning', reasoning: 'y' }])]);
        expect(res.text).toBeNull();
        expect(res.blockTypes).toBe('reasoning×2');
    });

    it('flags provider-side truncation by the output-token limit', () => {
        const cut = extractAgentText([aiMsg('{"partial":', { response_metadata: { finish_reason: 'length' } })]);
        expect(cut.truncatedByTokenLimit).toBe(true);

        const ok = extractAgentText([aiMsg('{}', { response_metadata: { finish_reason: 'stop' } })]);
        expect(ok.truncatedByTokenLimit).toBe(false);
    });

    it('handles missing / empty message lists without throwing', () => {
        expect(extractAgentText(undefined)).toMatchObject({ text: null, source: 'none', messageIndex: -1 });
        expect(extractAgentText([])).toMatchObject({ text: null, source: 'none' });
    });
});

describe('describeContentBlocks', () => {
    it('summarises block types with counts', () => {
        expect(describeContentBlocks([{ type: 'text', text: 'a' }, { type: 'reasoning' }, { type: 'reasoning' }]))
            .toBe('text×1, reasoning×2');
    });

    it('describes strings and empty arrays distinctly', () => {
        expect(describeContentBlocks('abc')).toBe('string(3 chars)');
        expect(describeContentBlocks([])).toBe('empty array');
    });
});

/**
 * Uses the REAL @langchain/openai converter (pure, no network) to prove the
 * premise of every test above: a Responses-API reply — which is what any
 * `*codex*` / `gpt-5.x-pro` model gets, per `_modelPrefersResponsesAPI` — lands
 * in `AIMessage.content` as an ARRAY, so a `typeof content === 'string'` guard
 * can never see it.
 */
describe('real OpenAI Responses-API conversion', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { convertResponsesMessageToAIMessage } = require('@langchain/openai');

    const responsesReply = (outputs: unknown[]) => ({
        id: 'resp_1', model: 'gpt-5.3-codex', created_at: 0, status: 'completed',
        object: 'response', output: outputs,
        usage: { input_tokens: 5795, output_tokens: 5020, total_tokens: 10815 },
    });

    it('puts the payload in a content-block array, never a string', () => {
        const msg: any = convertResponsesMessageToAIMessage(responsesReply([{
            type: 'message', role: 'assistant', status: 'completed', phase: null,
            content: [{ type: 'output_text', text: '{"architecture":{"style":"layered"}}', annotations: [] }],
        }]));

        expect(typeof msg.content).not.toBe('string');
        expect(Array.isArray(msg.content)).toBe(true);
        expect(extractAgentText([msg]).text).toBe('{"architecture":{"style":"layered"}}');
    });

    it('yields no text at all for a reasoning-only reply', () => {
        const msg: any = convertResponsesMessageToAIMessage(responsesReply([{
            type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Thinking about layers.' }],
        }]));

        const res = extractAgentText([msg]);
        expect(res.text).toBeNull();
        expect(res.blockTypes).toBe('reasoning×1');
    });
});

describe('normaliseContentToString', () => {
    it('prefers extracted text over JSON.stringify of the blocks', () => {
        expect(normaliseContentToString([{ type: 'text', text: '{"a":1}' }])).toBe('{"a":1}');
    });

    it('falls back to JSON.stringify for shapes with no text', () => {
        expect(normaliseContentToString([{ type: 'tool_use', id: 't1' }])).toBe('[{"type":"tool_use","id":"t1"}]');
    });
});
