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

// ─── Shared enrichment helper ───────────────────────────────────────────────

function enrichState(state: any): any {
    return {
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
}

// ─── Acceptance gate regressions (real logic tests) ─────────────────────────

describe('Plan 19 regression — acceptance gate', () => {
    it('pacman8: acceptance gate rejects the falsely-completed run', () => {
        const state = loadFixtureState('pacman8');
        const result = evaluateAcceptance(enrichState(state) as any);
        expect(result.status).not.toBe('accepted');
        expect(result.blockers.length).toBeGreaterThan(0);
    });

    it('retroboard3: acceptance gate rejects the falsely-completed run', () => {
        const state = loadFixtureState('retroboard3');
        const result = evaluateAcceptance(enrichState(state) as any);
        expect(result.status).not.toBe('accepted');
    });
});
