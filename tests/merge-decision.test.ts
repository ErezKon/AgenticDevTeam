/**
 * Merge Decision — unit tests for Sub-Plan 07's evidence-based merge decision.
 *
 * Tests decideMerge() with real-world fixtures from retroboard3 and pacman8.
 */
import { decideMerge, type DecideMergeInput } from '../src/conductor/review-policy';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<DecideMergeInput> = {}): DecideMergeInput {
    return {
        approvals: 1,
        blockingComments: [],
        abstentions: 0,
        gateReport: { passed: true, results: [], roots: [], inconclusive: false } as any,
        integrityFindings: [],
        layoutViolations: [],
        filesChanged: 5,
        iterationsUsed: 3,
        policy: 'strict',
        quorum: 1,
        unmetCriteriaCount: 0,
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('decideMerge', () => {
    it('allows merge when all evidence checks pass (clean PR)', () => {
        const result = decideMerge(makeInput());
        expect(result.merge).toBe(true);
        expect(result.blockers).toHaveLength(0);
    });

    it('blocks merge when quality gates failed', () => {
        const result = decideMerge(makeInput({
            gateReport: { passed: false, results: [{ passed: false, skipped: false }], roots: [], inconclusive: false } as any,
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('Quality gates'))).toBe(true);
    });

    it('blocks merge on critical integrity findings', () => {
        const result = decideMerge(makeInput({
            integrityFindings: [
                { kind: 'script-changed', severity: 'critical', file: 'package.json', detail: 'build script replaced with echo' } as any,
            ],
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('integrity'))).toBe(true);
    });

    it('blocks merge on critical layout violations', () => {
        const result = decideMerge(makeInput({
            layoutViolations: [
                { kind: 'unknown-root', severity: 'critical', path: 'src/App.tsx', detail: 'file outside declared roots' },
            ],
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('layout'))).toBe(true);
    });

    it('blocks merge when filesChanged === 0 (empty PR)', () => {
        const result = decideMerge(makeInput({ filesChanged: 0 }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('No files'))).toBe(true);
    });

    it('blocks merge when quorum not met', () => {
        const result = decideMerge(makeInput({
            approvals: 0,
            abstentions: 2,
            quorum: 1,
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('Quorum'))).toBe(true);
    });

    it('blocks merge on unresolved critical review comments', () => {
        const result = decideMerge(makeInput({
            blockingComments: [
                { severity: 'critical', body: 'build script replaced', filePath: 'package.json' },
            ],
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('critical review comment'))).toBe(true);
    });

    // ── retroboard PR #10 fixture ───────────────────────────────────────
    it('blocks retroboard PR #10 (gate-gaming PR)', () => {
        const result = decideMerge(makeInput({
            approvals: 0,
            abstentions: 0,
            gateReport: { passed: true, results: [], roots: [], inconclusive: false } as any,
            integrityFindings: [
                { kind: 'script-changed', severity: 'critical', file: 'package.json', detail: 'build replaced with echo' } as any,
                { kind: 'trivial-test', severity: 'critical', file: '__tests__/math.test.js', detail: 'subject never imported' } as any,
            ],
            blockingComments: [
                { severity: 'major', body: 'trivial math test', filePath: '__tests__/math.test.js' },
                { severity: 'major', body: 'missing columns router', filePath: 'packages/backend/src/index.ts' },
            ],
            filesChanged: 3,
            quorum: 1,
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.length).toBeGreaterThanOrEqual(2);
    });

    // ── retroboard PR #14 fixture ───────────────────────────────────────
    it('blocks retroboard PR #14 (stub PR with no production code)', () => {
        const result = decideMerge(makeInput({
            approvals: 2,
            filesChanged: 1,
            // The assignment was "implement reconnection logic" but only changed setupTests.ts
            // The reviewers approved without criteriaVerdicts → they would be abstained
            // For this test: quorum met but empty PR is not the issue (1 file changed)
            // The real block: critical review comment for no production code
            blockingComments: [
                { severity: 'critical', body: 'No production code for a feature assignment', filePath: 'src/setupTests.ts' },
            ],
            quorum: 1,
        }));
        expect(result.merge).toBe(false);
    });

    // ── pacman PR #3 fixture ────────────────────────────────────────────
    it('blocks pacman PR #3 (quality gates failed)', () => {
        const result = decideMerge(makeInput({
            approvals: 2,
            gateReport: {
                passed: false,
                results: [
                    { passed: false, skipped: false },
                    { passed: false, skipped: false },
                    { passed: false, skipped: false },
                ],
                roots: [],
                inconclusive: false,
            } as any,
            quorum: 1,
        }));
        expect(result.merge).toBe(false);
        expect(result.blockers.some(b => b.includes('Quality gates'))).toBe(true);
    });

    // ── legacy policy ───────────────────────────────────────────────────
    it('legacy policy merges unconditionally', () => {
        const result = decideMerge(makeInput({
            policy: 'legacy',
            approvals: 0,
            gateReport: { passed: false, results: [], roots: [], inconclusive: false } as any,
            integrityFindings: [
                { kind: 'script-changed', severity: 'critical', file: 'package.json', detail: 'echo' } as any,
            ],
            filesChanged: 0,
        }));
        expect(result.merge).toBe(true);
    });

    // ── permissive policy ───────────────────────────────────────────────
    it('permissive policy allows merge when hard blockers clear (ignores review comments)', () => {
        const result = decideMerge(makeInput({
            policy: 'permissive',
            approvals: 0,
            blockingComments: [
                { severity: 'critical', body: 'bad code', filePath: 'a.ts' },
            ],
            filesChanged: 0,
            quorum: 1,
        }));
        expect(result.merge).toBe(true);
    });

    it('permissive policy blocks on critical integrity findings', () => {
        const result = decideMerge(makeInput({
            policy: 'permissive',
            integrityFindings: [
                { kind: 'script-changed', severity: 'critical', file: 'package.json', detail: 'echo' } as any,
            ],
        }));
        expect(result.merge).toBe(false);
    });
});
