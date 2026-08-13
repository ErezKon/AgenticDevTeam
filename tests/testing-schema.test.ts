/**
 * TestReportSchema validation tests — Sub-Plan 09.
 *
 * Verifies that the schema refines reject the patterns that caused false greens.
 */
import { TestReportSchema } from '../src/agents/_shared/schemas/testing.schema';

function makeReport(overrides: Record<string, any> = {}) {
    return {
        type: 'unit',
        framework: 'jest',
        total: 5,
        passed: 4,
        failed: 1,
        skipped: 0,
        status: 'fail',
        source: 'executed',
        iterationIndex: 0,
        runnerError: false,
        failures: [{ testName: 'test1', error: 'err' }],
        agentId: 'qa-unit',
        cases: [{ testName: 'test1', storyId: 'US-001', acIndex: 0, status: 'fail' }],
        ...overrides,
    };
}

describe('TestReportSchema refines', () => {
    it('rejects { total: 0, status: "pass" }', () => {
        const result = TestReportSchema.safeParse(makeReport({
            total: 0,
            passed: 0,
            failed: 0,
            status: 'pass',
            failures: [],
            cases: [],
        }));
        expect(result.success).toBe(false);
    });

    it('accepts { total: 0, status: "inconclusive" }', () => {
        const result = TestReportSchema.safeParse(makeReport({
            total: 0,
            passed: 0,
            failed: 0,
            status: 'inconclusive',
            failures: [],
            cases: [],
        }));
        expect(result.success).toBe(true);
    });

    it('rejects when case counts exceed total', () => {
        const result = TestReportSchema.safeParse(makeReport({
            total: 2,
            passed: 3,
            failed: 1,
            skipped: 0,
        }));
        expect(result.success).toBe(false);
    });

    it('accepts valid report with source="executed"', () => {
        const result = TestReportSchema.safeParse(makeReport({
            source: 'executed',
        }));
        expect(result.success).toBe(true);
    });

    it('accepts valid report with source="claimed"', () => {
        const result = TestReportSchema.safeParse(makeReport({
            source: 'claimed',
        }));
        expect(result.success).toBe(true);
    });

    it('defaults source to "claimed" when omitted', () => {
        const { source, ...data } = makeReport();
        const result = TestReportSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.source).toBe('claimed');
        }
    });

    it('defaults cases to [] when omitted', () => {
        const { cases, ...data } = makeReport();
        const result = TestReportSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.cases).toEqual([]);
        }
    });

    it('requires storyId and acIndex in cases', () => {
        const result = TestReportSchema.safeParse(makeReport({
            cases: [{ testName: 'test1', status: 'pass' }],  // missing storyId and acIndex
        }));
        expect(result.success).toBe(false);
    });

    it('accepts coverage field', () => {
        const result = TestReportSchema.safeParse(makeReport({
            coverage: { lines: 62, statements: 62, branches: 55, functions: 70 },
        }));
        expect(result.success).toBe(true);
    });
});
