/**
 * Streaming-residue sanitiser completion and state normalisation
 * (Plan 22, E1/E2).
 *
 * ## The bugs these tests pin
 *
 * E1 — every Anthropic AIMessageChunk in the pacmanclaude dumps has this shape:
 *
 *   { "type": "tool_use", "id": "toolu_…", "name": "read_file", "input": "" }
 *   { "index": 1, "type": "input_json_delta", "input": "{\"filePath\": \"README.md\"}" }
 *
 * The old sanitiser dropped the delta but KEPT the `tool_use` block, because it
 * only checked for a missing id. The model's own history therefore showed it
 * calling `read_file` with no arguments at all.
 *
 * E2 — the sanitiser works on a copy by design, so residue accumulated in the
 * checkpoint and was re-scanned every turn. That is why the log shows
 * `dropped 2 … dropped 31` growing monotonically inside one invocation.
 */
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';

jest.mock('../src/config', () => ({
    HISTORY_KEEP_RECENT_TOOL_RESULTS: 4,
    HISTORY_KEEP_RECENT_TURNS: 3,
    HISTORY_KEEP_RECENT_WRITE_ARGS: 2,
    HISTORY_MAX_CHARS: 1_000_000,
}));

import {
    sanitizeStreamingContentBlocks, normaliseAIMessageForState,
} from '../src/agents/_shared/history-compactor';

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
    return (m.content as any[]).map(b => b.type);
}

// ─── E1 ─────────────────────────────────────────────────────────────────────

describe('sanitizeStreamingContentBlocks (Plan 22 E1)', () => {
    it('drops both the deltas AND the argument-less tool_use blocks', () => {
        const { messages, blocksDropped } = sanitizeStreamingContentBlocks([anthropicChunk()]);

        // 2 tool_use with empty input + 2 input_json_delta = 4 blocks removed.
        expect(blocksDropped).toBe(4);
        expect(blockTypes(messages[0])).toEqual(['text']);
    });

    it('keeps tool_calls so the provider adapter re-materialises the calls', () => {
        const { messages } = sanitizeStreamingContentBlocks([anthropicChunk()]);
        const out = messages[0] as AIMessage;

        expect(out.tool_calls).toHaveLength(2);
        expect(out.tool_calls!.map(t => t.args.filePath)).toEqual(['README.md', '.gitignore']);
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

    it('drops id-less tool_use blocks (Plan 21 behaviour, preserved)', () => {
        const m = new AIMessageChunk({
            content: [
                { type: 'text', text: 'hi' },
                { type: 'tool_use', id: '', name: 'read_file', input: { filePath: 'a' } },
            ] as any,
        });
        const { messages, blocksDropped } = sanitizeStreamingContentBlocks([m]);
        expect(blocksDropped).toBe(1);
        expect(blockTypes(messages[0])).toEqual(['text']);
    });

    it('leaves a clean message untouched by identity', () => {
        const clean = new AIMessage({
            content: [{ type: 'text', text: 'done' }] as any,
        });
        const input = [new HumanMessage('task'), clean, new ToolMessage({ content: 'x', tool_call_id: 't' })];

        const { messages, blocksDropped } = sanitizeStreamingContentBlocks(input);
        expect(blocksDropped).toBe(0);
        expect(messages).toBe(input);
    });

    it('never mutates the input messages', () => {
        const chunk = anthropicChunk();
        const before = (chunk.content as any[]).length;
        sanitizeStreamingContentBlocks([chunk]);
        expect((chunk.content as any[]).length).toBe(before);
    });
});

// ─── E2 ─────────────────────────────────────────────────────────────────────

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
        // Simulate 5 turns. Without state normalisation the drop count grows every
        // turn because the same residue is re-scanned; with it, each turn only ever
        // has its own fresh chunk to clean.
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
            history.push(anthropicChunk());          // persisted raw, as before
            history.push(new ToolMessage({ content: 'ok', tool_call_id: `t${turn}` }));
            dropCounts.push(sanitizeStreamingContentBlocks(history).blocksDropped);
        }

        expect(dropCounts).toEqual([4, 8, 12, 16, 20]);
    });
});
