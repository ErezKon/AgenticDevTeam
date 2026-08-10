/**
 * Tests for src/utils/structured-output.ts
 *
 * Covers: parseAgentJson, summariseZodIssues, validateAgentOutput,
 *         buildRepairMessage, and validation stats.
 */
import { z } from 'zod';
import {
    parseAgentJson,
    summariseZodIssues,
    validateAgentOutput,
    buildRepairMessage,
    getValidationStats,
    _resetValidationStats,
    _recordValidated,
    _recordRepaired,
    _recordFailed,
} from '../src/utils/structured-output';

// Re-use the project's TestReportSchema for realistic tests
import { TestReportSchema } from '../src/agents/_shared/schemas/testing.schema';

// ─── parseAgentJson ─────────────────────────────────────────────────────────

describe('parseAgentJson', () => {
    test('parses bare JSON object', () => {
        const result = parseAgentJson('{"foo": "bar", "n": 42}');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual({ foo: 'bar', n: 42 });
        }
    });

    test('parses ```json fenced block', () => {
        const raw = 'Here is the analysis:\n```json\n{"a": 1}\n```\nDone.';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual({ a: 1 });
        }
    });

    test('parses ``` fenced block without json tag', () => {
        const raw = 'Result:\n```\n{"b": 2}\n```';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual({ b: 2 });
        }
    });

    test('extracts first {...} run from prose', () => {
        const raw = 'The output is: {"key": "value"} and that is all.';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual({ key: 'value' });
        }
    });

    test('returns ok: false on unparseable input', () => {
        const result = parseAgentJson('This is just text with no JSON at all.');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Could not extract JSON');
            expect(result.error).toContain('This is just text');
        }
    });

    test('returns ok: false on empty string', () => {
        const result = parseAgentJson('');
        expect(result.ok).toBe(false);
    });

    test('handles JSON array', () => {
        const result = parseAgentJson('[1, 2, 3]');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual([1, 2, 3]);
        }
    });

    test('prefers direct parse over code fence extraction', () => {
        // The whole string is valid JSON, so strategy 1 wins
        const raw = '{"result": "ok"}';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toEqual({ result: 'ok' });
        }
    });

    test('handles nested JSON with code fence', () => {
        const raw = '```json\n{"nested": {"deep": true}, "arr": [1,2]}\n```';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.value as any).nested.deep).toBe(true);
        }
    });

    // ── Strategy 4: jsonrepair ──────────────────────────────────────────

    test('repairs truncated JSON (missing closing braces)', () => {
        // Simulates a response truncated by max_tokens
        const raw = '{"dbDesign":{"engine":"PostgreSQL","rationale":"Good choice","entities":[{"name":"users","columns":[{"name":"id","type":"int"}]}';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.value as any).dbDesign.engine).toBe('PostgreSQL');
        }
    });

    test('repairs JSON with trailing commas', () => {
        const raw = '{"name": "test", "items": [1, 2, 3,],}';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.value as any).name).toBe('test');
            expect((result.value as any).items).toEqual([1, 2, 3]);
        }
    });

    test('repairs JSON with single quotes', () => {
        const raw = "{'key': 'value', 'num': 42}";
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.value as any).key).toBe('value');
        }
    });

    test('repairs truncated JSON embedded in prose', () => {
        const raw = 'Here is the result: {"data": {"items": [1, 2, 3';
        const result = parseAgentJson(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.value as any).data.items).toEqual([1, 2, 3]);
        }
    });
});

// ─── summariseZodIssues ─────────────────────────────────────────────────────

/** Helper: get real Zod issues from a failed safeParse. */
function getIssues(schema: z.ZodTypeAny, value: unknown): z.ZodIssue[] {
    const result = schema.safeParse(value);
    if (result.success) throw new Error('Expected safeParse to fail');
    return result.error.issues;
}

describe('summariseZodIssues', () => {
    test('formats path: message lines', () => {
        const schema = z.object({
            status: z.string(),
            total: z.number(),
        });
        const issues = getIssues(schema, { status: 123 }); // status wrong type, total missing
        const summary = summariseZodIssues(issues);
        // Should mention at least one of the failing fields
        expect(summary).toContain('status');
    });

    test('caps at max and shows overflow count', () => {
        // Create a schema with many required fields to produce many issues
        const fields: Record<string, z.ZodTypeAny> = {};
        for (let i = 0; i < 15; i++) {
            fields[`field${i}`] = z.string();
        }
        const schema = z.object(fields);
        const issues = getIssues(schema, {}); // all fields missing
        expect(issues.length).toBeGreaterThanOrEqual(15);
        const summary = summariseZodIssues(issues, 5);
        const lines = summary.split('\n');
        // 5 issue lines + 1 overflow line
        expect(lines).toHaveLength(6);
        expect(lines[5]).toContain('more issue(s)');
    });

    test('handles empty path with (root)', () => {
        const schema = z.object({ x: z.number() });
        const issues = getIssues(schema, 'not an object');
        const summary = summariseZodIssues(issues);
        expect(summary).toContain('(root)');
    });

    test('handles nested path', () => {
        const schema = z.object({
            architecture: z.object({
                style: z.string(),
            }),
        });
        const issues = getIssues(schema, { architecture: {} });
        const summary = summariseZodIssues(issues);
        expect(summary).toContain('architecture.style');
    });
});

// ─── validateAgentOutput ────────────────────────────────────────────────────

describe('validateAgentOutput', () => {
    const SimpleSchema = z.object({
        name: z.string(),
        count: z.number(),
    });

    test('valid object passes', () => {
        const result = validateAgentOutput(SimpleSchema, { name: 'test', count: 5 });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({ name: 'test', count: 5 });
        expect(result.issues).toBe('');
        expect(result.repaired).toBe(false);
    });

    test('invalid object fails with issues', () => {
        const result = validateAgentOutput(SimpleSchema, { name: 'test' });
        expect(result.ok).toBe(false);
        expect(result.issues).toContain('count');
    });

    test('completely wrong type fails', () => {
        const result = validateAgentOutput(SimpleSchema, 'not an object');
        expect(result.ok).toBe(false);
        expect(result.issues).toContain('(root)');
    });

    test('TestReportSchema missing status -> fails with status named', () => {
        const incomplete = {
            type: 'unit',
            framework: 'jest',
            total: 10,
            passed: 8,
            failed: 2,
            skipped: 0,
            // missing: status
            failures: [],
            agentId: 'qa-unit',
        };
        const result = validateAgentOutput(TestReportSchema, incomplete);
        expect(result.ok).toBe(false);
        expect(result.issues).toContain('status');
    });

    test('valid TestReport passes', () => {
        const valid = {
            type: 'unit',
            framework: 'jest',
            total: 10,
            passed: 10,
            failed: 0,
            skipped: 0,
            status: 'pass',
            failures: [],
            agentId: 'qa-unit',
        };
        const result = validateAgentOutput(TestReportSchema, valid);
        expect(result.ok).toBe(true);
    });

    test('extra fields are stripped by schema', () => {
        const withExtra = { name: 'test', count: 5, extra: 'ignored' };
        const result = validateAgentOutput(SimpleSchema, withExtra);
        expect(result.ok).toBe(true);
        // Zod strips extra fields in default mode
        expect(result.value).toEqual({ name: 'test', count: 5 });
    });
});

// ─── buildRepairMessage ─────────────────────────────────────────────────────

describe('buildRepairMessage', () => {
    test('includes issues and correction instructions', () => {
        const issues = '- status: Required\n- total: Expected number';
        const msg = buildRepairMessage(issues, 'original request');
        expect(msg).toContain('did not match the required JSON schema');
        expect(msg).toContain('- status: Required');
        expect(msg).toContain('- total: Expected number');
        expect(msg).toContain('Return the SAME information');
        expect(msg).toContain('Do not add commentary');
    });

    test('does not include the original request in output', () => {
        const msg = buildRepairMessage('- x: bad', 'do something');
        // The original request is kept for reference but not echoed
        expect(msg).not.toContain('do something');
    });

    test('includes previousRaw when supplied', () => {
        const issues = '- status: Required';
        const previousRaw = '{"name": "test", "count": 5}';
        const msg = buildRepairMessage(issues, 'original request', previousRaw);
        expect(msg).toContain('Your previous (invalid) JSON:');
        expect(msg).toContain(previousRaw);
    });

    test('clips previousRaw to 4000 chars', () => {
        const issues = '- status: Required';
        const bigRaw = 'x'.repeat(6000);
        const msg = buildRepairMessage(issues, 'original request', bigRaw);
        expect(msg).toContain('Your previous (invalid) JSON:');
        expect(msg).toContain('2000 chars truncated');
        // Should contain first 4000 chars
        expect(msg).toContain('x'.repeat(4000));
        // Should NOT contain all 6000
        expect(msg).not.toContain('x'.repeat(6000));
    });

    test('does not add previousRaw section when not supplied', () => {
        const msg = buildRepairMessage('- x: bad', 'do something');
        expect(msg).not.toContain('Your previous (invalid) JSON:');
    });
});

// ─── Validation Stats ───────────────────────────────────────────────────────

describe('validation stats', () => {
    beforeEach(() => {
        _resetValidationStats();
    });

    test('initial stats are zero', () => {
        const stats = getValidationStats();
        expect(stats).toEqual({ validated: 0, repaired: 0, failed: 0 });
    });

    test('recording increments correctly', () => {
        _recordValidated();
        _recordValidated();
        _recordRepaired();
        _recordFailed();
        const stats = getValidationStats();
        expect(stats.validated).toBe(2);
        expect(stats.repaired).toBe(1);
        expect(stats.failed).toBe(1);
    });

    test('getValidationStats returns a defensive copy', () => {
        _recordValidated();
        const stats1 = getValidationStats();
        _recordValidated();
        const stats2 = getValidationStats();
        // stats1 should not have been mutated
        expect(stats1.validated).toBe(1);
        expect(stats2.validated).toBe(2);
    });

    test('reset clears all counters', () => {
        _recordValidated();
        _recordRepaired();
        _recordFailed();
        _resetValidationStats();
        expect(getValidationStats()).toEqual({ validated: 0, repaired: 0, failed: 0 });
    });
});
