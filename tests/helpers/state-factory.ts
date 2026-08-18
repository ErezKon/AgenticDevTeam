/**
 * Shared test fixture factory for ProjectStateType.
 *
 * Replaces the ~9 hand-copied `makeMinimalState` / `makeState` functions
 * that were duplicated across test files. Each copy was a full 48-field
 * object literal — adding a new field to state.ts required updating every copy.
 *
 * Usage:
 *   import { makeState } from './helpers/state-factory';
 *   const state = makeState({ phase: 'qa', bugs: [someBug] });
 */
import type { ProjectStateType } from '../../src/conductor/state';

/**
 * Build a fully-populated ProjectStateType with sensible test defaults.
 * Any field can be overridden via the `overrides` spread.
 */
export function makeState(overrides: Partial<ProjectStateType> = {}): ProjectStateType {
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
        gitContext: { token: 'test-token', owner: 'test-owner', repo: 'test-repo', defaultBranch: 'main' },
        codebaseAnalysis: null,
        architecture: {
            style: 'monolith',
            components: [],
            dataFlow: '',
            integrations: [],
            nonFunctional: [],
            mermaidDiagram: '',
        },
        repoContract: null,
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
