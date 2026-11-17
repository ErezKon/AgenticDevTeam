/**
 * Cache-stable "epoch" history compaction (Plan 30-06).
 *
 * The sliding compactor rewrote the history on every call (the recent window
 * moved, results turned into stubs), so the prompt prefix changed every turn
 * and the conversation was never read from the prompt cache. An epoch compactor
 * freezes its compacted view and only appends to it until a trigger fires.
 */
jest.mock('../src/config', () => ({
    HISTORY_KEEP_RECENT_TOOL_RESULTS: 1,
    HISTORY_KEEP_RECENT_TURNS: 2,
    HISTORY_KEEP_RECENT_WRITE_ARGS: 0,
    HISTORY_MAX_CHARS: 1_000_000,
    HISTORY_EPOCH_MAX_TURNS: 3,
    HISTORY_EPOCH_TARGET_CHARS: 600_000,
}));

import { AIMessage, HumanMessage, ToolMessage, isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createEpochCompactor } from '../src/agents/_shared/history-epoch';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TASK = new HumanMessage({ content: 'Implement the board component', id: 'task-1' });

/** One model turn: an AI message calling read_file, and its result (`size` chars). */
function turn(t: number, size: number): BaseMessage[] {
    return [
        new AIMessage({
            content: `turn ${t}`, id: `ai-${t}`,
            tool_calls: [{ id: `tc-${t}`, name: 'read_file', args: { filePath: `src/f${t}.ts` }, type: 'tool_call' }],
        }),
        new ToolMessage({ content: 'x'.repeat(size), tool_call_id: `tc-${t}`, name: 'read_file', id: `tool-${t}` }),
    ];
}

/** The task plus `turns` turns. Fresh message objects on every call, as graph state delivers them. */
function history(turns: number, size = 500, task: BaseMessage = TASK): BaseMessage[] {
    const out: BaseMessage[] = [task];
    for (let t = 1; t <= turns; t++) out.push(...turn(t, size));
    return out;
}

/** Every tool call has its result in the view, and every result its call. */
function pairsIntact(messages: BaseMessage[]): boolean {
    const resultIds = messages.filter(isToolMessage).map(m => m.tool_call_id);
    const callIds = messages.flatMap(m => (isAIMessage(m) ? (m.tool_calls ?? []).map(tc => tc.id) : []));
    return callIds.every(id => resultIds.includes(id!)) && resultIds.every(id => callIds.includes(id));
}

const sameObjects = (a: BaseMessage[], b: BaseMessage[]): boolean => a.length === b.length && a.every((m, i) => m === b[i]);

/** What the provider receives for each message (graph state hands over fresh objects every step). */
const serialize = (messages: BaseMessage[]): string[] => messages.map(m => JSON.stringify({
    type: m.getType(), content: m.content,
    toolCalls: isAIMessage(m) ? m.tool_calls : undefined, toolCallId: isToolMessage(m) ? m.tool_call_id : undefined,
}));

let thread = 0;
const compactor = (opts: Parameters<typeof createEpochCompactor>[0] = {}) =>
    createEpochCompactor({ maxChars: 1_000_000, maxTurns: 3, targetChars: 600_000, keepRecentTurns: 2, threadId: `epoch-${++thread}`, ...opts });

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createEpochCompactor (Plan 30-06)', () => {
    it('sends the raw history unchanged until a trigger fires', () => {
        const compact = compactor();
        const raw = history(3);
        const out = compact(raw);
        expect(out.recompacted).toBe(false);
        expect(out.messages).toBe(raw);
        expect(out.stubbedToolCallIds).toEqual([]);
    });

    it('recompacts once more than maxTurns turns were appended, keeping the recent turns verbatim', () => {
        const compact = compactor();
        const out = compact(history(4));

        expect(out.recompacted).toBe(true);
        // keepRecentTurns 2 → turns 3–4 verbatim, turns 1–2 stubbed
        expect(out.stubbedToolCallIds).toEqual(['tc-1', 'tc-2']);
        expect(out.stats.toolResultsStubbed).toBe(2);
        expect(out.messages[0]).toBe(TASK);
        expect(pairsIntact(out.messages)).toBe(true);
    });

    it('two consecutive calls send an identical prefix: the frozen view, then only the new messages', () => {
        const compact = compactor();
        const first = compact(history(4));
        const raw5 = history(5);
        const second = compact(raw5);

        expect(second.recompacted).toBe(false);
        expect(sameObjects(second.messages.slice(0, first.messages.length), first.messages)).toBe(true);
        // The appended tail is the raw new turn, verbatim
        expect(second.messages.slice(first.messages.length).map(m => m.id)).toEqual(['ai-5', 'tool-5']);
        expect(second.stubbedToolCallIds).toEqual([]);

        // The next call's request extends this one byte for byte
        const third = compact(history(6));
        expect(serialize(third.messages).slice(0, second.messages.length)).toEqual(serialize(second.messages));
        expect(sameObjects(third.messages.slice(0, first.messages.length), first.messages)).toBe(true);
        expect(pairsIntact(third.messages)).toBe(true);
    });

    it('starts the next epoch after maxTurns more turns', () => {
        const compact = compactor();
        expect(compact(history(4)).recompacted).toBe(true);    // epoch frozen at turn 4
        for (const turns of [5, 6, 7]) expect(compact(history(turns)).recompacted).toBe(false);
        const next = compact(history(8));                       // 4 turns appended since
        expect(next.recompacted).toBe(true);
        expect(next.stubbedToolCallIds).toEqual(['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5', 'tc-6']);
        expect(pairsIntact(next.messages)).toBe(true);
    });

    it('recompacts when the view exceeds maxChars, dropping whole pairs but never the recent turns', () => {
        // 3 turns (≤ maxTurns) of 2,000-char results: ~6.3k chars > maxChars 5k
        const compact = compactor({ maxChars: 5_000, targetChars: 3_500 });
        const out = compact(history(3, 2_000));

        expect(out.recompacted).toBe(true);
        expect(out.stubbedToolCallIds).toEqual(['tc-1']);
        expect(out.stats.compactedChars).toBeLessThan(out.stats.originalChars);
        const ids = out.messages.map(m => m.id);
        expect(ids).not.toContain('ai-1');                       // the stubbed pair was dropped whole
        expect(ids).toEqual(expect.arrayContaining(['ai-2', 'tool-2', 'ai-3', 'tool-3']));
        expect(pairsIntact(out.messages)).toBe(true);
    });

    it('a new task (different first message) starts over', () => {
        const compact = compactor();
        expect(compact(history(4)).recompacted).toBe(true);
        const otherTask = new HumanMessage({ content: 'Fix the bug', id: 'task-2' });
        const raw = history(1, 500, otherTask);
        const out = compact(raw);
        expect(out.recompacted).toBe(false);
        expect(out.messages).toBe(raw);
    });

    it('a history that no longer extends the frozen one starts over', () => {
        const compact = compactor();
        compact(history(4));
        // Same task, but the message the epoch ended on is gone (e.g. a different thread)
        const diverged = [TASK, ...turn(9, 500)];
        const out = compact(diverged);
        expect(out.recompacted).toBe(false);
        expect(out.messages).toBe(diverged);
    });
});
