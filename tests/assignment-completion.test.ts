/**
 * Tests for evidence-based assignment completion (Sub-Plan 06 SS6).
 */
import { completedIdsWithEvidence, incompleteBugs, type CompletionEvidence } from '../src/conductor/assignment-policy';

function makeEvidence(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
    return {
        assignmentId: 'ASSIGN-001',
        filesChanged: 5,
        declaredModulesPresent: 2,
        declaredModulesTotal: 2,
        gatePassed: true,
        merged: true,
        ...overrides,
    };
}

describe('completedIdsWithEvidence', () => {
    it('marks merged PR with real file changes and passing gate as completed', () => {
        const evidence = [makeEvidence()];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toContain('ASSIGN-001');
        expect(result.incomplete).toHaveLength(0);
    });

    it('rejects merged PR with 0 real file changes', () => {
        const evidence = [makeEvidence({ filesChanged: 0 })];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toHaveLength(0);
        expect(result.incomplete).toHaveLength(1);
        expect(result.incomplete[0].assignmentId).toBe('ASSIGN-001');
    });

    it('rejects unmerged PR', () => {
        const evidence = [makeEvidence({ merged: false })];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toHaveLength(0);
        expect(result.incomplete).toHaveLength(1);
    });

    it('rejects PR with failing gate', () => {
        const evidence = [makeEvidence({ gatePassed: false })];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toHaveLength(0);
        expect(result.incomplete).toHaveLength(1);
    });

    it('rejects PR with missing declared modules', () => {
        const evidence = [makeEvidence({ declaredModulesPresent: 1, declaredModulesTotal: 3 })];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toHaveLength(0);
        expect(result.incomplete).toHaveLength(1);
    });

    it('accepts PR when no modules are declared (declaredModulesTotal = 0)', () => {
        const evidence = [makeEvidence({ declaredModulesPresent: 0, declaredModulesTotal: 0 })];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toContain('ASSIGN-001');
    });

    it('handles multiple assignments independently', () => {
        const evidence = [
            makeEvidence({ assignmentId: 'A1' }),
            makeEvidence({ assignmentId: 'A2', filesChanged: 0 }),
            makeEvidence({ assignmentId: 'A3', gatePassed: false }),
        ];
        const result = completedIdsWithEvidence(evidence);
        expect(result.completed).toEqual(['A1']);
        expect(result.incomplete).toHaveLength(2);
    });
});

describe('incompleteBugs', () => {
    it('synthesises INCOMPLETE-* bugs for incomplete assignments', () => {
        const incomplete = [makeEvidence({ filesChanged: 0 })];
        const bugs = incompleteBugs(incomplete, {}, 3);
        expect(bugs).toHaveLength(1);
        expect(bugs[0].id).toBe('INCOMPLETE-ASSIGN-001');
        expect(bugs[0].severity).toBe('major');
        expect(bugs[0].actualBehavior).toContain('zero real source file changes');
    });

    it('caps re-dispatch at ASSIGNMENT_MAX_ATTEMPTS', () => {
        const incomplete = [makeEvidence({ filesChanged: 0, assignmentId: 'A1' })];
        const attemptCounts = { 'A1': 3 };
        const bugs = incompleteBugs(incomplete, attemptCounts, 3);
        expect(bugs).toHaveLength(0); // 3 >= maxAttempts(3), no more dispatches
    });

    it('allows dispatch when attempts < max', () => {
        const incomplete = [makeEvidence({ filesChanged: 0, assignmentId: 'A1' })];
        const attemptCounts = { 'A1': 2 };
        const bugs = incompleteBugs(incomplete, attemptCounts, 3);
        expect(bugs).toHaveLength(1);
    });

    it('includes multiple reasons in the bug description', () => {
        const incomplete = [makeEvidence({ filesChanged: 0, gatePassed: false })];
        const bugs = incompleteBugs(incomplete, {}, 3);
        expect(bugs[0].actualBehavior).toContain('zero real source file changes');
        expect(bugs[0].actualBehavior).toContain('quality gates did not pass');
    });
});
