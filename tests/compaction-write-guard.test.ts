/**
 * Compaction / write-boundary guard and the turn-aware recent window
 * (Plan 22, B1–B4).
 *
 * ## The bug these tests pin
 *
 * `full-responses/006-principal-frontend-development.json` of the pacmanclaude
 * run contains three FIRST-TIME writes whose entire payload is the compactor's own
 * elision placeholder:
 *
 *   #18 src/persistence/HighScoreStore.ts  len=19  '[1204 chars elided]'
 *   #19 src/persistence/SettingsStore.ts   len=18  '[770 chars elided]'
 *   #20 src/game/GameLoop.ts               len=18  '[514 chars elided]'
 *
 * After seeing fifteen of those markers in its own compacted history the model
 * imitated the pattern. Two files shipped corrupt and a later generation burned
 * itself repairing one of them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

jest.mock('../src/config', () => ({
    HISTORY_KEEP_RECENT_TOOL_RESULTS: 1,
    HISTORY_KEEP_RECENT_TURNS: 3,
    HISTORY_KEEP_RECENT_WRITE_ARGS: 2,
    HISTORY_MAX_CHARS: 1_000_000,
    MAX_TOOL_RESULT_CHARS: 10_000,
    FS_CONFIG_PROTECTION: 'off',
}));

import { compactHistory, findTurnBoundary, findRecentWriteTurnIndexes } from '../src/agents/_shared/history-compactor';
import { checkWritePayload, createWorkspaceTools } from '../src/tools/fs/workspace-tools';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-write-guard-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** An AI turn that calls `count` tools in parallel, plus its ToolMessages. */
function parallelTurn(turn: number, count: number, toolName = 'read_file', argsFor?: (i: number) => any): BaseMessage[] {
    const calls = Array.from({ length: count }, (_, i) => ({
        id: `t${turn}-${i}`,
        name: toolName,
        args: argsFor ? argsFor(i) : { filePath: `src/f${turn}-${i}.ts` },
        type: 'tool_call' as const,
    }));
    return [
        new AIMessage({ content: `turn ${turn}`, tool_calls: calls, id: `ai-${turn}` }),
        ...calls.map(c => new ToolMessage({ content: 'X'.repeat(3000), tool_call_id: c.id, name: toolName })),
    ];
}

// ─── B1: write boundary ─────────────────────────────────────────────────────

describe('checkWritePayload (Plan 22 B1)', () => {
    it.each([
        ['[1204 chars elided]'],
        ['[770 chars elided]'],
        ['  [514 chars elided]  '],
        ['[1,204 chars elided]'],
        ['[read_file -> 4210 chars, elided]'],
        ['⟪ORCHESTRATOR-ELIDED 770 chars of the "content" argument — already on disk; NEVER copy this marker into a file⟫'],
    ])('rejects the exact elision placeholder %s', (payload) => {
        const refusal = checkWritePayload('src/persistence/SettingsStore.ts', payload);
        expect(refusal).not.toBeNull();
        expect(refusal).toContain('REJECTED');
        expect(refusal).toContain('elision placeholder');
    });

    it.each([
        ['export const x = 2;'],
        ['export * from \'./types\';'],
        ['/** Real code. */\nexport function f() { return 1; }'],
        ['// mentions [770 chars elided] in a comment but has real code\nexport const y = 1;'],
        [''],
    ])('accepts legitimate content %#', (payload) => {
        expect(checkWritePayload('src/x.ts', payload)).toBeNull();
    });

    it('blocks write_file from putting a placeholder on disk', async () => {
        const tools = createWorkspaceTools(tmpDir);
        const writeFile = tools.find(t => t.name === 'write_file')!;

        const result = await writeFile.invoke({
            filePath: 'src/persistence/SettingsStore.ts',
            content: '[770 chars elided]',
        });

        expect(result).toContain('REJECTED');
        expect(fs.existsSync(path.join(tmpDir, 'src/persistence/SettingsStore.ts'))).toBe(false);
    });

    it('blocks edit_file from replacing real code with a placeholder', async () => {
        const target = path.join(tmpDir, 'a.ts');
        fs.writeFileSync(target, 'export const real = 1;\n');
        const tools = createWorkspaceTools(tmpDir);
        const editFile = tools.find(t => t.name === 'edit_file')!;

        const result = await editFile.invoke({
            filePath: 'a.ts',
            oldString: 'export const real = 1;',
            newString: '[1204 chars elided]',
        });

        expect(result).toContain('REJECTED');
        expect(fs.readFileSync(target, 'utf-8')).toContain('export const real = 1;');
    });

    it('still allows a short legitimate edit_file replacement', async () => {
        const target = path.join(tmpDir, 'a.ts');
        fs.writeFileSync(target, 'export const real = 1;\n');
        const tools = createWorkspaceTools(tmpDir);
        const editFile = tools.find(t => t.name === 'edit_file')!;

        const result = await editFile.invoke({ filePath: 'a.ts', oldString: '1', newString: '2' });
        expect(result).toContain('File edited');
        expect(fs.readFileSync(target, 'utf-8')).toContain('export const real = 2;');
    });
});

// ─── B2: marker shape ───────────────────────────────────────────────────────

describe('elision marker shape (Plan 22 B2)', () => {
    it('is self-describing and not plausible source text', () => {
        const messages: BaseMessage[] = [
            new HumanMessage('task'),
            ...parallelTurn(1, 1, 'write_file', () => ({ filePath: 'src/a.ts', content: 'y'.repeat(5000) })),
            ...parallelTurn(2, 1, 'write_file', () => ({ filePath: 'src/b.ts', content: 'y'.repeat(5000) })),
            ...parallelTurn(3, 1, 'write_file', () => ({ filePath: 'src/c.ts', content: 'y'.repeat(5000) })),
            ...parallelTurn(4, 1, 'write_file', () => ({ filePath: 'src/d.ts', content: 'y'.repeat(5000) })),
            ...parallelTurn(5, 1, 'write_file', () => ({ filePath: 'src/e.ts', content: 'y'.repeat(5000) })),
        ];

        const { messages: out } = compactHistory(messages);
        const elided = out
            .filter((m): m is AIMessage => m instanceof AIMessage && !!m.tool_calls?.length)
            .flatMap(m => m.tool_calls!.map(tc => tc.args.content))
            .filter((c): c is string => typeof c === 'string' && c.includes('ELIDED'));

        expect(elided.length).toBeGreaterThan(0);
        for (const marker of elided) {
            expect(marker).toContain('NEVER copy this marker');
            // Guarded at the write boundary too — belt and braces.
            expect(checkWritePayload('src/a.ts', marker)).not.toBeNull();
        }
    });
});

// ─── B3: recent write args are never elided ─────────────────────────────────

describe('recent write-arg exemption (Plan 22 B3)', () => {
    it('keeps the last 2 write turns verbatim', () => {
        const messages: BaseMessage[] = [new HumanMessage('task')];
        for (let t = 1; t <= 6; t++) {
            messages.push(...parallelTurn(t, 1, 'write_file', () => ({
                filePath: `src/f${t}.ts`, content: `content-${t}-${'z'.repeat(1000)}`,
            })));
        }

        const exempt = findRecentWriteTurnIndexes(messages, 2);
        expect(exempt.size).toBe(2);

        const { messages: out } = compactHistory(messages, { keepRecentTurns: 0, keepRecent: 1 });
        const writeArgs = out
            .filter((m): m is AIMessage => m instanceof AIMessage && !!m.tool_calls?.length)
            .map(m => m.tool_calls![0].args.content as string);

        // The two newest write turns keep their real content.
        expect(writeArgs[writeArgs.length - 1]).toContain('content-6');
        expect(writeArgs[writeArgs.length - 2]).toContain('content-5');
        // Older ones are elided.
        expect(writeArgs[0]).toContain('ELIDED');
    });
});

// ─── B4: turn-aware recent window ───────────────────────────────────────────

describe('turn-aware recent window (Plan 22 B4)', () => {
    it('findTurnBoundary returns the start of the last N turns', () => {
        const messages: BaseMessage[] = [new HumanMessage('task')];
        for (let t = 1; t <= 5; t++) messages.push(...parallelTurn(t, 4));

        const boundary = findTurnBoundary(messages, 3);
        // 5 turns of (1 AI + 4 Tool) = 5 msgs each, starting at index 1.
        // Turn 3 starts at 1 + 2*5 = 11.
        expect(boundary).toBe(11);
    });

    it('keeps nothing stubbed when there are fewer turns than the window', () => {
        const messages: BaseMessage[] = [new HumanMessage('task'), ...parallelTurn(1, 4), ...parallelTurn(2, 4)];
        expect(findTurnBoundary(messages, 3)).toBe(1);
    });

    it('does NOT stub any result from the last 3 turns of an 11-parallel-call history', () => {
        // The exact shape of dump 020: 8 turns, up to 11 parallel reads each.
        const messages: BaseMessage[] = [new HumanMessage('task')];
        for (let t = 1; t <= 8; t++) messages.push(...parallelTurn(t, 11));

        const { messages: out, stats } = compactHistory(messages);

        // Older turns WERE compacted, so the mechanism is still doing its job.
        expect(stats.toolResultsStubbed).toBeGreaterThan(0);

        // The last 3 turns = 3 * (1 AI + 11 Tool) = 36 messages, all verbatim.
        const tail = out.slice(-36);
        const stubbedInTail = tail.filter(m =>
            m instanceof ToolMessage && String(m.content).includes('ELIDED'),
        );
        expect(stubbedInTail).toHaveLength(0);

        // Contrast with the old tool-result-counted boundary. `keepRecent: 4` is
        // *fewer results than a single turn produces*, so the walk-back to the
        // parent AIMessage rescues exactly one turn and everything older is
        // stubbed — including the two turns immediately before it, which is what
        // drove agents to re-read files they had just read.
        const legacy = compactHistory(messages, { keepRecentTurns: 0, keepRecent: 4 });
        const stubbedInLegacyTail = legacy.messages.slice(-36).filter(m =>
            m instanceof ToolMessage && String(m.content).includes('ELIDED'),
        );
        // 2 of the last 3 turns (22 results) are stubbed under the legacy rule.
        expect(stubbedInLegacyTail).toHaveLength(22);
        expect(legacy.stats.toolResultsStubbed).toBeGreaterThan(stats.toolResultsStubbed);
    });
});
