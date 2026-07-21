import { z } from 'zod';
import { TestPlanSchema, TestReportSchema, BugSchema, FileChangeSchema } from '../../_shared/base-schemas';

export const QaLeadOutputSchema = z.object({
    testPlan: TestPlanSchema.describe('Complete test plan'),
});

export const QaUnitOutputSchema = z.object({
    testReport: TestReportSchema.describe('Unit/integration test results'),
    fileChanges: z.array(FileChangeSchema).optional().describe('Test files created'),
    bugs: z.array(BugSchema).optional().describe('Bugs found during testing'),
});

export const QaE2eOutputSchema = z.object({
    testReport: TestReportSchema.describe('E2E test results'),
    bugs: z.array(BugSchema).optional().describe('Bugs found during e2e testing'),
});

export type QaLeadOutput = z.infer<typeof QaLeadOutputSchema>;
export type QaUnitOutput = z.infer<typeof QaUnitOutputSchema>;
export type QaE2eOutput = z.infer<typeof QaE2eOutputSchema>;
