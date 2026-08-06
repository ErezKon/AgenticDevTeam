import { z } from 'zod';

// ─── Test Plan ──────────────────────────────────────────────────────────────

export const TestPlanSchema = z.object({
    scope: z.string().describe('Overall testing scope and strategy'),
    unit: z.array(z.object({
        target: z.string().describe('What to test (component/function/module)'),
        description: z.string().describe('Test description'),
        framework: z.string().describe('Testing framework (e.g. "jest", "xunit", "pytest")'),
        storyId: z.string().optional().describe('User story ID this test verifies (e.g. "US-001")'),
        acIndex: z.number().optional().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
    })).describe('Unit test plan items'),
    integration: z.array(z.object({
        target: z.string().describe('Integration point to test'),
        description: z.string().describe('Test description'),
        framework: z.string().describe('Testing framework'),
        storyId: z.string().optional().describe('User story ID this test verifies (e.g. "US-001")'),
        acIndex: z.number().optional().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
    })).describe('Integration test plan items'),
    e2e: z.array(z.object({
        scenario: z.string().describe('User scenario to test'),
        description: z.string().describe('Step-by-step test description'),
        criticalPath: z.boolean().describe('Whether this is a critical user path'),
        storyId: z.string().optional().describe('User story ID this test verifies (e.g. "US-001")'),
        acIndex: z.number().optional().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
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
    total: z.number().describe('Total tests run'),
    passed: z.number().describe('Tests passed'),
    failed: z.number().describe('Tests failed'),
    skipped: z.number().describe('Tests skipped'),
    status: z.enum(['pass', 'fail']).describe('Overall status'),
    failures: z.array(z.object({
        testName: z.string().describe('Failing test name'),
        error: z.string().describe('Error message'),
        stackTrace: z.string().optional().describe('Stack trace if available'),
        screenshotPath: z.string().optional().describe('Screenshot path (e2e)'),
    })).describe('Details of failing tests'),
    agentId: z.string().describe('QA agent that produced this report'),
    cases: z.array(z.object({
        testName: z.string().describe('Test case name'),
        storyId: z.string().optional().describe('User story ID this test verifies'),
        acIndex: z.number().optional().describe('0-based index into that story\'s acceptanceCriteria (-1 = whole story)'),
        status: z.enum(['pass', 'fail', 'skip']).describe('Test case result'),
    })).optional().describe('Per-case results with traceability links'),
});
export type TestReport = z.infer<typeof TestReportSchema>;
