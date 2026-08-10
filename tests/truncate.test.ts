/**
 * Truncation utility — unit tests for Step 2 of the token-reduction plan.
 *
 * Exercises truncateToolResult: passthrough under budget, head/tail split,
 * custom headRatio, and marker correctness.
 */

// Mock config so tests are deterministic regardless of .env
jest.mock('../src/config', () => ({
    MAX_TOOL_RESULT_CHARS: 6000,
}));

import { truncateToolResult } from '../src/tools/_shared/truncate';

// ─── Passthrough ─────────────────────────────────────────────────────────────

describe('truncateToolResult — passthrough', () => {
    it('returns the original string unchanged when under budget', () => {
        const input = 'short result';
        const result = truncateToolResult(input, 'test');
        expect(result).toBe(input);
    });

    it('returns the original string unchanged when exactly at budget', () => {
        const input = 'x'.repeat(6000);
        const result = truncateToolResult(input, 'test');
        expect(result).toBe(input);
    });

    it('returns the original string unchanged for empty input', () => {
        const result = truncateToolResult('', 'test');
        expect(result).toBe('');
    });
});

// ─── Truncation ──────────────────────────────────────────────────────────────

describe('truncateToolResult — over budget', () => {
    it('truncates content over budget with head/tail and marker', () => {
        const input = 'A'.repeat(3000) + 'B'.repeat(3000) + 'C'.repeat(4000);
        const result = truncateToolResult(input, 'read_file src/App.tsx', 6000);

        // Should start with head (60% of 6000 = 3600 chars from the beginning)
        expect(result.startsWith('A'.repeat(3000))).toBe(true);
        // Should end with tail (40% of 6000 = 2400 chars from the end)
        expect(result.endsWith('C'.repeat(2400))).toBe(true);
        // Should contain the omission marker
        expect(result).toContain('chars omitted of 10000 total');
        expect(result).toContain('read_file src/App.tsx');
        // Should contain instructions for the model
        expect(result).toContain('read_file with offset/limit');
    });

    it('head and tail portions are both present and correct', () => {
        // Create a string with identifiable head and tail
        const head = 'HEAD_' + 'x'.repeat(5000);
        const tail = 'y'.repeat(5000) + '_TAIL';
        const input = head + tail;
        const maxChars = 2000;
        const result = truncateToolResult(input, 'test', maxChars);

        // Head: first 1200 chars (60% of 2000)
        expect(result.startsWith('HEAD_')).toBe(true);
        // Tail: last 800 chars (40% of 2000)
        expect(result.endsWith('_TAIL')).toBe(true);
    });

    it('marker includes the correct omitted char count', () => {
        const input = 'z'.repeat(10000);
        const maxChars = 4000;
        const result = truncateToolResult(input, 'list_dir', maxChars);

        // headSize = 2400, tailSize = 1600, omitted = 10000 - 2400 - 1600 = 6000
        expect(result).toContain('6000 chars omitted of 10000 total');
    });
});

// ─── Custom headRatio ────────────────────────────────────────────────────────

describe('truncateToolResult — custom headRatio', () => {
    it('uses tail-weighted split with headRatio=0.2 for shell output', () => {
        // Simulate build output where errors are at the end
        const buildLog = 'info: '.repeat(2000) + 'ERROR: something failed\n'.repeat(200);
        const maxChars = 3000;
        const result = truncateToolResult(buildLog, 'run_command', maxChars, 0.2);

        // Head: 20% of 3000 = 600 chars
        const headPart = result.slice(0, 600);
        expect(headPart.startsWith('info: ')).toBe(true);

        // Tail should be 80% = 2400 chars, and should contain ERROR lines
        expect(result).toContain('ERROR: something failed');
    });

    it('headRatio=0.5 splits evenly', () => {
        const input = 'H'.repeat(5000) + 'T'.repeat(5000);
        const maxChars = 2000;
        const result = truncateToolResult(input, 'test', maxChars, 0.5);

        // Head: 1000 chars of H, tail: 1000 chars of T
        expect(result.startsWith('H'.repeat(1000))).toBe(true);
        expect(result.endsWith('T'.repeat(1000))).toBe(true);
    });
});

// ─── Custom maxChars ─────────────────────────────────────────────────────────

describe('truncateToolResult — custom maxChars', () => {
    it('respects explicit maxChars override', () => {
        const input = 'x'.repeat(500);
        // Under budget with the default 6000, but over with 100
        const result = truncateToolResult(input, 'test', 100);
        expect(result).toContain('chars omitted');
        // Head (60 chars) + marker + tail (40 chars) — result should NOT contain the full input
        expect(result.length).toBeLessThan(input.length);
    });

    it('passthrough when content is under custom maxChars', () => {
        const input = 'x'.repeat(50);
        const result = truncateToolResult(input, 'test', 100);
        expect(result).toBe(input);
    });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('truncateToolResult — edge cases', () => {
    it('handles maxChars of 1 gracefully', () => {
        const input = 'abcdefghij';
        const result = truncateToolResult(input, 'test', 1);
        // headSize = 0 (floor(1 * 0.6) = 0), tailSize = 1
        // Should still produce output with marker
        expect(result).toContain('chars omitted');
    });

    it('handles very large input', () => {
        const input = 'x'.repeat(1_000_000);
        const result = truncateToolResult(input, 'read_file huge.json', 6000);
        expect(result).toContain('chars omitted of 1000000 total');
        // Head + tail should total 6000 chars of actual content
        const markerMatch = result.match(/\n\.\.\. \[.*?\] \.\.\.\n/s);
        expect(markerMatch).toBeTruthy();
    });

    it('label with special characters is preserved in marker', () => {
        const input = 'x'.repeat(200);
        const result = truncateToolResult(input, 'read_file src/[utils]/helper.ts', 100);
        expect(result).toContain('read_file src/[utils]/helper.ts');
    });
});
