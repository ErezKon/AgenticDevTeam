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
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';

jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    HISTORY_KEEP_RECENT_TOOL_RESULTS: 4,
    HISTORY_KEEP_RECENT_TURNS: 3,
    HISTORY_KEEP_RECENT_WRITE_ARGS: 2,
    HISTORY_MAX_CHARS: 1_000_000,
}));

import { sanitizeStreamingContentBlocks, compactHistory, normaliseAIMessageForState } from '../src/agents/_shared/history-compactor';

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

    it('reconstructs input from sibling deltas when there is no matching tool_call', () => {
        // Corrupt history restored from a checkpoint: content blocks survived but
        // tool_calls did not. Dropping the tool_use here would lose the call.
        const orphan = new AIMessageChunk({
            content: [
                { index: 1, type: 'tool_use', id: 'toolu_X', name: 'read_file', input: '' },
                { index: 1, type: 'input_json_delta', input: '{"filePath": "src/a.ts"}' },
            ] as any,
        });

        const { messages } = sanitizeStreamingContentBlocks([orphan]);
        const blocks = messages[0].content as any[];

        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe('tool_use');
        expect(blocks[0].input).toEqual({ filePath: 'src/a.ts' });
    });
});

// ─── normaliseAIMessageForState (Plan 22 E2) ────────────────────────────────

/** The exact block layout observed in full-responses/006. */
function anthropicChunk() {
    return new AIMessageChunk({
        content: [
            { index: 0, type: 'text', text: "I'll inspect the workspace." },
            { index: 1, type: 'tool_use', id: 'toolu_A', name: 'read_file', input: '' },
            { index: 1, type: 'input_json_delta', input: '{"filePath": "README.md"}' },
            { index: 2, type: 'tool_use', id: 'toolu_B', name: 'read_file', input: '' },
            { index: 2, type: 'input_json_delta', input: '{"filePath": ".gitignore"}' },
        ] as any,
        tool_calls: [
            { id: 'toolu_A', name: 'read_file', args: { filePath: 'README.md' }, type: 'tool_call' },
            { id: 'toolu_B', name: 'read_file', args: { filePath: '.gitignore' }, type: 'tool_call' },
        ],
    });
}

function blockTypes(m: any): string[] {
    return (m.content as any[]).map((b: any) => b.type);
}

describe('normaliseAIMessageForState (Plan 22 E2)', () => {
    it('returns a clean AIMessage for a residue-bearing chunk', () => {
        const clean = normaliseAIMessageForState(anthropicChunk()) as AIMessage;

        expect(blockTypes(clean)).toEqual(['text']);
        expect(clean.tool_calls).toHaveLength(2);
    });

    it('returns the same object when there is nothing to clean', () => {
        const m = new AIMessage({ content: [{ type: 'text', text: 'ok' }] as any });
        expect(normaliseAIMessageForState(m)).toBe(m);
    });

    it('passes through non-AI and string-content messages unchanged', () => {
        const human = new HumanMessage('task');
        const stringAi = new AIMessage('plain text');
        expect(normaliseAIMessageForState(human)).toBe(human);
        expect(normaliseAIMessageForState(stringAi)).toBe(stringAi);
    });

    it('stops the monotonic residue growth seen in the run log', () => {
        const history: any[] = [new HumanMessage('task')];
        const dropCounts: number[] = [];

        for (let turn = 0; turn < 5; turn++) {
            history.push(normaliseAIMessageForState(anthropicChunk()));
            history.push(new ToolMessage({ content: 'ok', tool_call_id: `t${turn}` }));
            dropCounts.push(sanitizeStreamingContentBlocks(history).blocksDropped);
        }

        expect(dropCounts).toEqual([0, 0, 0, 0, 0]);
    });

    it('would grow monotonically without normalisation — the observed bug', () => {
        const history: any[] = [new HumanMessage('task')];
        const dropCounts: number[] = [];

        for (let turn = 0; turn < 5; turn++) {
            history.push(anthropicChunk());
            history.push(new ToolMessage({ content: 'ok', tool_call_id: `t${turn}` }));
            dropCounts.push(sanitizeStreamingContentBlocks(history).blocksDropped);
        }

        expect(dropCounts).toEqual([4, 8, 12, 16, 20]);
    });
});
