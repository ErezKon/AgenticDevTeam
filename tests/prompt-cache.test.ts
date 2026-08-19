/**
 * Tests for prompt-cache.ts (Plan 26, A1)
 *
 * Validates that blocksWithTrailingBreakpoint correctly skips thinking blocks
 * and places cache_control on the appropriate non-thinking block.
 */
import { blocksWithTrailingBreakpoint } from '../src/agents/_shared/prompt-cache';

describe('blocksWithTrailingBreakpoint', () => {
    it('returns null for empty string content', () => {
        expect(blocksWithTrailingBreakpoint('')).toBeNull();
    });

    it('returns null for empty array content', () => {
        expect(blocksWithTrailingBreakpoint([])).toBeNull();
    });

    it('returns null for null content', () => {
        expect(blocksWithTrailingBreakpoint(null)).toBeNull();
    });

    it('wraps a plain string in a text block with cache_control', () => {
        const result = blocksWithTrailingBreakpoint('hello world');
        expect(result).toEqual([
            { type: 'text', text: 'hello world', cache_control: { type: 'ephemeral' } },
        ]);
    });

    it('places cache_control on the last block when all are non-thinking', () => {
        const content = [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
        ];
        const result = blocksWithTrailingBreakpoint(content);
        expect(result).not.toBeNull();
        expect(result![0].cache_control).toBeUndefined();
        expect(result![1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('returns null when all blocks are thinking blocks', () => {
        const content = [
            { type: 'thinking', thinking: 'some reasoning', signature: 'sig' },
        ];
        const result = blocksWithTrailingBreakpoint(content);
        expect(result).toBeNull();
    });

    it('returns null when content has thinking + redacted_thinking blocks only', () => {
        const content = [
            { type: 'thinking', thinking: 'reasoning', signature: 'sig1' },
            { type: 'redacted_thinking', data: 'redacted' },
        ];
        const result = blocksWithTrailingBreakpoint(content);
        expect(result).toBeNull();
    });

    it('places cache_control on text block when content is [thinking, text]', () => {
        const content = [
            { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
            { type: 'text', text: 'response text' },
        ];
        const result = blocksWithTrailingBreakpoint(content);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(2);
        // thinking block must NOT have cache_control
        expect(result![0].cache_control).toBeUndefined();
        // text block should have cache_control
        expect(result![1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('places cache_control on tool_use block when content is [thinking, tool_use]', () => {
        const content = [
            { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
            { type: 'tool_use', id: 'call-1', name: 'read_file', input: {} },
        ];
        const result = blocksWithTrailingBreakpoint(content);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(2);
        // thinking block must NOT have cache_control
        expect(result![0].cache_control).toBeUndefined();
        // tool_use block should have cache_control
        expect(result![1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('skips trailing thinking blocks and places cache_control on last non-thinking block', () => {
        const content = [
            { type: 'text', text: 'first text' },
            { type: 'text', text: 'second text' },
            { type: 'thinking', thinking: 'trailing thought', signature: 'sig' },
        ];
        const result = blocksWithTrailingBreakpoint(content);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(3);
        // First text — no cache_control
        expect(result![0].cache_control).toBeUndefined();
        // Second text — should have cache_control (last non-thinking)
        expect(result![1].cache_control).toEqual({ type: 'ephemeral' });
        // Thinking — must NOT have cache_control
        expect(result![2].cache_control).toBeUndefined();
    });

    it('does not mutate the original content array', () => {
        const original = [
            { type: 'text', text: 'hello' },
        ];
        blocksWithTrailingBreakpoint(original);
        expect((original[0] as any).cache_control).toBeUndefined();
    });
});
