/**
 * Tests for structured-output.ts — truncation detection, field-level repair,
 * and non-lossy repair prompt (Sub-Plan 04).
 */
import { z } from 'zod';
import {
    parseAgentJson, detectTruncation,
    repairFieldViolations, buildRepairMessage,
    trimTruncatedArrayTails,
} from '../src/utils/structured-output';

// ─── detectTruncation ───────────────────────────────────────────────────────

describe('detectTruncation', () => {
    it('returns false for valid JSON', () => {
        expect(detectTruncation('{"a": 1}')).toBe(false);
        expect(detectTruncation('[1, 2, 3]')).toBe(false);
    });

    it('detects unbalanced braces', () => {
        expect(detectTruncation('{"a": 1, "b":')).toBe(true);
    });

    it('detects unbalanced brackets', () => {
        expect(detectTruncation('[1, 2, 3')).toBe(true);
    });

    it('detects mid-string truncation', () => {
        expect(detectTruncation('{"name": "hello wor')).toBe(true);
    });

    it('handles nested structures', () => {
        expect(detectTruncation('{"a": {"b": [1, 2')).toBe(true);
        expect(detectTruncation('{"a": {"b": [1, 2]}}')).toBe(false);
    });

    it('handles escaped quotes correctly', () => {
        expect(detectTruncation('{"a": "he said \\"hello\\""}')).toBe(false);
        expect(detectTruncation('{"a": "he said \\"hello')).toBe(true);
    });
});

// ─── parseAgentJson ─────────────────────────────────────────────────────────

describe('parseAgentJson', () => {
    it('parses valid JSON with wasTruncated=undefined', () => {
        const r = parseAgentJson('{"x": 1}');
        expect(r.ok).toBe(true);
        expect(r.wasTruncated).toBeUndefined();
    });

    it('repairs truncated JSON and sets wasTruncated=true', () => {
        // Truncated array — jsonrepair should close it
        const r = parseAgentJson('{"items": [1, 2, 3');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.wasTruncated).toBe(true);
            expect((r.value as any).items).toEqual([1, 2, 3]);
        }
    });

    it('sets wasTruncated=true on total failure when structure is incomplete', () => {
        // Completely garbled but has opening brace
        const r = parseAgentJson('{notjson at all');
        expect(r.wasTruncated).toBe(true);
    });

    it('includes rawLength', () => {
        const input = '   {"a": 1}   ';
        const r = parseAgentJson(input);
        expect(r.rawLength).toBe(input.trim().length);
    });
});

// ─── repairFieldViolations ──────────────────────────────────────────────────

describe('repairFieldViolations', () => {
    const TestSchema = z.object({
        taskType: z.enum(['feature', 'bug', 'fix', 'refactor', 'chore']),
        priority: z.enum(['critical', 'high', 'medium', 'low']),
        count: z.number(),
        active: z.boolean(),
        tags: z.array(z.string()),
        rank: z.enum(['principal', 'senior', 'junior']),
    });

    it('returns unchanged value when schema passes', () => {
        const good = { taskType: 'feature', priority: 'high', count: 5, active: true, tags: ['a'], rank: 'senior' };
        const r = repairFieldViolations(good, TestSchema);
        expect(r.unrepairable).toEqual([]);
        expect(r.repaired).toEqual([]);
    });

    it('fixes case-insensitive enum matches', () => {
        const val = { taskType: 'Feature', priority: 'HIGH', count: 5, active: true, tags: ['a'], rank: 'Senior' };
        const r = repairFieldViolations(val, TestSchema);
        expect(r.unrepairable).toEqual([]);
        expect(r.repaired.length).toBeGreaterThan(0);
        const fixed = r.value as any;
        expect(fixed.taskType).toBe('feature');
        expect(fixed.priority).toBe('high');
        expect(fixed.rank).toBe('senior');
    });

    it('coerces scalar to array', () => {
        const val = { taskType: 'feature', priority: 'high', count: 5, active: true, tags: 'single', rank: 'senior' };
        const r = repairFieldViolations(val, TestSchema);
        expect((r.value as any).tags).toEqual(['single']);
        expect(r.repaired.some(rp => rp.path === 'tags')).toBe(true);
    });

    it('coerces numeric string to number', () => {
        const val = { taskType: 'feature', priority: 'high', count: '42', active: true, tags: ['a'], rank: 'senior' };
        const r = repairFieldViolations(val, TestSchema);
        expect((r.value as any).count).toBe(42);
    });

    it('coerces "true"/"false" to boolean', () => {
        const val = { taskType: 'feature', priority: 'high', count: 5, active: 'true', tags: ['a'], rank: 'senior' };
        const r = repairFieldViolations(val, TestSchema);
        expect((r.value as any).active).toBe(true);
    });

    it('uses synonym map for taskType', () => {
        const val = { taskType: 'bugfix', priority: 'high', count: 5, active: true, tags: ['a'], rank: 'senior' };
        const r = repairFieldViolations(val, TestSchema);
        expect((r.value as any).taskType).toBe('fix');
    });
});

// ─── buildRepairMessage ─────────────────────────────────────────────────────

describe('buildRepairMessage', () => {
    it('includes previousRaw up to 16k without clipping', () => {
        const raw = 'x'.repeat(10000);
        const msg = buildRepairMessage('bad field', 'original', raw);
        expect(msg).toContain(raw);
        expect(msg).not.toContain('omitted');
    });

    it('middle-clips previousRaw over 16k', () => {
        const raw = 'y'.repeat(20000);
        const msg = buildRepairMessage('bad field', 'original', raw);
        expect(msg).toContain('omitted');
        // Should contain parts from start and end
        expect(msg).toContain('yyy');
    });

    it('omits raw JSON section when not provided', () => {
        const msg = buildRepairMessage('bad field', 'original');
        expect(msg).not.toContain('Your previous (invalid) JSON:');
    });
});

// ─── trimTruncatedArrayTails ────────────────────────────────────────────────

describe('trimTruncatedArrayTails', () => {
    const TaskSchema = z.object({
        id: z.string(),
        title: z.string(),
        layer: z.string(),
        suggestedTech: z.string(),
    });
    const PMSchema = z.object({
        userStories: z.array(z.object({ id: z.string(), title: z.string() })),
        tasks: z.array(TaskSchema),
    });

    it('passes through valid data unchanged', () => {
        const data = {
            userStories: [{ id: 'US-001', title: 'Story 1' }],
            tasks: [{ id: 'T-001', title: 'Task', layer: 'frontend', suggestedTech: 'React' }],
        };
        const result = trimTruncatedArrayTails(data, PMSchema);
        expect(result.ok).toBe(true);
        expect(result.trimmed).toHaveLength(0);
    });

    it('trims incomplete trailing task from truncated PM output', () => {
        const data = {
            userStories: [{ id: 'US-001', title: 'Story 1' }],
            tasks: [
                { id: 'T-001', title: 'Complete task', layer: 'frontend', suggestedTech: 'React' },
                { id: 'T-002', title: 'Truncated', layer: undefined, suggestedTech: undefined },
            ],
        };
        const result = trimTruncatedArrayTails(data, PMSchema);
        expect(result.ok).toBe(true);
        expect(result.trimmed).toHaveLength(1);
        expect(result.trimmed[0].path).toBe('tasks');
        expect(result.trimmed[0].removedCount).toBe(1);
        expect((result.value as any).tasks).toHaveLength(1);
        expect((result.value as any).tasks[0].id).toBe('T-001');
    });

    it('returns ok=false when errors are not at array tail', () => {
        const data = {
            userStories: [{ id: 'US-001', title: 'Story 1' }],
            tasks: [
                { id: 'T-001', title: 'Bad', layer: undefined, suggestedTech: undefined },
                { id: 'T-002', title: 'Good', layer: 'backend', suggestedTech: 'Node' },
            ],
        };
        const result = trimTruncatedArrayTails(data, PMSchema);
        expect(result.ok).toBe(false);
    });
});
