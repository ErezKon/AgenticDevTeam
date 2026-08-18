/**
 * QA Node Resilience — unit tests for error boundaries.
 *
 * Verifies that qaNode and devopsNode catch agent failures (e.g. recursion
 * limit exceeded) and return a valid partial state instead of throwing,
 * ensuring the pipeline always reaches finalize.
 */
import { qaNode, devopsNode } from '../src/conductor/nodes';
import type { ProjectStateType } from '../src/conductor/state';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock OAuth so no real token is needed
jest.mock('../src/utils/oauth-auth.util', () => ({
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
}));

// Mock the QA agents — QA Lead returns a test plan, QA Unit throws
jest.mock('../src/agents/qa/qa.agents', () => ({
    createQaLeadAgent: jest.fn(() => ({
        invoke: jest.fn().mockResolvedValue({
            messages: [{ role: 'assistant', content: JSON.stringify({
                testPlan: {
                    scope: 'Full test coverage for calculator',
                    unit: [{ target: 'Calculator', description: 'test-1', framework: 'jest', storyId: 'US-001', acIndex: 0 }],
                    integration: [],
                    e2e: [],
                    coverageTargets: { unit: 80, integration: 60, e2e: 40 },
                },
            }) }],
        }),
    })),
    createQaUnitAgent: jest.fn(() => ({
        invoke: jest.fn().mockRejectedValue(
            new Error('Recursion limit of 60 reached without hitting a stop condition'),
        ),
    })),
    createQaE2eAgent: jest.fn(() => ({
        invoke: jest.fn().mockRejectedValue(
            new Error('Recursion limit of 60 reached without hitting a stop condition'),
        ),
    })),
}));

// Mock DevOps agent — throws recursion limit error
jest.mock('../src/agents/devops/devops.agent', () => ({
    createDevOpsAgent: jest.fn(() => ({
        invoke: jest.fn().mockRejectedValue(
            new Error('Recursion limit of 60 reached without hitting a stop condition'),
        ),
    })),
}));

// Mock artifact writer
jest.mock('../src/agents/_shared/artifact', () => ({
    writeArtifact: jest.fn(() => ({ agentId: 'mock', path: '/mock/path' })),
}));

// Mock Playwright MCP
jest.mock('../src/tools/mcp/playwright-mcp', () => ({
    getPlaywrightMcpTools: jest.fn().mockResolvedValue([]),
    closePlaywrightMcp: jest.fn().mockResolvedValue(undefined),
}));

// Mock security-gates (no scanner binaries required in tests)
jest.mock('../src/conductor/security-gates', () => ({
    runSecurityGates: jest.fn().mockReturnValue({
        findings: [],
        passed: true,
    }),
    synthesiseSecurityBugs: jest.fn().mockReturnValue([]),
    securityReportToMarkdown: jest.fn().mockReturnValue(':white_check_mark: Security scan clean'),
}));

// Mock devops-verify (no Docker required in tests)
jest.mock('../src/conductor/devops-verify', () => ({
    verifyDeployment: jest.fn().mockResolvedValue({
        buildStatus: 'skipped',
        runStatus: 'skipped',
        serviceUrls: [],
        healthChecks: [],
        containerNames: [],
        logs: '',
        mode: 'none',
    }),
    teardownDeployment: jest.fn().mockResolvedValue(undefined),
    chooseDeploymentMode: jest.fn().mockReturnValue('none'),
}));

// Mock retryWithBackoff to just call the function directly (no retries in tests)
jest.mock('../src/utils/retry', () => ({
    retryWithBackoff: jest.fn(async (fn: () => Promise<any>) => fn()),
}));

// Mock token tracker
jest.mock('../src/utils/token-tracker', () => ({
    tokenTracker: {
        reset: jest.fn(),
        setRunStatus: jest.fn(),
        enablePersistence: jest.fn(),
        setRefreshCallback: jest.fn(),
        getOutputPath: jest.fn().mockReturnValue('/mock/output'),
        getSnapshot: jest.fn().mockReturnValue([]),
        getRunSummary: jest.fn().mockReturnValue({
            totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
            byAgent: [], byPhase: [], byModel: [],
        }),
        startInvocation: jest.fn().mockReturnValue('inv-mock-0'),
        endInvocation: jest.fn(),
        getInvocationSummaries: jest.fn().mockReturnValue([]),
    },
}));

jest.mock('../src/utils/token-usage-extractor', () => ({
    extractTokenUsageFromMessages: jest.fn().mockReturnValue(null),
}));

jest.mock('../src/utils/token-report', () => ({
    refreshTokenReport: jest.fn(),
    generateTokenReport: jest.fn().mockReturnValue({ jsonPath: '/mock.json', htmlPath: '/mock.html' }),
}));

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
    logToolAction: jest.fn(),
}));

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
        branchAssignments: [],
        phase: 'qa' as any,
        iteration: { bugfix: 0 },
        approvals: [],
        pendingRerun: null,
        phaseFeedback: {},
        cancelled: false,
        artifacts: [],
        transcript: [],
        tokenUsage: [],
        configBaseline: null,
        acceptance: null,
        latestGateReport: null,
        unrecoverable: null,
        verificationErrors: [],
        dispatchRounds: [],
        attemptedBugIds: [],
        bugAttempts: {},
        outputIntegrity: [],
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('QA Node Resilience', () => {
    it('qaNode should resolve (not throw) when qa-unit agent throws a recursion limit error', async () => {
        const state = makeMinimalState();

        // qaNode must NOT throw — it should catch the QA Unit error gracefully
        const result = await qaNode(state);

        // Should still return phase 'qa'
        expect(result.phase).toBe('qa');

        // Should have transcript entries (QA Lead success + QA Unit failure)
        expect(result.transcript).toBeDefined();
        expect(result.transcript!.length).toBeGreaterThanOrEqual(1);

        // One of the transcript entries should mention QA Unit failure
        const failureEntry = result.transcript!.find(
            (t: any) => t.message.includes('QA Unit failed'),
        );
        expect(failureEntry).toBeDefined();
        expect(failureEntry!.message).toContain('Recursion limit');
    });

    it('devopsNode should resolve (not throw) when devops agent throws a recursion limit error', async () => {
        const state = makeMinimalState({ phase: 'devops' as any });

        // devopsNode must NOT throw — it should catch the error gracefully
        const result = await devopsNode(state);

        // Must still return (not throw) — the graph routes devops → e2e → finalize
        expect(result.phase).toBe('devops');

        // Should have a transcript entry about the failure
        expect(result.transcript).toBeDefined();
        const failureEntry = result.transcript!.find(
            (t: any) => t.message.includes('DevOps agent failed'),
        );
        expect(failureEntry).toBeDefined();
        expect(failureEntry!.message).toContain('Recursion limit');

        // Should return safe defaults for devopsPlan.
        // Sub-Plan 11: agent claims are always overwritten by verification.
        // The mock returns buildStatus: 'skipped' (no Docker), so the agent's
        // 'failed' is correctly replaced with the verified 'skipped'.
        expect(result.devopsPlan).toBeDefined();
        expect(result.devopsPlan!.buildStatus).toBe('skipped');
        expect(result.devopsPlan!.runStatus).toBe('skipped');
    });

    it('qaNode should still produce test reports and artifacts from QA Lead even when QA Unit fails', async () => {
        const state = makeMinimalState();

        const result = await qaNode(state);

        // Test plan from QA Lead should still be set
        expect(result.testPlan).toBeDefined();
        expect(result.testPlan!.unit).toEqual([{ target: 'Calculator', description: 'test-1', framework: 'jest', storyId: 'US-001', acIndex: 0 }]);

        // Bugs array should exist (empty since QA Unit failed before producing any)
        expect(result.bugs).toBeDefined();
        expect(Array.isArray(result.bugs)).toBe(true);

        // File changes should default to empty
        expect(result.fileChanges).toEqual([]);
    });
});
