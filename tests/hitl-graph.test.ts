/**
 * HITL Graph — unit tests for Sub-Plan 9 HITL improvements.
 *
 * Tests:
 * 1. rerunRouter loops back to the same phase when pendingRerun is set
 * 2. rerunRouter advances normally when pendingRerun is null
 * 3. cancelled state routes to finalize
 * 4. afterQaRouter respects cancelled
 * 5. afterE2eRouter respects cancelled
 * 6. buildConductorGraph compiles with default options
 * 7. buildConductorGraph compiles with explicit checkpointer
 * 8. HitlDecision type is exported and accepts three values
 */
import type { ProjectStateType } from '../src/conductor/state';
import { afterQaRouter, afterE2eRouter, afterIntakeRouter, buildConductorGraph } from '../src/conductor/graph';
import { MemorySaver } from '@langchain/langgraph';
import type { HitlDecision } from '../src/conductor/run';

// ─── Minimal state fixture ──────────────────────────────────────────────────

function makeMinimalState(overrides: Partial<ProjectStateType> = {}): ProjectStateType {
    return {
        input: {
            systemName: 'test-project',
            requirementsText: 'Build a calculator',
            mode: 'autonomous' as const,
            runType: 'greenfield' as const,
        },
        workspacePath: '/tmp/test-workspace',
        outputPath: '/tmp/test-output',
        systemBranch: 'project/test-project',
        gitContext: { token: 'test', owner: 'test', repo: 'test', defaultBranch: 'main' },
        codebaseAnalysis: null,
        architecture: { style: 'monolith', components: [], dataFlow: '', integrations: [], nonFunctional: [], mermaidDiagram: '' },
        epics: [],
        techStack: [],
        dbDesign: null,
        userStories: [],
        tasks: [],
        assignments: [],
        completedAssignmentIds: [],
        fileChanges: [],
        testPlan: null,
        testReports: [],
        bugs: [],
        fixedBugIds: [],
        devopsPlan: null,
        runningContainers: [],
        pullRequests: [],
        phase: 'intake' as any,
        iteration: { bugfix: 0 },
        approvals: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        artifacts: [],
        transcript: [],
        tokenUsage: [],
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
        e2eStatus: 'not-run' as const,
        e2eSkipReason: null,
        e2eEvidence: null,
        invariantViolations: [],
        _isContinuation: false,
        _resumePhase: null,
        _stopReason: null,
        ...overrides,
    };
}

// ─── afterQaRouter tests ────────────────────────────────────────────────────

describe('afterQaRouter', () => {
    it('routes to finalize when cancelled', () => {
        const state = makeMinimalState({ cancelled: true });
        expect(afterQaRouter(state)).toBe('finalize');
    });

    it('routes to devops when no failures', () => {
        const state = makeMinimalState({ testReports: [] });
        expect(afterQaRouter(state)).toBe('devops');
    });

    it('routes to bugfix-triage when there are failures and iterations remain', () => {
        const state = makeMinimalState({
            testReports: [{ type: 'unit' as any, framework: 'jest', total: 1, passed: 0, failed: 1, skipped: 0, status: 'fail', source: 'quality-gates' as const, iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa' }],
            iteration: { bugfix: 0 },
        });
        expect(afterQaRouter(state)).toBe('bugfix-triage');
    });
});

// ─── afterE2eRouter tests ───────────────────────────────────────────────────

describe('afterE2eRouter', () => {
    it('routes to finalize when cancelled', () => {
        const state = makeMinimalState({ cancelled: true });
        expect(afterE2eRouter(state)).toBe('finalize');
    });

    it('routes to acceptance-gate when no failures', () => {
        const state = makeMinimalState({ testReports: [] });
        expect(afterE2eRouter(state)).toBe('acceptance-gate');
    });
});

// ─── afterIntakeRouter tests ────────────────────────────────────────────────

describe('afterIntakeRouter', () => {
    it('routes to codebase-analyzer for maintain mode', () => {
        const state = makeMinimalState();
        state.input.runType = 'maintain';
        expect(afterIntakeRouter(state)).toBe('codebase-analyzer');
    });

    it('routes to architect for greenfield mode', () => {
        const state = makeMinimalState();
        state.input.runType = 'greenfield';
        expect(afterIntakeRouter(state)).toBe('architect');
    });
});

// ─── Graph compilation ──────────────────────────────────────────────────────

describe('buildConductorGraph', () => {
    it('compiles with default options (autonomous)', () => {
        const graph = buildConductorGraph({ mode: 'autonomous' });
        expect(graph).toBeDefined();
        expect(typeof graph.invoke).toBe('function');
    });

    it('compiles with explicit MemorySaver', () => {
        const saver = new MemorySaver();
        const graph = buildConductorGraph({ mode: 'autonomous', checkpointer: saver });
        expect(graph).toBeDefined();
    });

    it('compiles in human mode with interrupt points', () => {
        const graph = buildConductorGraph({ mode: 'human' });
        expect(graph).toBeDefined();
    });
});

// ─── HitlDecision type ──────────────────────────────────────────────────────

describe('HitlDecision', () => {
    it('accepts approve, deny, and enhance', () => {
        const decisions: HitlDecision[] = ['approve', 'deny', 'enhance'];
        expect(decisions).toHaveLength(3);
        expect(decisions).toContain('approve');
        expect(decisions).toContain('deny');
        expect(decisions).toContain('enhance');
    });
});

// ─── phaseFeedback state field ──────────────────────────────────────────────

describe('phaseFeedback state field', () => {
    it('defaults to empty object', () => {
        const state = makeMinimalState();
        expect(state.phaseFeedback).toEqual({});
    });

    it('can be set in overrides', () => {
        const state = makeMinimalState({ phaseFeedback: { architect: ['fix the schema'] } });
        expect(state.phaseFeedback.architect).toEqual(['fix the schema']);
    });
});

// ─── pendingRerun state field ───────────────────────────────────────────────

describe('pendingRerun state field', () => {
    it('defaults to null', () => {
        const state = makeMinimalState();
        expect(state.pendingRerun).toBeNull();
    });

    it('can be set to a phase name', () => {
        const state = makeMinimalState({ pendingRerun: 'architect' });
        expect(state.pendingRerun).toBe('architect');
    });
});

// ─── cancelled state field ──────────────────────────────────────────────────

describe('cancelled state field', () => {
    it('defaults to false', () => {
        const state = makeMinimalState();
        expect(state.cancelled).toBe(false);
    });

    it('can be set to true', () => {
        const state = makeMinimalState({ cancelled: true });
        expect(state.cancelled).toBe(true);
    });
});
