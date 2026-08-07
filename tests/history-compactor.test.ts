/**
 * History compactor — unit tests for Step 3 of the token-reduction plan.
 *
 * Exercises compactHistory: passthrough under budget, stubbing of old tool
 * results and write args, the keepRecent boundary, the hard ceiling drop,
 * and the critical provider-validity invariant (every AIMessage with
 * tool_calls must have matching ToolMessages).
 */

// Mock config so tests are deterministic regardless of .env
jest.mock('../src/config', () => ({
    HISTORY_KEEP_RECENT_TOOL_RESULTS: 3,
    HISTORY_MAX_CHARS: 40000,
}));

import {
    AIMessage,
    HumanMessage,
    ToolMessage,
    type BaseMessage,
} from '@langchain/core/messages';
import { compactHistory } from '../src/agents/_shared/history-compactor';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a simple HumanMessage (the "task" message). */
function taskMsg(text = 'Implement the Board component'): HumanMessage {
    return new HumanMessage(text);
}

/** Build an AIMessage with a single tool call. */
function aiToolCall(
    toolName: string,
    args: Record<string, unknown>,
    id: string,
    content = '',
): AIMessage {
    return new AIMessage({
        content,
        tool_calls: [{ id, name: toolName, args, type: 'tool_call' }],
        id: `ai-${id}`,
    });
}

/** Build a ToolMessage result. */
function toolResult(content: string, toolCallId: string, name: string): ToolMessage {
    return new ToolMessage({ content, tool_call_id: toolCallId, name });
}

/**
 * Build a realistic ReAct history with N tool-call rounds.
 * Each round: AIMessage(tool_call) + ToolMessage(result).
 */
function buildHistory(
    rounds: number,
    resultSize = 5000,
    opts?: { writeRounds?: number[] },
): BaseMessage[] {
    const messages: BaseMessage[] = [taskMsg()];
    for (let i = 0; i < rounds; i++) {
        const id = `tc-${i}`;
        const isWriteRound = opts?.writeRounds?.includes(i);
        if (isWriteRound) {
            messages.push(aiToolCall('write_file', {
                filePath: `src/file-${i}.ts`,
                content: 'x'.repeat(resultSize),
            }, id, `Writing file ${i}`));
            messages.push(toolResult(`File written: src/file-${i}.ts`, id, 'write_file'));
        } else {
            messages.push(aiToolCall('read_file', { filePath: `src/file-${i}.ts` }, id, `Reading file ${i}`));
            messages.push(toolResult('a'.repeat(resultSize), id, 'read_file'));
        }
    }
    return messages;
}

/** Validate the provider invariant: every tool_call id has a matching ToolMessage. */
function validateToolCallPairing(messages: BaseMessage[]): { valid: boolean; missing: string[] } {
    const expectedIds: string[] = [];
    const foundIds = new Set<string>();

    for (const m of messages) {
        if (m._getType() === 'ai') {
            const ai = m as AIMessage;
            if (ai.tool_calls?.length) {
                for (const tc of ai.tool_calls) {
                    expectedIds.push(tc.id!);
                }
            }
        }
        if (m._getType() === 'tool') {
            foundIds.add((m as ToolMessage).tool_call_id);
        }
    }

    const missing = expectedIds.filter(id => !foundIds.has(id));
    return { valid: missing.length === 0, missing };
}

// ─── Passthrough ─────────────────────────────────────────────────────────────

describe('compactHistory — passthrough', () => {
    it('returns history unchanged when under budget', () => {
        const messages = [taskMsg(), new AIMessage('done')];
        const { messages: result, stats } = compactHistory(messages, { maxChars: 100000 });
        expect(result).toBe(messages); // referentially equal
        expect(stats.toolResultsStubbed).toBe(0);
        expect(stats.writeArgsStubbed).toBe(0);
        expect(stats.originalChars).toBe(stats.compactedChars);
    });

    it('returns single message unchanged', () => {
        const messages = [taskMsg()];
        const { messages: result } = compactHistory(messages);
        expect(result).toBe(messages);
    });

    it('returns empty array unchanged', () => {
        const { messages: result } = compactHistory([]);
        expect(result).toEqual([]);
    });
});

// ─── First message preservation ──────────────────────────────────────────────

describe('compactHistory — first message', () => {
    it('never alters the first message', () => {
        const task = taskMsg('Build the complete application with React, TypeScript, and Redux');
        const messages = buildHistory(10, 8000);
        messages[0] = task;
        const { messages: result } = compactHistory(messages, { maxChars: 5000 });
        expect(result[0]).toBe(task); // referentially equal — not cloned or stubbed
        expect((result[0] as HumanMessage).content).toBe(task.content);
    });
});

// ─── Recent window preservation ──────────────────────────────────────────────

describe('compactHistory — keepRecent', () => {
    it('keeps the last keepRecent tool results verbatim', () => {
        const messages = buildHistory(10, 2000);
        const { messages: result } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        // The last 3 ToolMessages should be unchanged
        const toolMessages = result.filter(m => m._getType() === 'tool') as ToolMessage[];
        const lastThree = toolMessages.slice(-3);
        for (const tm of lastThree) {
            // Not stubbed — original content is 2000 chars of 'a'
            expect(tm.content.length).toBe(2000);
        }
    });

    it('stubs older tool results beyond the keepRecent window', () => {
        const messages = buildHistory(10, 2000);
        const { messages: result, stats } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        // Older ToolMessages should be stubbed (short one-line receipts)
        const toolMessages = result.filter(m => m._getType() === 'tool') as ToolMessage[];
        const olderOnes = toolMessages.slice(0, -3);
        for (const tm of olderOnes) {
            expect(typeof tm.content).toBe('string');
            expect(tm.content.length).toBeLessThan(120);
            expect(tm.content).toContain('elided');
        }
        expect(stats.toolResultsStubbed).toBeGreaterThan(0);
    });
});

// ─── Tool result stubbing ────────────────────────────────────────────────────

describe('compactHistory — tool result stubbing', () => {
    it('replaces a 20,000-char read_file result with a stub under 120 chars', () => {
        const messages = [
            taskMsg(),
            aiToolCall('read_file', { filePath: 'src/App.tsx' }, 'tc-old', 'Reading App.tsx'),
            toolResult('x'.repeat(20000), 'tc-old', 'read_file'),
            // Recent window
            aiToolCall('read_file', { filePath: 'src/index.ts' }, 'tc-r1', 'Reading index'),
            toolResult('y'.repeat(100), 'tc-r1', 'read_file'),
            aiToolCall('read_file', { filePath: 'src/utils.ts' }, 'tc-r2', 'Reading utils'),
            toolResult('z'.repeat(100), 'tc-r2', 'read_file'),
            aiToolCall('read_file', { filePath: 'src/types.ts' }, 'tc-r3', 'Reading types'),
            toolResult('w'.repeat(100), 'tc-r3', 'read_file'),
        ];

        const { messages: result, stats } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        // Find the stubbed tool message for the old read_file
        const oldToolMsg = result.find(m =>
            m._getType() === 'tool' && (m as ToolMessage).tool_call_id === 'tc-old'
        ) as ToolMessage;

        expect(oldToolMsg).toBeDefined();
        expect(oldToolMsg.content.length).toBeLessThan(120);
        expect(oldToolMsg.content).toContain('read_file');
        expect(oldToolMsg.content).toContain('20000');
        expect(oldToolMsg.content).toContain('elided');
        expect(stats.toolResultsStubbed).toBe(1);
    });

    it('preserves tool_call_id on stubbed ToolMessages', () => {
        const messages = buildHistory(8, 3000);
        const { messages: result } = compactHistory(messages, { keepRecent: 2, maxChars: 100000 });

        const toolMessages = result.filter(m => m._getType() === 'tool') as ToolMessage[];
        for (const tm of toolMessages) {
            expect(tm.tool_call_id).toBeTruthy();
            expect(tm.tool_call_id).toMatch(/^tc-/);
        }
    });

    it('preserves tool name on stubbed ToolMessages', () => {
        const messages = buildHistory(8, 3000);
        const { messages: result } = compactHistory(messages, { keepRecent: 2, maxChars: 100000 });

        const toolMessages = result.filter(m => m._getType() === 'tool') as ToolMessage[];
        for (const tm of toolMessages) {
            expect(tm.name).toBeTruthy();
        }
    });
});

// ─── Write arg elision ───────────────────────────────────────────────────────

describe('compactHistory — write arg elision', () => {
    it('elides write_file content arg over 400 chars but keeps filePath', () => {
        const messages = [
            taskMsg(),
            aiToolCall('write_file', {
                filePath: 'src/Board.tsx',
                content: 'x'.repeat(5000),
            }, 'tc-w', 'Writing Board'),
            toolResult('File written: src/Board.tsx', 'tc-w', 'write_file'),
            // Recent window
            aiToolCall('read_file', { filePath: 'src/index.ts' }, 'tc-r1'),
            toolResult('data', 'tc-r1', 'read_file'),
            aiToolCall('read_file', { filePath: 'src/utils.ts' }, 'tc-r2'),
            toolResult('data', 'tc-r2', 'read_file'),
            aiToolCall('read_file', { filePath: 'src/types.ts' }, 'tc-r3'),
            toolResult('data', 'tc-r3', 'read_file'),
        ];

        const { messages: result, stats } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        // Find the AIMessage that had the write_file call
        const writeAI = result.find(m =>
            m._getType() === 'ai' && (m as AIMessage).tool_calls?.some(tc => tc.name === 'write_file')
        ) as AIMessage;

        expect(writeAI).toBeDefined();
        const writeCall = writeAI.tool_calls!.find(tc => tc.name === 'write_file')!;
        // filePath should be preserved
        expect(writeCall.args.filePath).toBe('src/Board.tsx');
        // content should be elided
        expect(writeCall.args.content).toContain('chars elided');
        expect(writeCall.args.content).toContain('5000');
        expect(stats.writeArgsStubbed).toBeGreaterThan(0);
    });

    it('does not elide short args (under 400 chars)', () => {
        const messages = [
            taskMsg(),
            aiToolCall('write_file', {
                filePath: 'src/short.ts',
                content: 'const x = 1;', // short
            }, 'tc-ws', 'Writing short file'),
            toolResult('File written', 'tc-ws', 'write_file'),
            // Recent window
            aiToolCall('read_file', { filePath: 'a' }, 'tc-r1'),
            toolResult('d', 'tc-r1', 'read_file'),
            aiToolCall('read_file', { filePath: 'b' }, 'tc-r2'),
            toolResult('d', 'tc-r2', 'read_file'),
            aiToolCall('read_file', { filePath: 'c' }, 'tc-r3'),
            toolResult('d', 'tc-r3', 'read_file'),
        ];

        const { messages: result, stats } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        const writeAI = result.find(m =>
            m._getType() === 'ai' && (m as AIMessage).tool_calls?.some(tc => tc.name === 'write_file')
        ) as AIMessage;

        const writeCall = writeAI.tool_calls!.find(tc => tc.name === 'write_file')!;
        // Short content should be preserved
        expect(writeCall.args.content).toBe('const x = 1;');
        expect(stats.writeArgsStubbed).toBe(0);
    });
});

// ─── Provider invariant ──────────────────────────────────────────────────────

describe('compactHistory — provider-validity invariant', () => {
    it('every AIMessage tool_call has a matching ToolMessage after compaction', () => {
        const messages = buildHistory(15, 3000);
        const { messages: result } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        const { valid, missing } = validateToolCallPairing(result);
        expect(valid).toBe(true);
        expect(missing).toEqual([]);
    });

    it('maintains pairing after hard-ceiling drops', () => {
        // Use a very small maxChars to force drops
        const messages = buildHistory(20, 5000, { writeRounds: [2, 5, 8] });
        const { messages: result } = compactHistory(messages, { keepRecent: 3, maxChars: 2000 });

        const { valid, missing } = validateToolCallPairing(result);
        expect(valid).toBe(true);
        expect(missing).toEqual([]);
    });

    it('maintains pairing with mixed tool types', () => {
        const messages: BaseMessage[] = [
            taskMsg(),
            aiToolCall('read_file', { filePath: 'a.ts' }, 'r1'),
            toolResult('x'.repeat(3000), 'r1', 'read_file'),
            aiToolCall('write_file', { filePath: 'b.ts', content: 'y'.repeat(3000) }, 'w1'),
            toolResult('written', 'w1', 'write_file'),
            aiToolCall('run_command', { command: 'npm test' }, 'c1'),
            toolResult('PASS all tests\n' + 'z'.repeat(3000), 'c1', 'run_command'),
            aiToolCall('search_code', { query: 'useState' }, 's1'),
            toolResult('match1\nmatch2', 's1', 'search_code'),
            // Recent
            aiToolCall('read_file', { filePath: 'c.ts' }, 'r2'),
            toolResult('recent data 1', 'r2', 'read_file'),
            aiToolCall('read_file', { filePath: 'd.ts' }, 'r3'),
            toolResult('recent data 2', 'r3', 'read_file'),
            aiToolCall('read_file', { filePath: 'e.ts' }, 'r4'),
            toolResult('recent data 3', 'r4', 'read_file'),
        ];

        const { messages: result } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });
        const { valid, missing } = validateToolCallPairing(result);
        expect(valid).toBe(true);
        expect(missing).toEqual([]);
    });
});

// ─── Hard ceiling (Rule 4) ───────────────────────────────────────────────────

describe('compactHistory — hard ceiling', () => {
    it('drops oldest stubbed groups when over maxChars', () => {
        const messages = buildHistory(20, 5000);
        const { messages: result, stats } = compactHistory(messages, { keepRecent: 3, maxChars: 3000 });

        // Should be significantly smaller than original
        expect(stats.compactedChars).toBeLessThan(stats.originalChars);
        // First message must still be there
        expect(result[0]._getType()).toBe('human');
        // Should still have recent tool results
        const toolMessages = result.filter(m => m._getType() === 'tool') as ToolMessage[];
        expect(toolMessages.length).toBeGreaterThanOrEqual(3);
    });

    it('never drops the first message when shrinking', () => {
        const bigTask = taskMsg('x'.repeat(10000));
        const messages = [bigTask, ...buildHistory(15, 5000).slice(1)];
        const { messages: result } = compactHistory(messages, { keepRecent: 2, maxChars: 5000 });

        expect(result[0]).toBe(bigTask);
    });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

describe('compactHistory — stats', () => {
    it('reports correct original and compacted char counts', () => {
        const messages = buildHistory(10, 3000);
        const { stats } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        expect(stats.originalChars).toBeGreaterThan(0);
        expect(stats.compactedChars).toBeLessThan(stats.originalChars);
        expect(stats.toolResultsStubbed).toBeGreaterThan(0);
    });

    it('compactedChars equals originalChars when no compaction needed', () => {
        const messages = [taskMsg(), new AIMessage('Done!')];
        const { stats } = compactHistory(messages, { maxChars: 100000 });

        expect(stats.compactedChars).toBe(stats.originalChars);
    });
});

// ─── Immutability ────────────────────────────────────────────────────────────

describe('compactHistory — immutability', () => {
    it('does not mutate the original message array', () => {
        const messages = buildHistory(10, 3000);
        const originalLength = messages.length;
        const originalContents = messages.map(m =>
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        );

        compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        expect(messages.length).toBe(originalLength);
        messages.forEach((m, i) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            expect(content).toBe(originalContents[i]);
        });
    });

    it('does not mutate original AIMessage tool_calls', () => {
        const messages = [
            taskMsg(),
            aiToolCall('write_file', {
                filePath: 'src/big.ts',
                content: 'x'.repeat(5000),
            }, 'w1', 'Writing'),
            toolResult('written', 'w1', 'write_file'),
            aiToolCall('read_file', { filePath: 'a' }, 'r1'),
            toolResult('d', 'r1', 'read_file'),
            aiToolCall('read_file', { filePath: 'b' }, 'r2'),
            toolResult('d', 'r2', 'read_file'),
            aiToolCall('read_file', { filePath: 'c' }, 'r3'),
            toolResult('d', 'r3', 'read_file'),
        ];

        const originalWriteArgs = JSON.stringify(
            (messages[1] as AIMessage).tool_calls![0].args
        );

        compactHistory(messages, { keepRecent: 3, maxChars: 100000 });

        const afterArgs = JSON.stringify(
            (messages[1] as AIMessage).tool_calls![0].args
        );
        expect(afterArgs).toBe(originalWriteArgs);
    });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('compactHistory — edge cases', () => {
    it('handles history with no ToolMessages', () => {
        const messages: BaseMessage[] = [
            taskMsg(),
            new AIMessage('thinking...'),
            new AIMessage('more thinking...'),
        ];
        const { messages: result } = compactHistory(messages, { maxChars: 100000 });
        expect(result.length).toBe(3);
    });

    it('handles keepRecent larger than total tool results', () => {
        const messages = buildHistory(2, 1000);
        const { messages: result, stats } = compactHistory(messages, { keepRecent: 10, maxChars: 100000 });
        // All are "recent" — nothing should be stubbed
        expect(stats.toolResultsStubbed).toBe(0);
    });

    it('handles keepRecent of 0', () => {
        const messages = buildHistory(5, 2000);
        const { messages: result, stats } = compactHistory(messages, { keepRecent: 0, maxChars: 100000 });
        // All tool results should be stubbed
        expect(stats.toolResultsStubbed).toBe(5);
    });

    it('handles AIMessage with multiple tool calls', () => {
        const messages: BaseMessage[] = [
            taskMsg(),
            new AIMessage({
                content: 'Reading two files',
                tool_calls: [
                    { id: 'tc-a', name: 'read_file', args: { filePath: 'a.ts' }, type: 'tool_call' },
                    { id: 'tc-b', name: 'read_file', args: { filePath: 'b.ts' }, type: 'tool_call' },
                ],
                id: 'ai-multi',
            }),
            toolResult('x'.repeat(3000), 'tc-a', 'read_file'),
            toolResult('y'.repeat(3000), 'tc-b', 'read_file'),
            // Recent
            aiToolCall('read_file', { filePath: 'c' }, 'r1'),
            toolResult('d1', 'r1', 'read_file'),
            aiToolCall('read_file', { filePath: 'd' }, 'r2'),
            toolResult('d2', 'r2', 'read_file'),
            aiToolCall('read_file', { filePath: 'e' }, 'r3'),
            toolResult('d3', 'r3', 'read_file'),
        ];

        const { messages: result } = compactHistory(messages, { keepRecent: 3, maxChars: 100000 });
        const { valid, missing } = validateToolCallPairing(result);
        expect(valid).toBe(true);
        expect(missing).toEqual([]);
    });
});
