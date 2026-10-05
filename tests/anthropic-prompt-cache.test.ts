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
 *
 * Plan 30-06: the conversation is cached too — by Anthropic's automatic caching
 * (a top-level `cache_control`, set by the agent factory), or, behind a proxy, by
 * an explicit breakpoint on the last message. No breakpoint is gated on the
 * length of the block it ends any more: the minimum applies to the whole prefix.
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

    it('marks a short system prompt too — the minimum applies to the whole prefix (Plan 30-06)', () => {
        const sys = new SystemMessage('short');
        const out = withSystemCacheBreakpoint(sys, { model: 'claude-haiku-4-5', tools: [{ name: 'read_file' }], agentId: 'junior' });
        expect(cacheControlBlocks(out.content)).toHaveLength(1);
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

// ─── D1 / Plan 30-06: message breakpoints ───────────────────────────────────

describe('withMessageCacheBreakpoints (Plan 22 D1, Plan 30-06)', () => {
    /** A task message and 5 tool-calling turns; the last message is a tool result. */
    function history(): BaseMessage[] {
        const out: BaseMessage[] = [new HumanMessage(`## Architecture\n${big(8000)}`)];
        for (let t = 1; t <= 5; t++) {
            out.push(new AIMessage({
                content: `reasoning ${t}`,
                tool_calls: [{ id: `t${t}`, name: 'read_file', args: { filePath: `f${t}.ts` }, type: 'tool_call' }],
            }));
            out.push(new ToolMessage({ content: big(2000), tool_call_id: `t${t}`, name: 'read_file' }));
        }
        return out;
    }

    const markedIndexes = (messages: BaseMessage[]): number[] =>
        messages.map((m, i) => (cacheControlBlocks(m.content).length > 0 ? i : -1)).filter(i => i >= 0);

    it('with automatic caching, marks only the task message — the conversation is cached by the API', () => {
        const { messages, breakpoints } = withMessageCacheBreakpoints(history(), { autoCache: true });
        expect(breakpoints).toBe(1);
        expect(markedIndexes(messages)).toEqual([0]);
    });

    it('fallback (proxy): also marks the last block of the last message', () => {
        const msgs = history();
        const { messages, breakpoints } = withMessageCacheBreakpoints(msgs, { autoCache: false });

        expect(breakpoints).toBe(2);
        expect(markedIndexes(messages)).toEqual([0, msgs.length - 1]);
        const last = messages[messages.length - 1] as ToolMessage;
        expect(last).toBeInstanceOf(ToolMessage);
        expect(last.tool_call_id).toBe('t5');
        expect(last.name).toBe('read_file');
    });

    it('fallback: preserves tool_calls when the last message is an AIMessage', () => {
        const msgs = [...history(), new AIMessage({
            content: [{ type: 'text', text: 'next step' }] as any,
            tool_calls: [{ id: 't6', name: 'read_file', args: { filePath: 'f6.ts' }, type: 'tool_call' }],
        })];
        const { messages } = withMessageCacheBreakpoints(msgs, { autoCache: false });
        const last = messages[messages.length - 1] as AIMessage;
        expect(cacheControlBlocks(last.content)).toHaveLength(1);
        expect(last.tool_calls).toHaveLength(1);
        expect(last.tool_calls![0].args.filePath).toBe('f6.ts');
    });

    it('fallback: never marks a thinking block', () => {
        const msgs = [new HumanMessage('task'), new AIMessage({ content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }] as any })];
        const { messages, breakpoints } = withMessageCacheBreakpoints(msgs, { autoCache: false });
        expect(breakpoints).toBe(1);
        expect(markedIndexes(messages)).toEqual([0]);
    });

    it('marks a short task message — no gating on the block\'s own length (Plan 30-06)', () => {
        const { breakpoints } = withMessageCacheBreakpoints([new HumanMessage('tiny')], { autoCache: true });
        expect(breakpoints).toBe(1);
    });

    it('respects the remaining breakpoint budget', () => {
        const { messages, breakpoints } = withMessageCacheBreakpoints(history(), { autoCache: false, budget: 1 });
        expect(breakpoints).toBe(1);
        expect(markedIndexes(messages)).toEqual([0]);
    });

    it('is a no-op with zero budget', () => {
        const msgs = history();
        const { messages, breakpoints } = withMessageCacheBreakpoints(msgs, { autoCache: false, budget: 0 });
        expect(messages).toBe(msgs);
        expect(breakpoints).toBe(0);
    });

    it('is idempotent — never stacks breakpoints', () => {
        const once = withMessageCacheBreakpoints(history(), { autoCache: false }).messages;
        const twice = withMessageCacheBreakpoints(once, { autoCache: false });
        expect(twice.breakpoints).toBe(0);
        expect(twice.messages.flatMap(m => cacheControlBlocks(m.content))).toHaveLength(2);
    });

    it.each([true, false])('never exceeds Anthropic\'s 4-breakpoint limit in total (autoCache=%s)', (autoCache) => {
        const sys = withSystemCacheBreakpoint(new SystemMessage(big(6000)));
        const systemBreakpoints = cacheControlBlocks(sys.content).length;
        const automatic = autoCache ? 1 : 0;
        const { breakpoints } = withMessageCacheBreakpoints(history(), {
            autoCache, budget: MAX_CACHE_BREAKPOINTS - systemBreakpoints - automatic,
        });
        expect(systemBreakpoints + breakpoints + automatic).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
        expect(systemBreakpoints + breakpoints + automatic).toBe(3);
    });

    it('never mutates the input messages', () => {
        const msgs = history();
        withMessageCacheBreakpoints(msgs, { autoCache: false });
        expect(msgs.flatMap(m => cacheControlBlocks(m.content))).toHaveLength(0);
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
