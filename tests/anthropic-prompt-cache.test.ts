/**
 * Anthropic prompt-cache breakpoints and cache-token accounting
 * (Plan 22, D1/D2).
 *
 * ## The bug these tests pin
 *
 * Every one of the 227 Anthropic calls in the pacmanclaude run reported
 * `input_token_details = { cache_read: 0, cache_creation: 0 }`. The persona, tool
 * schemas, injected JSON schema and task context — byte-identical on every turn —
 * were re-billed each time, giving a 23:1 input:output ratio (2,320,436 in /
 * 99,731 out) for a single branch of fifteen. Nothing in the pipeline noticed.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

jest.mock('../src/config', () => ({
    HISTORY_KEEP_RECENT_TURNS: 3,
    HISTORY_KEEP_RECENT_TOOL_RESULTS: 4,
    HISTORY_KEEP_RECENT_WRITE_ARGS: 2,
    HISTORY_MAX_CHARS: 1_000_000,
}));

import {
    withSystemCacheBreakpoint, withMessageCacheBreakpoints, MAX_CACHE_BREAKPOINTS,
} from '../src/agents/_shared/prompt-cache';
import { normaliseUsage, sumUsageMetadata } from '../src/utils/token-usage-extractor';

// ─── Helpers ────────────────────────────────────────────────────────────────

const big = (n: number) => 'x'.repeat(n);

function cacheControlBlocks(content: unknown): any[] {
    if (!Array.isArray(content)) return [];
    return content.filter(b => b && typeof b === 'object' && 'cache_control' in b);
}

// ─── D1: system + tools breakpoint ──────────────────────────────────────────

describe('withSystemCacheBreakpoint (Plan 22 D1)', () => {
    it('marks the trailing block of a large system prompt', () => {
        // Anthropic serialises tools BEFORE system, so one breakpoint here caches
        // the tool schemas and the persona and the injected response schema.
        const sys = new SystemMessage(`You are a principal developer.\n${big(6000)}`);
        const out = withSystemCacheBreakpoint(sys);

        expect(out).not.toBe(sys);
        const marked = cacheControlBlocks(out.content);
        expect(marked).toHaveLength(1);
        expect(marked[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(marked[0].type).toBe('text');
        expect(marked[0].text).toContain('You are a principal developer.');
    });

    it('leaves a small system prompt alone — a cache write would cost more', () => {
        const sys = new SystemMessage('short');
        expect(withSystemCacheBreakpoint(sys)).toBe(sys);
    });

    it('is idempotent — never stacks breakpoints across turns', () => {
        const sys = new SystemMessage(big(6000));
        const once = withSystemCacheBreakpoint(sys);
        const twice = withSystemCacheBreakpoint(once);

        expect(twice).toBe(once);
        expect(cacheControlBlocks(twice.content)).toHaveLength(1);
    });

    it('marks the last block of block-shaped system content', () => {
        const sys = new SystemMessage({
            content: [
                { type: 'text', text: big(3000) },
                { type: 'text', text: big(3000) },
            ] as any,
        });
        const out = withSystemCacheBreakpoint(sys);
        const blocks = out.content as any[];

        expect(blocks).toHaveLength(2);
        expect(blocks[0].cache_control).toBeUndefined();
        expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    });
});

// ─── D1: message breakpoints ────────────────────────────────────────────────

describe('withMessageCacheBreakpoints (Plan 22 D1)', () => {
    /** A history with 5 tool-calling turns and a large task message.
     *  AI message content must exceed the model-aware cache minimum
     *  (Plan 24, C2: default 1024 tokens × ~4 chars/token = 4096 chars). */
    function history(): BaseMessage[] {
        const out: BaseMessage[] = [new HumanMessage(`## Architecture\n${big(8000)}`)];
        for (let t = 1; t <= 5; t++) {
            out.push(new AIMessage({
                content: `reasoning ${t} ${big(5000)}`,
                tool_calls: [{ id: `t${t}`, name: 'read_file', args: { filePath: `f${t}.ts` }, type: 'tool_call' }],
            }));
            out.push(new ToolMessage({ content: big(2000), tool_call_id: `t${t}`, name: 'read_file' }));
        }
        return out;
    }

    it('marks the task message and a rolling history breakpoint', () => {
        const { messages, breakpoints } = withMessageCacheBreakpoints(history());

        expect(breakpoints).toBe(2);
        // First human message = the task and its architecture context.
        expect(cacheControlBlocks(messages[0].content)).toHaveLength(1);
        // Exactly two messages carry a breakpoint in total.
        const marked = messages.filter(m => cacheControlBlocks(m.content).length > 0);
        expect(marked).toHaveLength(2);
    });

    it('places the rolling breakpoint OUTSIDE the recent window', () => {
        const msgs = history();
        const { messages } = withMessageCacheBreakpoints(msgs);

        const markedIndexes = messages
            .map((m, i) => (cacheControlBlocks(m.content).length > 0 ? i : -1))
            .filter(i => i >= 0);

        // 5 turns of 2 messages starting at index 1; the last 3 turns start at
        // index 1 + 2*2 = 5. The rolling breakpoint must be before that.
        const rolling = markedIndexes.filter(i => i !== 0);
        expect(rolling).toHaveLength(1);
        expect(rolling[0]).toBeLessThan(5);
    });

    it('preserves tool_calls when rewriting an AIMessage', () => {
        const { messages } = withMessageCacheBreakpoints(history());
        const rewritten = messages.filter(
            (m): m is AIMessage => m instanceof AIMessage && cacheControlBlocks(m.content).length > 0,
        );
        expect(rewritten).toHaveLength(1);
        expect(rewritten[0].tool_calls).toHaveLength(1);
        expect(rewritten[0].tool_calls![0].args.filePath).toMatch(/^f\d\.ts$/);
    });

    it('respects the remaining breakpoint budget', () => {
        const { breakpoints } = withMessageCacheBreakpoints(history(), 1);
        expect(breakpoints).toBe(1);
    });

    it('is a no-op with zero budget', () => {
        const msgs = history();
        const { messages, breakpoints } = withMessageCacheBreakpoints(msgs, 0);
        expect(messages).toBe(msgs);
        expect(breakpoints).toBe(0);
    });

    it('never exceeds Anthropic\'s 4-breakpoint limit in total', () => {
        const sys = withSystemCacheBreakpoint(new SystemMessage(big(6000)));
        const systemBreakpoints = cacheControlBlocks(sys.content).length;
        const { breakpoints } = withMessageCacheBreakpoints(history(), MAX_CACHE_BREAKPOINTS - systemBreakpoints);
        expect(systemBreakpoints + breakpoints).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    });

    it('skips messages too small to be worth a cache write', () => {
        const msgs = [new HumanMessage('tiny'), new AIMessage('also tiny')];
        const { breakpoints } = withMessageCacheBreakpoints(msgs);
        expect(breakpoints).toBe(0);
    });
});

// ─── D2: cache-token accounting ─────────────────────────────────────────────

describe('cache-token accounting (Plan 22 D2)', () => {
    it('reads Anthropic raw cache fields', () => {
        const totals = normaliseUsage({
            input_tokens: 400,
            output_tokens: 100,
            cache_creation_input_tokens: 1200,
            cache_read_input_tokens: 5600,
        });

        expect(totals).not.toBeNull();
        expect(totals!.cacheReadTokens).toBe(5600);
        expect(totals!.cacheCreationTokens).toBe(1200);
        // Raw Anthropic usage excludes cache tokens from input_tokens.
        expect(totals!.inputTokens).toBe(400 + 1200 + 5600);
    });

    it('reads LangChain usage_metadata.input_token_details', () => {
        const totals = normaliseUsage({
            input_tokens: 7200,
            output_tokens: 300,
            total_tokens: 7500,
            input_token_details: { cache_read: 6800, cache_creation: 0 },
        });

        expect(totals!.cacheReadTokens).toBe(6800);
        expect(totals!.cacheCreationTokens).toBe(0);
        // Already normalised — cache tokens must NOT be added again.
        expect(totals!.inputTokens).toBe(7200);
    });

    it('reports zeros for providers without a prompt cache', () => {
        const totals = normaliseUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
        expect(totals!.cacheReadTokens).toBe(0);
        expect(totals!.cacheCreationTokens).toBe(0);
    });

    it('sums cache tokens across messages', () => {
        const totals = sumUsageMetadata([
            { usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_token_details: { cache_read: 90 } } },
            { usage_metadata: { input_tokens: 120, output_tokens: 20, total_tokens: 140, input_token_details: { cache_read: 100 } } },
        ]);

        expect(totals!.cacheReadTokens).toBe(190);
        expect(totals!.inputTokens).toBe(220);
    });

    it('surfaces the pacmanclaude signature — a total cache miss', () => {
        const totals = sumUsageMetadata([
            { usage_metadata: { input_tokens: 11017, output_tokens: 168, total_tokens: 11185, input_token_details: { cache_read: 0, cache_creation: 0 } } },
        ]);

        expect(totals!.cacheReadTokens).toBe(0);
        // 65:1 for this single call. The run averaged 23:1.
        expect(totals!.inputTokens / totals!.outputTokens).toBeGreaterThan(60);
    });
});
