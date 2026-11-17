/**
 * Branch-level policy helpers for the PR workflow (pure, unit-testable).
 *
 * Plan 30 (pacman-live-analysis loop): kept out of orchestrator.ts, which is
 * already above the file-size guideline.
 */
import { MAX_BRANCH_WALL_MS } from '../../config';
import type { GateReport } from '../quality-gates';
import type { PRReview, PRReviewComment } from '../../agents/_shared/schemas/pr.schema';

/**
 * Plan 30-T: critical/major comments that still block the merge. A reviewer's
 * comments are superseded by that reviewer's NEXT review of the fixed code (they
 * re-raise anything still wrong), so only each reviewer's latest review counts.
 * Comments were created `resolved: false` and never updated, so an iteration-1
 * CRITICAL blocked the merge forever — even after the fix was approved
 * (pacman-live-analysis-8 PR #2; claudeopus5 PR #2).
 */
export function unresolvedBlockingComments(reviews: PRReview[]): PRReviewComment[] {
    const latest = new Map<string, PRReview>();
    for (const r of reviews) {
        const prev = latest.get(r.reviewerId);
        if (!prev || r.iteration >= prev.iteration) latest.set(r.reviewerId, r);
    }
    return [...latest.values()]
        .flatMap(r => r.comments)
        .filter(c => !c.resolved && (c.severity === 'critical' || c.severity === 'major'));
}

/**
 * Plan 30-M: branch wall-clock cap. `MAX_BRANCH_WALL_MS` covers a branch of up to
 * two assignments; larger branches scale linearly (`assignments / 2 ×`). A flat cap
 * stopped 3–6-assignment branches before their last assignment (claudeopus5: 1,379 s
 * against 900 s on a 6-assignment scaffold). 0 disables the cap.
 */
export function branchWallCap(assignmentCount: number, baseMs: number = MAX_BRANCH_WALL_MS): number {
    if (baseMs <= 0) return 0;
    return Math.max(baseMs, Math.round(baseMs * assignmentCount / 2));
}

/**
 * Plan 30-L / 30-P: gate steps that must keep a PR from being opened. Under `strict`
 * and `permissive`, decideMerge() treats any executed failing step AND a failed product
 * verification as hard merge blockers, so all of them block. `legacy` merges regardless,
 * so only typecheck/build block there.
 */
export function blockingGateSteps(
    gateReport: GateReport,
    policy: 'strict' | 'permissive' | 'legacy',
): string[] {
    const failed = gateReport.results.filter(r => !r.passed && !r.skipped).map(r => r.step);
    if (policy === 'legacy') return failed.filter(step => step === 'typecheck' || step === 'build');
    return gateReport.productVerify?.passed === false ? [...failed, 'product-verify'] : failed;
}
