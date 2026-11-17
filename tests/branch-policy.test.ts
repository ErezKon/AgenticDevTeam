/**
 * Plan 30-L / 30-M: branch-level PR workflow policy (pure helpers), plus 30-I
 * dispatch-progress snapshots.
 */
import { blockingGateSteps, branchWallCap, unresolvedBlockingComments } from '../src/conductor/pr/branch-policy';
import type { PRReview } from '../src/agents/_shared/schemas/pr.schema';
import { mergeDispatchProgress } from '../src/agents/developers/dispatch-progress';
import type { GateReport } from '../src/conductor/quality-gates';

jest.mock('../src/utils/logger');

describe('branchWallCap (30-M)', () => {
    it('keeps the base cap for branches of up to two assignments', () => {
        expect(branchWallCap(1, 900_000)).toBe(900_000);
        expect(branchWallCap(2, 900_000)).toBe(900_000);
    });

    it('scales linearly beyond two assignments', () => {
        expect(branchWallCap(3, 900_000)).toBe(1_350_000);
        expect(branchWallCap(6, 900_000)).toBe(2_700_000);
    });

    it('stays disabled when the base cap is 0', () => {
        expect(branchWallCap(5, 0)).toBe(0);
    });
});

describe('blockingGateSteps (30-L / 30-P)', () => {
    const report = (results: Array<{ step: string; passed: boolean; skipped?: boolean }>, productVerifyPassed?: boolean): GateReport =>
        ({
            passed: results.every(r => r.passed || r.skipped),
            results: results.map(r => ({ command: r.step, output: '', durationMs: 1, skipped: false, ...r })),
            ...(productVerifyPassed === undefined ? {} : { productVerify: { passed: productVerifyPassed } }),
        }) as unknown as GateReport;

    it('treats a failing test step as blocking under strict and permissive (decideMerge would refuse the merge)', () => {
        const r = report([{ step: 'build', passed: true }, { step: 'test', passed: false }]);
        expect(blockingGateSteps(r, 'strict')).toEqual(['test']);
        expect(blockingGateSteps(r, 'permissive')).toEqual(['test']);
    });

    it('only blocks on typecheck/build under legacy, which merges regardless', () => {
        const r = report([{ step: 'test', passed: false }, { step: 'build', passed: false }], false);
        expect(blockingGateSteps(r, 'legacy')).toEqual(['build']);
    });

    it('ignores skipped steps', () => {
        expect(blockingGateSteps(report([{ step: 'lint', passed: false, skipped: true }]), 'strict')).toEqual([]);
    });

    // pacman-live-analysis-6 PR #2: gates passed, review approved, merge blocked by product verification.
    it('blocks on a failed product verification even when every gate step passed', () => {
        const r = report([{ step: 'build', passed: true }, { step: 'test', passed: true }], false);
        expect(blockingGateSteps(r, 'strict')).toEqual(['product-verify']);
        expect(blockingGateSteps(report([{ step: 'build', passed: true }], true), 'strict')).toEqual([]);
    });
});

describe('unresolvedBlockingComments (30-T)', () => {
    const review = (reviewerId: string, iteration: number, status: PRReview['status'], severities: string[]): PRReview => ({
        reviewerId, iteration, status,
        comments: severities.map((severity, i) => ({
            id: `${reviewerId}-iter${iteration}-${i}`, reviewerId, filePath: 'a.ts', body: `c${i}`, severity, resolved: false,
        })),
    });

    // pacman-live-analysis-8 PR #2: CRITICAL in iteration 1, fixed, approved in iteration 2 → was "1 unresolved critical".
    it('drops a reviewer\'s earlier comments once that reviewer reviews again', () => {
        const reviews = [
            review('principal-frontend', 1, 'changes_requested', ['critical', 'major', 'minor']),
            review('principal-frontend', 2, 'approved', ['minor', 'minor']),
        ];
        expect(unresolvedBlockingComments(reviews)).toEqual([]);
    });

    it('keeps criticals the reviewer re-raises in the latest review', () => {
        const reviews = [
            review('principal-frontend', 1, 'changes_requested', ['critical']),
            review('principal-frontend', 2, 'changes_requested', ['critical', 'minor']),
        ];
        expect(unresolvedBlockingComments(reviews).map(c => c.id)).toEqual(['principal-frontend-iter2-0']);
    });

    it('tracks every reviewer separately', () => {
        const reviews = [
            review('a', 1, 'changes_requested', ['critical']),
            review('b', 1, 'changes_requested', ['major']),
            review('a', 2, 'approved', []),
        ];
        expect(unresolvedBlockingComments(reviews).map(c => c.id)).toEqual(['b-iter1-0']);
    });
});

describe('mergeDispatchProgress (30-I)', () => {
    it('appends progress onto the full state instead of replacing it', () => {
        const base = {
            architecture: { components: [] }, assignments: [{ id: 'A1' }],
            pullRequests: [{ id: 'PR-old' }], fileChanges: [{ path: 'a.ts' }], completedAssignmentIds: ['A0'],
        };
        const merged = mergeDispatchProgress(base, [{ id: 'PR-1' }] as any, [{ path: 'b.ts' }] as any, ['A1']);

        expect(merged.architecture).toBe(base.architecture);
        expect(merged.assignments).toBe(base.assignments);
        expect(merged.pullRequests.map((p: any) => p.id)).toEqual(['PR-old', 'PR-1']);
        expect(merged.fileChanges.map((f: any) => f.path)).toEqual(['a.ts', 'b.ts']);
        expect(merged.completedAssignmentIds).toEqual(['A0', 'A1']);
        expect(base.pullRequests).toHaveLength(1);
    });
});
