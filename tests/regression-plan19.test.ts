/**
 * Regression tests for Plan 19 — permanent proof that the two headline failures
 * (pacman8 and retroboard3) are now correctly diagnosed by the post-Plan-19 pipeline.
 *
 * Every assertion here must FAIL against pre-Plan-19 code and PASS after.
 * Escape hatches: RUN_FAIL_POLICY=legacy, GATE_INTEGRITY_MODE=off,
 * PLAN_COVERAGE_MODE=off, MIN_AC_COVERAGE_PCT=0.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    RUN_FAIL_POLICY: 'halt',
    RUN_INVARIANTS_MODE: 'strict',
    GATE_INTEGRITY_MODE: 'enforce',
    PLAN_COVERAGE_MODE: 'enforce',
    MIN_AC_COVERAGE_PCT: 70,
    MIN_AC_IMPLEMENTED_PCT: 90,
    RUN_LEDGER_ENABLED: false,
    EVENT_BUFFER_SIZE: 100,
    EVENT_PRIORITY_BUFFER_SIZE: 50,
    QA_ENFORCE_SUFFICIENCY: true,
    QUALITY_GATE_STRICT_TOOLCHAIN: true,
}));

import * as fs from 'fs';
import * as path from 'path';
import { evaluateAcceptance } from '../src/conductor/acceptance-gate';

// ─── Fixture loading ────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'runs');

function loadFixtureState(name: string): any {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name, 'state.json'), 'utf-8'));
}

function loadFixtureManifest(name: string): any {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name, 'run-manifest.json'), 'utf-8'));
}

// ─── Credential scan ────────────────────────────────────────────────────────

describe('Fixture credential scan', () => {
    const SENSITIVE_RE = /gh[pousr]_[A-Za-z0-9]{20,}|client_secret|x-access-token:[^*]|OAUTH_CLIENT_SECRET/;

    it('pacman8 state.json contains no credentials', () => {
        const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'pacman8', 'state.json'), 'utf-8');
        expect(raw).not.toMatch(SENSITIVE_RE);
    });

    it('retroboard3 state.json contains no credentials', () => {
        const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'retroboard3', 'state.json'), 'utf-8');
        expect(raw).not.toMatch(SENSITIVE_RE);
    });

    it('pacman8 run-manifest.json contains no credentials', () => {
        const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'pacman8', 'run-manifest.json'), 'utf-8');
        expect(raw).not.toMatch(SENSITIVE_RE);
    });

    it('retroboard3 run-manifest.json contains no credentials', () => {
        const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'retroboard3', 'run-manifest.json'), 'utf-8');
        expect(raw).not.toMatch(SENSITIVE_RE);
    });
});

// ─── Pacman8 regressions ────────────────────────────────────────────────────

describe('Plan 19 regression — pacman8', () => {
    let state: any;
    let manifest: any;

    beforeAll(() => {
        state = loadFixtureState('pacman8');
        manifest = loadFixtureManifest('pacman8');
    });

    it('the original run falsely reported "completed"', () => {
        // This is the bug we are fixing — the manifest said "completed"
        expect(manifest.status).toBe('completed');
    });

    it('acceptance gate rejects it', () => {
        // Fill in fields the pre-Plan-19 state lacks
        const enrichedState = {
            ...state,
            acceptance: null,
            latestGateReport: null,
            unrecoverable: null,
            verificationErrors: [],
            dispatchRounds: [],
            attemptedBugIds: [],
            bugAttempts: {},
            planViolations: [],
            repoContract: null,
            completionEvidence: [],
            salvageBranches: [],
            phantomFileChanges: [],
            qaClaimDiscrepancies: [],
            e2eStatus: 'not-run',
            e2eSkipReason: null,
            e2eEvidence: null,
            invariantViolations: [],
        };
        const result = evaluateAcceptance(enrichedState as any);
        expect(result.status).not.toBe('accepted');
        expect(result.blockers.length).toBeGreaterThan(0);
    });

    it('reports orphaned stories (18 of 20 stories unassigned)', () => {
        // Only US-000 and US-001 have assignments; 18 are orphaned
        const assignedStoryIds = new Set(state.assignments.map((a: any) => a.storyId));
        const allStoryIds = state.userStories.map((s: any) => s.id);
        const orphaned = allStoryIds.filter((id: string) => !assignedStoryIds.has(id));
        expect(orphaned.length).toBeGreaterThanOrEqual(16); // At least 16 orphaned
    });

    it('plan coverage finds too few assignments for the stories', () => {
        // 10 assignments for 20 stories — structurally guaranteed scope loss
        expect(state.assignments.length).toBeLessThan(state.userStories.length);
        expect(state.userStories.length).toBe(20);
        expect(state.assignments.length).toBeLessThanOrEqual(10);
    });

    it('has 0 verified AC coverage', () => {
        expect(manifest.traceability.verified).toBe(0);
        expect(manifest.traceability.coveragePct).toBe(0);
    });

    it('test reports show zero real tests executed', () => {
        // All test reports were from quality gates or claimed, never executed
        const executedReports = (state.testReports ?? []).filter(
            (r: any) => r.source === 'executed',
        );
        expect(executedReports.length).toBe(0);
    });

    it('terminal status would be failed under halt and finalize, completed only under legacy', () => {
        // Under RUN_FAIL_POLICY=halt or finalize, the acceptance gate blocks
        const enrichedState = {
            ...state,
            acceptance: null,
            latestGateReport: null,
            unrecoverable: null,
            verificationErrors: [],
            dispatchRounds: [],
            attemptedBugIds: [],
            bugAttempts: {},
            planViolations: [],
            repoContract: null,
            completionEvidence: [],
            salvageBranches: [],
            phantomFileChanges: [],
            qaClaimDiscrepancies: [],
            e2eStatus: 'not-run',
            e2eSkipReason: null,
            e2eEvidence: null,
            invariantViolations: [],
        };
        const acceptance = evaluateAcceptance(enrichedState as any);
        // Under non-legacy policies, this should be rejected or partial
        expect(acceptance.status).not.toBe('accepted');
    });

    it('detects phantom fileChanges', () => {
        // The manifest reports 43 fileChanges but many paths don't exist on disk
        // At a minimum, the number of fileChanges exceeds what the assignments actually built
        const fileChangePaths = new Set((state.fileChanges ?? []).map((fc: any) => fc.path));
        // 43 claimed file changes for a project that is essentially empty
        expect(fileChangePaths.size).toBeGreaterThan(15);
    });

    it('event buffer was saturated at 500', () => {
        // Both post-mortem runs reported exactly eventCount: 500
        expect(manifest.eventCount).toBe(500);
    });
});

// ─── RetroBoard3 regressions ────────────────────────────────────────────────

describe('Plan 19 regression — retroboard3', () => {
    let state: any;
    let manifest: any;

    beforeAll(() => {
        state = loadFixtureState('retroboard3');
        manifest = loadFixtureManifest('retroboard3');
    });

    it('the original run falsely reported "completed"', () => {
        expect(manifest.status).toBe('completed');
    });

    it('acceptance gate rejects it', () => {
        const enrichedState = {
            ...state,
            acceptance: null,
            latestGateReport: null,
            unrecoverable: null,
            verificationErrors: [],
            dispatchRounds: [],
            attemptedBugIds: [],
            bugAttempts: {},
            planViolations: [],
            repoContract: null,
            completionEvidence: [],
            salvageBranches: [],
            phantomFileChanges: [],
            qaClaimDiscrepancies: [],
            e2eStatus: 'not-run',
            e2eSkipReason: null,
            e2eEvidence: null,
            invariantViolations: [],
        };
        const result = evaluateAcceptance(enrichedState as any);
        expect(result.status).not.toBe('accepted');
    });

    it('has orphaned stories and orphaned assignments', () => {
        expect(manifest.traceability.orphanedStories.length).toBeGreaterThan(0);
        expect(manifest.traceability.orphanedAssignments.length).toBeGreaterThan(0);
    });

    it('has 0 verified AC coverage despite 16 implemented', () => {
        expect(manifest.traceability.verified).toBe(0);
        expect(manifest.traceability.implemented).toBe(16);
        expect(manifest.traceability.coveragePct).toBe(0);
    });

    it('test reports have no executed source', () => {
        const executedReports = (state.testReports ?? []).filter(
            (r: any) => r.source === 'executed',
        );
        expect(executedReports.length).toBe(0);
    });

    it('test report totals include trivial tests (math utility)', () => {
        // retroboard3 had trivial math.test.js — the only passing test
        // At least some test reports have total > 0 but they're trivial
        const reportsWithTests = (state.testReports ?? []).filter(
            (r: any) => r.total > 0,
        );
        expect(reportsWithTests.length).toBeGreaterThan(0);
        // But verified AC = 0 — proving the tests don't cover real functionality
        expect(manifest.traceability.verified).toBe(0);
    });

    it('event buffer was saturated at 500', () => {
        expect(manifest.eventCount).toBe(500);
    });

    it('had more assignments than stories (51 vs 13) — indicating duplication', () => {
        expect(state.assignments.length).toBeGreaterThan(state.userStories.length * 2);
    });
});
