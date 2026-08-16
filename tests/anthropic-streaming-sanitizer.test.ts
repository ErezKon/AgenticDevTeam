/**
 * Streaming content-block sanitiser — unit tests (Plan 21, sub-plan A2).
 *
 * Reproduces the exact corrupt message shape from langchainjs issue #9798:
 * a streamed `AIMessage` whose `content` array still carries `input_json_delta`
 * blocks and a `tool_use` block with an empty `id`. Re-sending that verbatim
 * produced `400 … messages.N.content.M.tool_use.id: Field required` and killed
 * every dev/reviewer agent in the pacmanclaude run.
 *
 * Pure: no LLM, no git, no network.
 */
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { sanitizeStreamingContentBlocks, compactHistory } from '../src/agents/_shared/history-compactor';

/** The corrupt assistant message produced by streamed chunk reassembly. */
function corruptAssistantMessage(): AIMessage {
    return new AIMessage({
        content: [
            { type: 'text', text: 'Writing the two files now.' },
            { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.ts' } },
            { type: 'input_json_delta', partial_json: '{"path":"a' },
            { type: 'input_json_delta', partial_json: '.ts"}' },
            { type: 'tool_use', id: 'toolu_2', name: 'write_file', input: { path: 'b.ts' } },
            { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' },
        ] as any,
        tool_calls: [
            { id: 'toolu_1', name: 'write_file', args: { path: 'a.ts' } },
            { id: 'toolu_2', name: 'write_file', args: { path: 'b.ts' } },
        ],
    });
}

describe('sanitizeStreamingContentBlocks', () => {
    it('drops input_json_delta blocks and keeps the tool_use blocks', () => {
        const messages = [
            new HumanMessage('Create a.ts and b.ts'),
            corruptAssistantMessage(),
            new ToolMessage({ content: 'written', tool_call_id: 'toolu_1', name: 'write_file' }),
            new ToolMessage({ content: 'written', tool_call_id: 'toolu_2', name: 'write_file' }),
        ];

        const { messages: clean, blocksDropped } = sanitizeStreamingContentBlocks(messages);

        expect(blocksDropped).toBe(3);
        const content = clean[1].content as any[];
        expect(content).toHaveLength(3);
        expect(content.map(b => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
        expect(content.filter(b => b.type === 'tool_use').map(b => b.id)).toEqual(['toolu_1', 'toolu_2']);
    });

    it('drops tool_use blocks with a missing or empty id', () => {
        const messages = [
            new AIMessage({
                content: [
                    { type: 'tool_use', id: '', name: 'read_file', input: {} },
                    { type: 'tool_use', name: 'read_file', input: {} },
                    { type: 'server_tool_use', id: '', name: 'web_search', input: {} },
                    { type: 'tool_use', id: 'toolu_ok', name: 'read_file', input: {} },
                ] as any,
            }),
        ];

        const { messages: clean, blocksDropped } = sanitizeStreamingContentBlocks(messages);

        expect(blocksDropped).toBe(3);
        expect(clean[0].content as any[]).toEqual([
            { type: 'tool_use', id: 'toolu_ok', name: 'read_file', input: {} },
        ]);
    });

    it('preserves tool_calls so the provider adapter can re-materialise blocks', () => {
        const { messages: clean } = sanitizeStreamingContentBlocks([corruptAssistantMessage()]);
        expect((clean[0] as AIMessage).tool_calls).toEqual([
            { id: 'toolu_1', name: 'write_file', args: { path: 'a.ts' } },
            { id: 'toolu_2', name: 'write_file', args: { path: 'b.ts' } },
        ]);
    });

    it('never mutates the input messages (state stays intact)', () => {
        const original = corruptAssistantMessage();
        const before = JSON.stringify(original.content);

        sanitizeStreamingContentBlocks([new HumanMessage('task'), original]);

        expect(JSON.stringify(original.content)).toBe(before);
        expect((original.content as any[])).toHaveLength(6);
    });

    it('is a no-op for clean histories (returns the same array reference)', () => {
        const messages = [
            new HumanMessage('task'),
            new AIMessage('plain string content'),
            new AIMessage({ content: [{ type: 'text', text: 'ok' }] as any }),
        ];
        const result = sanitizeStreamingContentBlocks(messages);
        expect(result.blocksDropped).toBe(0);
        expect(result.messages).toBe(messages);
    });

    it('leaves non-AI messages untouched', () => {
        const tool = new ToolMessage({ content: 'result', tool_call_id: 'toolu_1', name: 'read_file' });
        const { messages: clean } = sanitizeStreamingContentBlocks([tool]);
        expect(clean[0]).toBe(tool);
    });

    it('composes with compactHistory to yield a clean, sendable history', () => {
        const messages = [
            new HumanMessage('Create a.ts and b.ts'),
            corruptAssistantMessage(),
            new ToolMessage({ content: 'x'.repeat(5000), tool_call_id: 'toolu_1', name: 'write_file' }),
            new ToolMessage({ content: 'y'.repeat(5000), tool_call_id: 'toolu_2', name: 'write_file' }),
            new AIMessage({ content: [{ type: 'text', text: 'done' }] as any }),
        ];

        const sanitized = sanitizeStreamingContentBlocks(messages);
        const { messages: compacted } = compactHistory(sanitized.messages, { keepRecent: 1, maxChars: 100_000 });

        for (const m of compacted) {
            if (!Array.isArray(m.content)) continue;
            for (const block of m.content as any[]) {
                expect(block.type).not.toMatch(/_delta$/);
                if (block.type === 'tool_use') expect(block.id).toBeTruthy();
            }
        }
        // Original state is still untouched by either pass.
        expect((messages[1].content as any[])).toHaveLength(6);
    });
});
