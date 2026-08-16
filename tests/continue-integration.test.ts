/**
 * Integration tests for the Continue Run feature (Plan 23, Sub-Plan 09).
 *
 * Tests the full flow from artifact collection to state reconstruction,
 * including git reconciliation checks and singleton rehydration.
 *
 * These tests create realistic on-disk fixtures (state.json, manifest,
 * ledger.jsonl) and exercise the public APIs end-to-end — but do NOT
 * invoke the LangGraph conductor, so they are safe and fast.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    OUTPUTS_DIR: '/tmp/adt-integration-test-outputs',
    GITHUB_TOKEN: 'integration-test-token',
    GITHUB_OWNER: 'int-test-owner',
    GITHUB_REPO: 'int-test-repo',
    GITHUB_PROJECT_TOKEN: '',
    GITHUB_PROJECT_OWNER: '',
    GIT_DEFAULT_BRANCH: 'main',
    RUN_LEDGER_ENABLED: false,
    CONTINUE_GIT_RECONCILE: true,
    CONTINUE_CLOSE_STALE_PRS: true,
    CONTINUE_TOKEN_CARRY_FORWARD: true,
    EVENT_BUFFER_SIZE: 100,
    EVENT_PRIORITY_BUFFER_SIZE: 50,
}));

jest.mock('../src/utils/run-ledger', () => ({
    readLedger: jest.fn().mockReturnValue([]),
    appendLedger: jest.fn(),
    initLedger: jest.fn(),
}));

jest.mock('../src/utils/response-log', () => ({
    readResponseLogIndex: jest.fn().mockReturnValue([]),
    initResponseLog: jest.fn(),
}));

jest.mock('../src/utils/git-exec', () => ({
    gitExec: jest.fn().mockReturnValue('Error: not a git repo'),
    gitExecVerbose: jest.fn().mockReturnValue({ ok: false, stdout: '', stderr: 'not a repo' }),
}));

jest.mock('../src/utils/logger', () => ({
    getLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
    setRunLogPath: jest.fn(),
}));

jest.mock('../src/utils/token-tracker', () => ({
    tokenTracker: {
        enablePersistence: jest.fn(),
        setRefreshCallback: jest.fn(),
        recordFromPreviousRun: jest.fn(),
        setRunStatus: jest.fn(),
    },
}));

jest.mock('../src/utils/token-report', () => ({
    refreshTokenReport: jest.fn(),
}));

jest.mock('../src/utils/run-budget', () => ({
    startRunBudget: jest.fn(),
}));

jest.mock('../src/utils/github-local', () => ({
    GITHUB_MODE: 'local',
    setLocalBareRepoPath: jest.fn(),
}));

jest.mock('../src/conductor/pr-workflow', () => ({
    setLocalBareRepoPath: jest.fn(),
}));

import {
    collectRunState,
    reconstructState,
    rehydrateSingletons,
    type CollectedRunState,
} from '../src/conductor/continue';

import { readLedger, initLedger } from '../src/utils/run-ledger';
import { setRunLogPath } from '../src/utils/logger';
import { tokenTracker } from '../src/utils/token-tracker';
import { readResponseLogIndex, initResponseLog } from '../src/utils/response-log';
import { refreshTokenReport } from '../src/utils/token-report';
import { startRunBudget } from '../src/utils/run-budget';
import type { LedgerEntry } from '../src/utils/run-ledger';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'adt-intg-test-'));
}

function writeJson(dir: string, filename: string, data: any): void {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
}

/** Create a realistic mock stopped run on disk. */
function createMockStoppedRun(outputDir: string, opts: {
    systemName?: string;
    runType?: string;
    crashPhase?: string;
    completedPhases?: string[];
    withArchitecture?: boolean;
    withEpics?: boolean;
    withStories?: boolean;
    withTasks?: boolean;
    withAssignments?: boolean;
    withFileChanges?: boolean;
    withPullRequests?: boolean;
    withTestReports?: boolean;
    withTokenUsage?: boolean;
    workspacePath?: string;
    bugfixIteration?: number;
} = {}) {
    const {
        systemName = 'test-app',
        runType = 'greenfield',
        crashPhase = 'development',
        completedPhases = ['intake', 'architect', 'product-manager', 'dba', 'team-leader'],
        withArchitecture = true,
        withEpics = true,
        withStories = true,
        withTasks = true,
        withAssignments = true,
        withFileChanges = false,
        withPullRequests = false,
        withTestReports = false,
        withTokenUsage = true,
        workspacePath = path.join(outputDir, 'workspace'),
        bugfixIteration = 0,
    } = opts;

    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });

    // Build state.json
    const state: Record<string, any> = {
        input: {
            systemName,
            requirementsText: 'Build a test application',
            mode: 'autonomous',
            runType,
        },
        workspacePath,
        outputPath: outputDir,
        systemBranch: `project/${systemName}`,
        gitContext: {
            token: '***REDACTED***',
            owner: 'mock-owner',
            repo: 'mock-repo',
            defaultBranch: 'main',
        },
        phase: crashPhase,
        iteration: { bugfix: bugfixIteration },
        codebaseAnalysis: null,
        architecture: withArchitecture ? { style: 'monolith', components: [{ name: 'App', type: 'frontend' }], dataFlow: '', integrations: [], nonFunctional: [], mermaidDiagram: '' } : null,
        epics: withEpics ? [{ id: 'EPIC-001', title: 'Core Features', description: 'Build the core features', priority: 'must-have' }] : [],
        techStack: [{ name: 'React', reason: 'Modern frontend' }],
        dbDesign: null,
        userStories: withStories ? [{ id: 'US-001', title: 'User Login', description: 'As a user, I want to log in', epicId: 'EPIC-001', acceptanceCriteria: ['AC1'] }] : [],
        tasks: withTasks ? [{ id: 'T-001', title: 'Implement login form', storyId: 'US-001', layer: 'frontend' }] : [],
        assignments: withAssignments ? [{ id: 'A-001', taskIds: ['T-001'], devAgentId: 'junior-react', branchName: 'feature/login', reviewers: ['senior-frontend', 'principal-frontend'] }] : [],
        completedAssignmentIds: withFileChanges ? ['A-001'] : [],
        fileChanges: withFileChanges ? [{ path: 'src/Login.tsx', action: 'create', agentId: 'junior-react' }] : [],
        testPlan: null,
        testReports: withTestReports ? [{ type: 'unit', status: 'pass', framework: 'jest', total: 5, passed: 5, failed: 0, skipped: 0, source: 'quality-gates', iterationIndex: 0, runnerError: false, cases: [], failures: [], agentId: 'qa-unit' }] : [],
        bugs: [],
        fixedBugIds: [],
        devopsPlan: null,
        runningContainers: [],
        pullRequests: withPullRequests ? [{ branchName: 'feature/login', status: 'merged', number: 1, title: 'feat: login', assignmentIds: ['A-001'] }] : [],
        branchAssignments: [],
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
        e2eStatus: 'not-run',
        e2eSkipReason: null,
        e2eEvidence: null,
        invariantViolations: [],
    };
    writeJson(outputDir, 'state.json', state);

    // Build run-manifest.json
    const manifest = {
        generatedAt: new Date().toISOString(),
        status: 'crashed',
        systemName,
        runType,
        finalPhase: crashPhase,
        tokenUsage: { totalCalls: 50, totalTokens: 25000, totalInputTokens: 20000 },
        counts: { epics: 1, stories: 1, tasks: 1, assignments: 1 },
    };
    writeJson(outputDir, 'run-manifest.json', manifest);

    // Build ledger entries
    const ledger: LedgerEntry[] = [];
    for (const phase of completedPhases) {
        ledger.push({
            t: new Date().toISOString(),
            kind: 'phase',
            phase: phase as any,
            event: 'start',
        } as LedgerEntry);
        ledger.push({
            t: new Date().toISOString(),
            kind: 'phase',
            phase: phase as any,
            event: 'end',
            durationMs: 5000,
        } as LedgerEntry);
    }
    // Add the crashed phase start (no end)
    ledger.push({
        t: new Date().toISOString(),
        kind: 'phase',
        phase: crashPhase as any,
        event: 'start',
    } as LedgerEntry);

    // Token usage
    const tokenRecords = withTokenUsage
        ? [{ agentId: 'architect', model: 'gpt-4', inputTokens: 5000, outputTokens: 500, totalTokens: 5500 }]
        : [];
    if (withTokenUsage) {
        writeJson(outputDir, 'token-usage.json', tokenRecords);
    }

    return { state, manifest, ledger, tokenRecords };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
    tmpDir = createTmpDir();
    jest.clearAllMocks();
});

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// End-to-End Integration: Collect → Reconstruct → Verify
// ═════════════════════════════════════════════════════════════════════════════

describe('Continue Run Integration', () => {
    it('full flow: crashed at development, resume from development', () => {
        const outputDir = path.join(tmpDir, 'test-app-crashed');
        const { ledger } = createMockStoppedRun(outputDir, {
            crashPhase: 'development',
            completedPhases: ['intake', 'architect', 'product-manager', 'dba', 'team-leader'],
        });

        (readLedger as jest.Mock).mockReturnValue(ledger);

        // Step 1: Collect
        const collected = collectRunState(outputDir);

        expect(collected.stateSnapshot).not.toBeNull();
        expect(collected.manifest).not.toBeNull();
        expect(collected.workspaceExists).toBe(true);

        // Step 2: Reconstruct
        const result = reconstructState(collected);

        expect(result.confidence).toBe('full');
        expect(result.resumePhase).toBe('development');
        expect(result.state.input.systemName).toBe('test-app');
        expect(result.state.gitContext.token).toBe('integration-test-token');
        expect(result.state.architecture).not.toBeNull();
        expect(result.state.assignments).toHaveLength(1);
    });

    it('full flow: crashed at qa, resume from qa', () => {
        const outputDir = path.join(tmpDir, 'test-app-qa-crash');
        const { ledger } = createMockStoppedRun(outputDir, {
            crashPhase: 'qa',
            completedPhases: ['intake', 'architect', 'product-manager', 'dba', 'team-leader', 'development'],
            withFileChanges: true,
            withPullRequests: true,
        });

        (readLedger as jest.Mock).mockReturnValue(ledger);

        const collected = collectRunState(outputDir);
        const result = reconstructState(collected);

        expect(result.confidence).toBe('full');
        expect(result.resumePhase).toBe('qa');
        expect(result.state.fileChanges).toHaveLength(1);
        expect(result.state.pullRequests).toHaveLength(1);
    });

    it('full flow: crashed at architect, resume from architect', () => {
        const outputDir = path.join(tmpDir, 'test-app-arch-crash');
        const { ledger } = createMockStoppedRun(outputDir, {
            crashPhase: 'architect',
            completedPhases: ['intake'],
            withArchitecture: false,
            withEpics: false,
            withStories: false,
            withTasks: false,
            withAssignments: false,
        });

        (readLedger as jest.Mock).mockReturnValue(ledger);

        const collected = collectRunState(outputDir);
        const result = reconstructState(collected);

        expect(result.confidence).toBe('full');
        expect(result.resumePhase).toBe('architect');
    });

    it('full flow: bugfix loop state is preserved', () => {
        const outputDir = path.join(tmpDir, 'test-app-bugfix');
        const { ledger } = createMockStoppedRun(outputDir, {
            crashPhase: 'bugfix-triage',
            completedPhases: ['intake', 'architect', 'product-manager', 'dba', 'team-leader', 'development', 'qa'],
            withFileChanges: true,
            withPullRequests: true,
            withTestReports: true,
            bugfixIteration: 2,
        });

        (readLedger as jest.Mock).mockReturnValue(ledger);

        const collected = collectRunState(outputDir);
        const result = reconstructState(collected);

        expect(result.state.iteration.bugfix).toBe(2);
        // Should resume from bugfix-triage since qa completed but triage didn't
        expect(result.resumePhase).toBe('bugfix-triage');
    });

    it('full flow: maintain mode includes codebase-analyzer', () => {
        const outputDir = path.join(tmpDir, 'test-app-maintain');
        const { ledger } = createMockStoppedRun(outputDir, {
            systemName: 'existing-app',
            runType: 'maintain',
            crashPhase: 'codebase-analyzer',
            completedPhases: ['intake'],
            withArchitecture: false,
            withEpics: false,
            withStories: false,
            withTasks: false,
            withAssignments: false,
        });

        (readLedger as jest.Mock).mockReturnValue(ledger);

        const collected = collectRunState(outputDir);
        const result = reconstructState(collected);

        expect(result.resumePhase).toBe('codebase-analyzer');
    });

    it('degraded mode: no state.json, only manifest', () => {
        const outputDir = path.join(tmpDir, 'degraded');
        fs.mkdirSync(outputDir, { recursive: true });

        const manifest = {
            generatedAt: new Date().toISOString(),
            status: 'crashed',
            systemName: 'degraded-app',
            runType: 'greenfield',
            finalPhase: 'development',
            tokenUsage: { totalCalls: 50, totalTokens: 25000, totalInputTokens: 20000 },
            counts: { epics: 1, stories: 1, tasks: 1, assignments: 1 },
        };
        writeJson(outputDir, 'run-manifest.json', manifest);

        const ledger = [
            { t: new Date().toISOString(), kind: 'phase' as const, phase: 'intake' as any, event: 'start' as const },
            { t: new Date().toISOString(), kind: 'phase' as const, phase: 'intake' as any, event: 'end' as const, durationMs: 1000 },
            { t: new Date().toISOString(), kind: 'phase' as const, phase: 'architect' as any, event: 'start' as const },
            { t: new Date().toISOString(), kind: 'phase' as const, phase: 'architect' as any, event: 'end' as const, durationMs: 2000 },
        ] as LedgerEntry[];

        (readLedger as jest.Mock).mockReturnValue(ledger);

        const collected = collectRunState(outputDir);
        const result = reconstructState(collected);

        expect(result.confidence).toBe('partial');
        expect(result.state.input.systemName).toBe('degraded-app');
        // Should resume from product-manager (architect completed per ledger)
        expect(result.resumePhase).toBe('product-manager');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Singleton Rehydration
// ═════════════════════════════════════════════════════════════════════════════

describe('Singleton Rehydration', () => {
    it('rehydrates all singletons', () => {
        const outputDir = path.join(tmpDir, 'rehydrate-test');
        const { ledger, tokenRecords } = createMockStoppedRun(outputDir, {
            withTokenUsage: true,
        });

        (readLedger as jest.Mock).mockReturnValue(ledger);

        const collected = collectRunState(outputDir);
        const { state } = reconstructState(collected);

        rehydrateSingletons(collected, state);

        // Verify singletons were called
        expect(setRunLogPath).toHaveBeenCalledWith(
            expect.stringContaining('run.log'),
        );
        expect(initLedger).toHaveBeenCalledWith(outputDir);
        expect(initResponseLog).toHaveBeenCalledWith(outputDir);
        expect(tokenTracker.enablePersistence).toHaveBeenCalled();
        expect(tokenTracker.recordFromPreviousRun).toHaveBeenCalledTimes(1);
        expect(refreshTokenReport).toHaveBeenCalled();
        expect(startRunBudget).toHaveBeenCalled();
    });

    it('handles missing token usage records gracefully', () => {
        const outputDir = path.join(tmpDir, 'no-tokens');
        createMockStoppedRun(outputDir, {
            withTokenUsage: false,
        });

        (readLedger as jest.Mock).mockReturnValue([]);

        const collected = collectRunState(outputDir);
        const { state } = reconstructState(collected);

        rehydrateSingletons(collected, state);

        // Should not call recordFromPreviousRun when no records exist
        expect(tokenTracker.recordFromPreviousRun).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Git Reconciliation (unit-level, mocked git)
// ═════════════════════════════════════════════════════════════════════════════

describe('Git Reconciliation', () => {
    it('returns immediate success when CONTINUE_GIT_RECONCILE is false', () => {
        // Temporarily disable reconciliation
        const config = require('../src/config');
        const original = config.CONTINUE_GIT_RECONCILE;
        (config as any).CONTINUE_GIT_RECONCILE = false;

        try {
            const { reconcileGitState } = require('../src/conductor/continue/git-reconciliation');

            const collected: CollectedRunState = {
                stateSnapshot: { systemBranch: 'project/test' },
                manifest: null,
                ledgerEntries: [],
                responseIndex: [],
                agentArtifacts: [],
                gitBranches: { local: [], remote: [] },
                gitLog: [],
                workspaceFiles: [],
                prBranchStatus: [],
                outputPath: tmpDir,
                workspacePath: tmpDir,
                workspaceExists: true,
                workspaceIsGitRepo: true,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconcileGitState(collected, { systemBranch: 'project/test' });
            expect(result.ok).toBe(true);
            expect(result.checks[0].check).toBe('skip');
        } finally {
            (config as any).CONTINUE_GIT_RECONCILE = original;
        }
    });

    it('fails fatally when workspace is not a git repo', () => {
        const { reconcileGitState } = require('../src/conductor/continue/git-reconciliation');

        const collected: CollectedRunState = {
            stateSnapshot: null,
            manifest: null,
            ledgerEntries: [],
            responseIndex: [],
            agentArtifacts: [],
            gitBranches: { local: [], remote: [] },
            gitLog: [],
            workspaceFiles: [],
            prBranchStatus: [],
            outputPath: tmpDir,
            workspacePath: tmpDir,
            workspaceExists: true,
            workspaceIsGitRepo: false, // not a git repo
            salvagePatches: [],
            tokenUsageRecords: [],
        };

        const result = reconcileGitState(collected, {});
        expect(result.ok).toBe(false);
        expect(result.checks.some((c: any) => c.check === 'workspace-is-git-repo' && !c.ok)).toBe(true);
    });

    it('detects missing workspace as fatal', () => {
        const { reconcileGitState } = require('../src/conductor/continue/git-reconciliation');

        const collected: CollectedRunState = {
            stateSnapshot: null,
            manifest: null,
            ledgerEntries: [],
            responseIndex: [],
            agentArtifacts: [],
            gitBranches: { local: [], remote: [] },
            gitLog: [],
            workspaceFiles: [],
            prBranchStatus: [],
            outputPath: tmpDir,
            workspacePath: '/does/not/exist',
            workspaceExists: false,
            workspaceIsGitRepo: false,
            salvagePatches: [],
            tokenUsageRecords: [],
        };

        const result = reconcileGitState(collected, {});
        expect(result.ok).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Workspace Path Resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('Workspace path resolution', () => {
    it('resolves from state.json workspacePath', () => {
        const workspaceDir = path.join(tmpDir, 'my-project');
        fs.mkdirSync(workspaceDir, { recursive: true });

        const outputDir = path.join(tmpDir, 'output');
        fs.mkdirSync(outputDir, { recursive: true });
        writeJson(outputDir, 'state.json', { workspacePath: workspaceDir });

        (readLedger as jest.Mock).mockReturnValue([]);
        (readResponseLogIndex as jest.Mock).mockReturnValue([]);

        const collected = collectRunState(outputDir);

        expect(collected.workspacePath).toBe(workspaceDir);
        expect(collected.workspaceExists).toBe(true);
    });

    it('resolves from input.existingProjectPath for maintain mode', () => {
        const existingDir = path.join(tmpDir, 'existing-project');
        fs.mkdirSync(existingDir, { recursive: true });

        const outputDir = path.join(tmpDir, 'output');
        fs.mkdirSync(outputDir, { recursive: true });
        writeJson(outputDir, 'state.json', {
            workspacePath: '', // no direct workspace path
            input: { existingProjectPath: existingDir, systemName: 'test' },
        });

        (readLedger as jest.Mock).mockReturnValue([]);
        (readResponseLogIndex as jest.Mock).mockReturnValue([]);

        const collected = collectRunState(outputDir);

        expect(collected.workspacePath).toBe(existingDir);
        expect(collected.workspaceExists).toBe(true);
    });

    it('warns when workspace does not exist', () => {
        const outputDir = path.join(tmpDir, 'output');
        fs.mkdirSync(outputDir, { recursive: true });
        writeJson(outputDir, 'state.json', {
            workspacePath: '/path/that/does/not/exist',
        });

        (readLedger as jest.Mock).mockReturnValue([]);
        (readResponseLogIndex as jest.Mock).mockReturnValue([]);

        const collected = collectRunState(outputDir);

        expect(collected.workspaceExists).toBe(false);
    });
});
