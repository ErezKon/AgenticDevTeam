import { z } from 'zod';

// ─── Test Plan ──────────────────────────────────────────────────────────────

export const TestPlanSchema = z.object({
    scope: z.string().describe('Overall testing scope and strategy'),
    unit: z.array(z.object({
        target: z.string().describe('What to test (component/function/module)'),
        description: z.string().describe('Test description'),
        framework: z.string().describe('Testing framework (e.g. "jest", "xunit", "pytest")'),
        storyId: z.string().describe('User story ID this test verifies (e.g. "US-001")'),
        acIndex: z.number().int().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
        moduleId: z.string().optional().describe('Module id from the repo contract (ties test placement to layout)'),
    })).describe('Unit test plan items'),
    integration: z.array(z.object({
        target: z.string().describe('Integration point to test'),
        description: z.string().describe('Test description'),
        framework: z.string().describe('Testing framework'),
        storyId: z.string().describe('User story ID this test verifies (e.g. "US-001")'),
        acIndex: z.number().int().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
        moduleId: z.string().optional().describe('Module id from the repo contract'),
    })).describe('Integration test plan items'),
    e2e: z.array(z.object({
        scenario: z.string().describe('User scenario to test'),
        description: z.string().describe('Step-by-step test description'),
        criticalPath: z.boolean().describe('Whether this is a critical user path'),
        storyId: z.string().describe('User story ID this test verifies (e.g. "US-001")'),
        acIndex: z.number().int().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
        moduleId: z.string().optional().describe('Module id from the repo contract'),
    })).describe('End-to-end test scenarios (Playwright)'),
    coverageTargets: z.object({
        unit: z.number().describe('Target unit test coverage percentage'),
        integration: z.number().describe('Target integration test coverage'),
        e2e: z.number().describe('Target e2e scenario coverage'),
    }).describe('Coverage targets'),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

// ─── Test Report ────────────────────────────────────────────────────────────

export const TestReportSchema = z.object({
    type: z.enum(['unit', 'integration', 'e2e']).describe('Test type'),
    framework: z.string().describe('Testing framework used'),
    total: z.number().int().nonnegative().describe('Total tests run'),
    passed: z.number().int().nonnegative().describe('Tests passed'),
    failed: z.number().int().nonnegative().describe('Tests failed'),
    skipped: z.number().int().nonnegative().describe('Tests skipped'),
    /** 'inconclusive' = the runner never executed (no tests, runner error, budget exhausted). */
    status: z.enum(['pass', 'fail', 'inconclusive']).describe('Overall status'),
    /** Provenance: "executed" reports come from a parsed runner; "claimed" from an LLM; "quality-gates" from the gate pipeline. */
    source: z.enum(['executed', 'claimed', 'quality-gates']).default('claimed').describe('Report provenance'),
    /** Bugfix iteration this report belongs to (routers must ignore stale reports). */
    iterationIndex: z.number().int().nonnegative().default(0).describe('Bugfix iteration index'),
    /** True when the runner itself failed to start (config error, missing dep). */
    runnerError: z.boolean().default(false).describe('Whether the test runner itself failed'),
    /** Code coverage percentages. */
    coverage: z.object({
        lines: z.number(),
        statements: z.number(),
        branches: z.number(),
        functions: z.number(),
    }).optional().describe('Code coverage percentages'),
    failures: z.array(z.object({
        testName: z.string().describe('Failing test name'),
        error: z.string().describe('Error message'),
        stackTrace: z.string().optional().describe('Stack trace if available'),
        screenshotPath: z.string().optional().describe('Screenshot path (e2e)'),
    })).describe('Details of failing tests'),
    agentId: z.string().describe('QA agent that produced this report'),
    cases: z.array(z.object({
        testName: z.string().describe('Test case name'),
        storyId: z.string().describe('User story ID this test verifies'),
        acIndex: z.number().int().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
        status: z.enum(['pass', 'fail', 'skip']).describe('Test case result'),
    })).default([]).describe('Per-case results with traceability links'),
})
.refine(r => !(r.total === 0 && r.status === 'pass'), {
    message: 'A report with 0 tests cannot have status "pass" — use "inconclusive".',
})
.refine(r => r.passed + r.failed + r.skipped <= r.total, {
    message: 'Case counts exceed total.',
});
export type TestReport = z.infer<typeof TestReportSchema>;
