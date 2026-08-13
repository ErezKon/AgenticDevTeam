/**
 * Review Policy — unit tests for Sub-Plan 07's review policy helpers.
 *
 * Tests isBlockingReview, evaluateQuorum, enforceCriteriaVerdicts,
 * reviewCommentsToBugs, and blockedPrBug.
 */
import {
    isBlockingReview,
    evaluateQuorum,
    enforceCriteriaVerdicts,
    reviewCommentsToBugs,
    blockedPrBug,
    type ReviewOutcome,
} from '../src/conductor/review-policy';

// ─── isBlockingReview ───────────────────────────────────────────────────────

describe('isBlockingReview', () => {
    it('returns true for critical severity', () => {
        expect(isBlockingReview([{ severity: 'critical' }])).toBe(true);
    });

    it('returns true for major severity', () => {
        expect(isBlockingReview([{ severity: 'major' }])).toBe(true);
    });

    it('returns false for minor severity only', () => {
        expect(isBlockingReview([{ severity: 'minor' }])).toBe(false);
    });

    it('returns false for suggestion severity only', () => {
        expect(isBlockingReview([{ severity: 'suggestion' }])).toBe(false);
    });

    it('returns false for info severity only', () => {
        expect(isBlockingReview([{ severity: 'info' }])).toBe(false);
    });

    it('returns true for undefined severity (Sub-Plan 07: inverted default)', () => {
        expect(isBlockingReview([{ severity: undefined }])).toBe(true);
    });

    it('returns true for empty string severity', () => {
        expect(isBlockingReview([{ severity: '' }])).toBe(true);
    });

    it('returns true when mixed: minor + critical', () => {
        expect(isBlockingReview([
            { severity: 'minor' },
            { severity: 'critical' },
        ])).toBe(true);
    });

    it('returns false for empty comments array', () => {
        expect(isBlockingReview([])).toBe(false);
    });
});

// ─── evaluateQuorum ─────────────────────────────────────────────────────────

describe('evaluateQuorum', () => {
    it('returns met=true when approvals >= quorum and no rejections', () => {
        const outcomes: ReviewOutcome[] = [
            { kind: 'approved', reviewerId: 'r1', output: { status: 'approved', summary: '', comments: [], criteriaVerdicts: [] } },
        ];
        const result = evaluateQuorum(outcomes, 1);
        expect(result.met).toBe(true);
        expect(result.approvals).toBe(1);
    });

    it('returns met=false when approvals < quorum', () => {
        const outcomes: ReviewOutcome[] = [
            { kind: 'abstained', reviewerId: 'r1', reason: 'recursion-limit', detail: 'hit limit' },
        ];
        const result = evaluateQuorum(outcomes, 1);
        expect(result.met).toBe(false);
        expect(result.abstentions).toBe(1);
    });

    it('abstentions do not count toward quorum', () => {
        const outcomes: ReviewOutcome[] = [
            { kind: 'approved', reviewerId: 'r1', output: { status: 'approved', summary: '', comments: [], criteriaVerdicts: [] } },
            { kind: 'abstained', reviewerId: 'r2', reason: 'schema-invalid', detail: 'garbage' },
        ];
        const result = evaluateQuorum(outcomes, 1);
        expect(result.met).toBe(true);
        expect(result.approvals).toBe(1);
        expect(result.abstentions).toBe(1);
    });

    it('allAbstained=true when every reviewer abstains', () => {
        const outcomes: ReviewOutcome[] = [
            { kind: 'abstained', reviewerId: 'r1', reason: 'error', detail: 'crash' },
            { kind: 'abstained', reviewerId: 'r2', reason: 'empty-output', detail: 'no content' },
        ];
        const result = evaluateQuorum(outcomes, 1);
        expect(result.allAbstained).toBe(true);
        expect(result.met).toBe(false);
    });

    it('met=false when there are rejections even if enough approvals', () => {
        const outcomes: ReviewOutcome[] = [
            { kind: 'approved', reviewerId: 'r1', output: { status: 'approved', summary: '', comments: [], criteriaVerdicts: [] } },
            { kind: 'changes_requested', reviewerId: 'r2', output: { status: 'changes_requested', summary: '', comments: [], criteriaVerdicts: [] } },
        ];
        const result = evaluateQuorum(outcomes, 1);
        expect(result.met).toBe(false);
        expect(result.rejections).toBe(1);
    });
});

// ─── enforceCriteriaVerdicts ────────────────────────────────────────────────

describe('enforceCriteriaVerdicts', () => {
    it('downgrades approved to changes_requested when criteriaVerdicts have unmet entries', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'looks good',
                comments: [],
                criteriaVerdicts: [
                    { storyId: 'US-001', acIndex: 0, met: true, evidence: 'src/app.ts:10' },
                    { storyId: 'US-001', acIndex: 1, met: false, evidence: 'not implemented' },
                ],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, true);
        expect(result.kind).toBe('changes_requested');
    });

    it('treats empty criteriaVerdicts on an assignment with criteria as abstained', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'approved',
                comments: [],
                criteriaVerdicts: [],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, true);
        expect(result.kind).toBe('abstained');
        if (result.kind === 'abstained') {
            expect(result.reason).toBe('empty-output');
        }
    });

    it('passes through approved when all criteria are met', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'approved',
                comments: [],
                criteriaVerdicts: [
                    { storyId: 'US-001', acIndex: 0, met: true, evidence: 'src/app.ts:10' },
                ],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, true);
        expect(result.kind).toBe('approved');
    });

    it('passes through changes_requested unchanged', () => {
        const outcome: ReviewOutcome = {
            kind: 'changes_requested',
            reviewerId: 'r1',
            output: {
                status: 'changes_requested',
                summary: 'needs work',
                comments: [{ filePath: 'a.ts', body: 'broken', severity: 'critical' }],
                criteriaVerdicts: [],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, true);
        expect(result.kind).toBe('changes_requested');
    });

    it('passes through approved with empty verdicts when assignment has no criteria', () => {
        const outcome: ReviewOutcome = {
            kind: 'approved',
            reviewerId: 'r1',
            output: {
                status: 'approved',
                summary: 'approved',
                comments: [],
                criteriaVerdicts: [],
            },
        };
        const result = enforceCriteriaVerdicts(outcome, false);
        expect(result.kind).toBe('approved');
    });
});

// ─── reviewCommentsToBugs ───────────────────────────────────────────────────

describe('reviewCommentsToBugs', () => {
    it('converts major comments to bugs', () => {
        const bugs = reviewCommentsToBugs(10, [
            { filePath: 'src/app.ts', body: 'Missing error handling', severity: 'major' },
            { filePath: 'src/db.ts', body: 'SQL injection', severity: 'critical' },
            { filePath: 'src/ui.ts', body: 'Naming convention', severity: 'minor' },
        ]);
        expect(bugs).toHaveLength(1);
        expect(bugs[0].id).toBe('REVIEW-10-0');
        expect(bugs[0].severity).toBe('major');
    });

    it('returns empty array when no major comments', () => {
        const bugs = reviewCommentsToBugs(5, [
            { filePath: 'a.ts', body: 'critical', severity: 'critical' },
            { filePath: 'b.ts', body: 'minor', severity: 'minor' },
        ]);
        expect(bugs).toHaveLength(0);
    });
});

// ─── blockedPrBug ───────────────────────────────────────────────────────────

describe('blockedPrBug', () => {
    it('generates a critical bug for a blocked PR', () => {
        const bug = blockedPrBug('feature/us-004', 10, ['Quality gates failed', 'No approvals']);
        expect(bug.id).toBe('PR-BLOCKED-feature/us-004');
        expect(bug.severity).toBe('critical');
        expect(bug.actualBehavior).toContain('Quality gates failed');
        expect(bug.actualBehavior).toContain('No approvals');
    });
});
