/**
 * Unit tests for the Continue Run feature (Plan 23, Sub-Plan 09).
 *
 * Covers:
 *   - State Collector: collectRunState, findRunOutputs, listStoppedRuns
 *   - State Reconstructor: reconstructState (full, partial, minimal)
 *   - Phase Resolver: correct resume phase for each crash point
 *   - Secret rehydration
 *   - Field validation
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    OUTPUTS_DIR: '/tmp/adt-test-outputs',
    GITHUB_TOKEN: 'test-github-token',
    GITHUB_OWNER: 'test-owner',
    GITHUB_REPO: 'test-repo',
    GITHUB_PROJECT_TOKEN: '',
    GITHUB_PROJECT_OWNER: '',
    GIT_DEFAULT_BRANCH: 'main',
    RUN_LEDGER_ENABLED: false,
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

import {
    collectRunState,
    findRunOutputs,
    listStoppedRuns,
    type CollectedRunState,
} from '../src/conductor/continue/state-collector';

import {
    reconstructState,
} from '../src/conductor/continue/state-reconstructor';

import { readLedger } from '../src/utils/run-ledger';
import { readResponseLogIndex } from '../src/utils/response-log';
import type { LedgerEntry } from '../src/utils/run-ledger';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'adt-continue-test-'));
}

function writeJson(dir: string, filename: string, data: any): void {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
}

function makeStateSnapshot(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        input: {
            systemName: 'test-app',
            requirementsText: 'Build a test app',
            mode: 'autonomous',
            runType: 'greenfield',
        },
        workspacePath: '/tmp/workspace',
        outputPath: '/tmp/output',
        systemBranch: 'project/test-app',
        gitContext: {
            token: '***REDACTED***',
            owner: 'original-owner',
            repo: 'original-repo',
            defaultBranch: 'main',
        },
        phase: 'architect',
        iteration: { bugfix: 0 },
        codebaseAnalysis: null,
        architecture: { style: 'monolith', components: [], dataFlow: '', integrations: [], nonFunctional: [], mermaidDiagram: '' },
        epics: [{ id: 'EPIC-001', title: 'Epic 1', description: 'First epic', priority: 'must-have' }],
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
        e2eStatus: 'not-run',
        e2eSkipReason: null,
        e2eEvidence: null,
        invariantViolations: [],
        ...overrides,
    };
}

function makeManifest(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        generatedAt: '2026-08-16T10:00:00.000Z',
        status: 'crashed',
        systemName: 'test-app',
        runType: 'greenfield',
        finalPhase: 'development',
        tokenUsage: { totalCalls: 100, totalTokens: 50000, totalInputTokens: 40000 },
        counts: { epics: 2, stories: 5, tasks: 10, assignments: 8 },
        ...overrides,
    };
}

function makeLedgerEntries(completedPhases: string[]): LedgerEntry[] {
    const entries: LedgerEntry[] = [];
    for (const phase of completedPhases) {
        entries.push({
            t: new Date().toISOString(),
            kind: 'phase',
            phase: phase as any,
            event: 'start',
        } as LedgerEntry);
        entries.push({
            t: new Date().toISOString(),
            kind: 'phase',
            phase: phase as any,
            event: 'end',
            durationMs: 5000,
        } as LedgerEntry);
    }
    return entries;
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
// State Collector
// ═════════════════════════════════════════════════════════════════════════════

describe('State Collector', () => {
    describe('collectRunState', () => {
        it('collects all artifacts when all are present', () => {
            const stateSnapshot = makeStateSnapshot({ workspacePath: tmpDir });
            writeJson(tmpDir, 'state.json', stateSnapshot);
            writeJson(tmpDir, 'run-manifest.json', makeManifest());
            writeJson(tmpDir, 'token-usage.json', [{ agentId: 'architect', tokens: 1000 }]);

            const ledger = makeLedgerEntries(['intake', 'architect']);
            (readLedger as jest.Mock).mockReturnValue(ledger);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.stateSnapshot).not.toBeNull();
            expect(result.stateSnapshot!.input.systemName).toBe('test-app');
            expect(result.manifest).not.toBeNull();
            expect(result.manifest!.status).toBe('crashed');
            expect(result.ledgerEntries).toHaveLength(4);
            expect(result.outputPath).toBe(path.resolve(tmpDir));
            expect(result.tokenUsageRecords).toHaveLength(1);
        });

        it('collects with only state.json present', () => {
            const stateSnapshot = makeStateSnapshot({ workspacePath: tmpDir });
            writeJson(tmpDir, 'state.json', stateSnapshot);

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.stateSnapshot).not.toBeNull();
            expect(result.manifest).toBeNull();
            expect(result.ledgerEntries).toHaveLength(0);
            expect(result.tokenUsageRecords).toHaveLength(0);
        });

        it('collects with only manifest present (degraded mode)', () => {
            writeJson(tmpDir, 'run-manifest.json', makeManifest());

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.stateSnapshot).toBeNull();
            expect(result.manifest).not.toBeNull();
            expect(result.manifest!.systemName).toBe('test-app');
        });

        it('handles missing/corrupt files gracefully', () => {
            // Write corrupt state.json
            fs.writeFileSync(path.join(tmpDir, 'state.json'), '{not valid json!!!', 'utf-8');

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.stateSnapshot).toBeNull();
            expect(result.manifest).toBeNull();
        });

        it('handles empty output directory gracefully', () => {
            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.stateSnapshot).toBeNull();
            expect(result.manifest).toBeNull();
            expect(result.workspacePath).toBe('');
        });

        it('detects workspace existence correctly', () => {
            const workspaceDir = path.join(tmpDir, 'workspace');
            fs.mkdirSync(workspaceDir, { recursive: true });

            const stateSnapshot = makeStateSnapshot({ workspacePath: workspaceDir });
            writeJson(tmpDir, 'state.json', stateSnapshot);

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.workspacePath).toBe(workspaceDir);
            expect(result.workspaceExists).toBe(true);
            // Not a git repo since no .git directory
            expect(result.workspaceIsGitRepo).toBe(false);
        });

        it('detects workspace as git repo when .git exists', () => {
            const workspaceDir = path.join(tmpDir, 'workspace');
            fs.mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });

            const stateSnapshot = makeStateSnapshot({ workspacePath: workspaceDir });
            writeJson(tmpDir, 'state.json', stateSnapshot);

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.workspaceExists).toBe(true);
            expect(result.workspaceIsGitRepo).toBe(true);
        });

        it('collects salvage patches when present', () => {
            const salvageDir = path.join(tmpDir, 'salvage');
            fs.mkdirSync(salvageDir, { recursive: true });
            fs.writeFileSync(path.join(salvageDir, 'fix-123.patch'), 'diff content', 'utf-8');
            fs.writeFileSync(path.join(salvageDir, 'fix-456.diff'), 'diff content 2', 'utf-8');
            fs.writeFileSync(path.join(salvageDir, 'readme.txt'), 'not a patch', 'utf-8');

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.salvagePatches).toHaveLength(2);
        });

        it('infers PR branch status from state.json pull requests', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                pullRequests: [
                    { branchName: 'feature/a', status: 'merged' },
                    { branchName: 'feature/b', status: 'open' },
                    { branchName: 'feature/c', status: 'blocked' },
                ],
                salvageBranches: ['feature/c'],
            });
            writeJson(tmpDir, 'state.json', stateSnapshot);

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.prBranchStatus).toHaveLength(3);
            expect(result.prBranchStatus.find(b => b.branch === 'feature/a')?.status).toBe('merged');
            expect(result.prBranchStatus.find(b => b.branch === 'feature/b')?.status).toBe('open');
            expect(result.prBranchStatus.find(b => b.branch === 'feature/c')?.status).toBe('failed-salvaged');
        });

        it('collects agent artifacts from workspace docs/agents/', () => {
            const workspaceDir = path.join(tmpDir, 'workspace');
            const agentsDir = path.join(workspaceDir, 'docs', 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(path.join(agentsDir, 'architect.md'), '# Architect Report', 'utf-8');
            fs.writeFileSync(path.join(agentsDir, 'product-manager.md'), '# PM Report', 'utf-8');

            const stateSnapshot = makeStateSnapshot({ workspacePath: workspaceDir });
            writeJson(tmpDir, 'state.json', stateSnapshot);

            (readLedger as jest.Mock).mockReturnValue([]);
            (readResponseLogIndex as jest.Mock).mockReturnValue([]);

            const result = collectRunState(tmpDir);

            expect(result.agentArtifacts).toHaveLength(2);
            expect(result.agentArtifacts.map(a => a.agentId).sort()).toEqual(['architect', 'product-manager']);
        });
    });

    describe('findRunOutputs', () => {
        it('finds by absolute path', () => {
            expect(findRunOutputs(tmpDir)).toBe(tmpDir);
        });

        it('throws for non-existent path', () => {
            expect(() => findRunOutputs('/non/existent/path/that/does/not/exist'))
                .toThrow();
        });
    });

    describe('listStoppedRuns', () => {
        it('returns empty when outputs directory is empty or missing', () => {
            // OUTPUTS_DIR is mocked to /tmp/adt-test-outputs, which doesn't exist
            const runs = listStoppedRuns();
            expect(runs).toEqual([]);
        });

        it('lists stopped runs and excludes completed ones', () => {
            const outputsDir = path.join(tmpDir, 'outputs');
            fs.mkdirSync(outputsDir, { recursive: true });

            // Temporarily override OUTPUTS_DIR for this test
            const config = require('../src/config');
            const originalOutputsDir = config.OUTPUTS_DIR;
            (config as any).OUTPUTS_DIR = outputsDir;

            try {
                // Create a crashed run
                const crashedDir = path.join(outputsDir, 'test-app-2026-08-16');
                fs.mkdirSync(crashedDir, { recursive: true });
                writeJson(crashedDir, 'run-manifest.json', makeManifest({ status: 'crashed' }));

                // Create a completed run
                const completedDir = path.join(outputsDir, 'test-app-2026-08-15');
                fs.mkdirSync(completedDir, { recursive: true });
                writeJson(completedDir, 'run-manifest.json', makeManifest({ status: 'completed' }));

                // Create a failed run
                const failedDir = path.join(outputsDir, 'test-app-2026-08-14');
                fs.mkdirSync(failedDir, { recursive: true });
                writeJson(failedDir, 'run-manifest.json', makeManifest({ status: 'failed' }));

                const runs = listStoppedRuns();

                // Should list crashed and failed, not completed
                expect(runs).toHaveLength(2);
                expect(runs.map(r => r.status).sort()).toEqual(['crashed', 'failed']);
            } finally {
                (config as any).OUTPUTS_DIR = originalOutputsDir;
            }
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// State Reconstructor
// ═════════════════════════════════════════════════════════════════════════════

describe('State Reconstructor', () => {
    describe('Full reconstruction from state.json', () => {
        it('restores state with full confidence when state.json is complete', () => {
            const ledger = makeLedgerEntries(['intake', 'architect']);
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                architecture: { style: 'monolith', components: [], dataFlow: '', integrations: [], nonFunctional: [], mermaidDiagram: '' },
                epics: [{ id: 'EPIC-001', title: 'Epic 1', description: '', priority: 'must-have' }],
                phase: 'product-manager',
            });

            const collected: CollectedRunState = {
                stateSnapshot,
                manifest: makeManifest() as any,
                ledgerEntries: ledger,
                responseIndex: [],
                agentArtifacts: [],
                gitBranches: { local: [], remote: [] },
                gitLog: [],
                workspaceFiles: [],
                prBranchStatus: [],
                outputPath: tmpDir,
                workspacePath: tmpDir,
                workspaceExists: true,
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.confidence).toBe('full');
            expect(result.state.input.systemName).toBe('test-app');
            expect(result.state.architecture).not.toBeNull();
            expect(result.state.epics).toHaveLength(1);
            expect(result.resumePhase).toBe('product-manager');
        });

        it('preserves outputPath from the collected artifacts', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                outputPath: '/old/output/path',
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            // outputPath should be updated to the actual output directory
            expect(result.state.outputPath).toBe(tmpDir);
        });
    });

    describe('Secret rehydration', () => {
        it('restores REDACTED token from environment', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                gitContext: {
                    token: '***REDACTED***',
                    owner: 'original-owner',
                    repo: 'original-repo',
                    defaultBranch: 'main',
                },
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            // Token should be rehydrated from GITHUB_TOKEN (mocked as 'test-github-token')
            expect(result.state.gitContext.token).toBe('test-github-token');
            // Owner should be preserved from original state
            expect(result.state.gitContext.owner).toBe('original-owner');
            expect(result.state.gitContext.repo).toBe('original-repo');
        });

        it('warns about remaining REDACTED values', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                gitContext: {
                    token: '***REDACTED***',
                    owner: 'test',
                    repo: 'test',
                    defaultBranch: 'main',
                },
                // Add a nested redacted value
                input: {
                    systemName: 'test',
                    requirementsText: 'test',
                    mode: 'autonomous',
                    runType: 'greenfield',
                    repoTarget: { token: '***REDACTED***' },
                },
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            // The nested redacted value should generate a warning
            expect(result.warnings.some(w => w.includes('Redacted value'))).toBe(true);
        });

        it('creates gitContext from env when state has none', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                gitContext: null,
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.state.gitContext).not.toBeNull();
            expect(result.state.gitContext.token).toBe('test-github-token');
        });
    });

    describe('Fallback reconstruction from manifest', () => {
        it('returns partial confidence without state.json', () => {
            const collected: CollectedRunState = {
                stateSnapshot: null,
                manifest: makeManifest() as any,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.confidence).toBe('partial');
            expect(result.state.input.systemName).toBe('test-app');
            expect(result.warnings.some(w => w.includes('state.json not found'))).toBe(true);
        });
    });

    describe('Degraded reconstruction from ledger only', () => {
        it('returns minimal confidence with neither state.json nor manifest', () => {
            const collected: CollectedRunState = {
                stateSnapshot: null,
                manifest: null,
                ledgerEntries: makeLedgerEntries(['intake', 'architect']),
                responseIndex: [],
                agentArtifacts: [],
                gitBranches: { local: [], remote: [] },
                gitLog: [],
                workspaceFiles: [],
                prBranchStatus: [],
                outputPath: tmpDir,
                workspacePath: tmpDir,
                workspaceExists: true,
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.confidence).toBe('minimal');
            expect(result.warnings.some(w => w.includes('Neither state.json nor run-manifest.json'))).toBe(true);
        });
    });

    describe('Field validation', () => {
        it('resets corrupted array fields to empty arrays', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                epics: 'not-an-array', // corrupted
                tasks: 42, // corrupted
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(Array.isArray(result.state.epics)).toBe(true);
            expect(result.state.epics).toEqual([]);
            expect(Array.isArray(result.state.tasks)).toBe(true);
            expect(result.state.tasks).toEqual([]);
            expect(result.warnings.some(w => w.includes('"epics" is not an array'))).toBe(true);
        });

        it('resets corrupted object fields to defaults', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                iteration: 'not-an-object', // corrupted
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.state.iteration).toEqual({ bugfix: 0 });
            expect(result.warnings.some(w => w.includes('"iteration" is not an object'))).toBe(true);
        });

        it('resets invalid phase to intake', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                phase: 'invalid-phase-name',
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.state.phase).toBe('intake');
            expect(result.warnings.some(w => w.includes('Invalid phase'))).toBe(true);
        });

        it('resets invalid e2eStatus to not-run', () => {
            const stateSnapshot = makeStateSnapshot({
                workspacePath: tmpDir,
                e2eStatus: 'bogus-status',
            });

            const collected: CollectedRunState = {
                stateSnapshot,
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
                workspaceIsGitRepo: false,
                salvagePatches: [],
                tokenUsageRecords: [],
            };

            const result = reconstructState(collected);

            expect(result.state.e2eStatus).toBe('not-run');
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase Resolver
// ═════════════════════════════════════════════════════════════════════════════

describe('Phase Resolver', () => {
    function makeCollected(
        stateOverrides: Record<string, any>,
        completedPhases: string[] = [],
    ): CollectedRunState {
        return {
            stateSnapshot: makeStateSnapshot({
                workspacePath: tmpDir,
                ...stateOverrides,
            }),
            manifest: makeManifest() as any,
            ledgerEntries: makeLedgerEntries(completedPhases),
            responseIndex: [],
            agentArtifacts: [],
            gitBranches: { local: [], remote: [] },
            gitLog: [],
            workspaceFiles: [],
            prBranchStatus: [],
            outputPath: tmpDir,
            workspacePath: tmpDir,
            workspaceExists: true,
            workspaceIsGitRepo: false,
            salvagePatches: [],
            tokenUsageRecords: [],
        };
    }

    // Linear phase progression — each row: [resumePhase, stateOverrides, completedPhases]
    const PIPELINE_PHASES = ['intake', 'architect', 'product-manager', 'dba', 'team-leader', 'development', 'qa', 'bugfix-triage'];

    it.each([
        ['architect',        {},                                                                                                                                   ['intake']],
        ['product-manager',  { architecture: { style: 'monolith', components: [] }, epics: [{ id: 'E1', title: 'E1' }] },                                         ['intake', 'architect']],
        ['dba',              { architecture: { style: 'monolith', components: [] }, epics: [{ id: 'E1' }], userStories: [{ id: 'US-001' }], tasks: [{ id: 'T-001' }] },
                                                                                                                                                                   ['intake', 'architect', 'product-manager']],
        ['team-leader',      { architecture: { style: 'monolith', components: [] }, epics: [{ id: 'E1' }], userStories: [{ id: 'US-001' }], tasks: [{ id: 'T-001' }], dbDesign: { entities: [] } },
                                                                                                                                                                   ['intake', 'architect', 'product-manager', 'dba']],
        ['development',      { architecture: { style: 'monolith', components: [] }, epics: [{ id: 'E1' }], userStories: [{ id: 'US-001' }], tasks: [{ id: 'T-001' }], assignments: [{ id: 'A-001', devAgentId: 'junior-react' }] },
                                                                                                                                                                   ['intake', 'architect', 'product-manager', 'dba', 'team-leader']],
        ['qa',               { architecture: { style: 'monolith', components: [] }, epics: [{ id: 'E1' }], userStories: [{ id: 'US-001' }], tasks: [{ id: 'T-001' }], assignments: [{ id: 'A-001' }], fileChanges: [{ path: 'src/app.ts', action: 'create' }], pullRequests: [{ branchName: 'feature/a', status: 'merged' }] },
                                                                                                                                                                   ['intake', 'architect', 'product-manager', 'dba', 'team-leader', 'development']],
        ['devops',           { architecture: { style: 'monolith', components: [] }, epics: [{ id: 'E1' }], userStories: [{ id: 'US-001' }], tasks: [{ id: 'T-001' }], assignments: [{ id: 'A-001' }], fileChanges: [{ path: 'src/app.ts', action: 'create' }], pullRequests: [{ branchName: 'feature/a', status: 'merged' }], testReports: [{ type: 'unit', status: 'pass' }] },
                                                                                                                                                                   PIPELINE_PHASES],
    ] as [string, Record<string, any>, string[]][])(
        'resumes from %s after completing %j',
        (expectedPhase, stateOverrides, completedPhases) => {
            const collected = makeCollected(
                { phase: expectedPhase, ...stateOverrides },
                completedPhases,
            );
            const result = reconstructState(collected);
            expect(result.resumePhase).toBe(expectedPhase);
        },
    );

    it('handles partial development — counts pending assignments', () => {
        const collected = makeCollected(
            {
                phase: 'development',
                architecture: { style: 'monolith', components: [] },
                epics: [{ id: 'E1' }],
                userStories: [{ id: 'US-001' }],
                tasks: [{ id: 'T-001' }],
                assignments: [
                    { id: 'A-001', devAgentId: 'junior-react' },
                    { id: 'A-002', devAgentId: 'junior-python' },
                ],
                completedAssignmentIds: ['A-001'],
                pullRequests: [{ branchName: 'feature/a', status: 'merged' }],
            },
            ['intake', 'architect', 'product-manager', 'dba', 'team-leader'],
        );

        const result = reconstructState(collected);

        // Should resume from development because A-002 is still pending
        expect(result.resumePhase).toBe('development');
    });

    it('advances past development when all assignments completed', () => {
        const collected = makeCollected(
            {
                phase: 'development',
                architecture: { style: 'monolith', components: [] },
                epics: [{ id: 'E1' }],
                userStories: [{ id: 'US-001' }],
                tasks: [{ id: 'T-001' }],
                assignments: [
                    { id: 'A-001', devAgentId: 'junior-react' },
                    { id: 'A-002', devAgentId: 'junior-python' },
                ],
                completedAssignmentIds: ['A-001', 'A-002'],
                pullRequests: [
                    { branchName: 'feature/a', status: 'merged' },
                    { branchName: 'feature/b', status: 'merged' },
                ],
            },
            ['intake', 'architect', 'product-manager', 'dba', 'team-leader'],
        );

        const result = reconstructState(collected);

        // All assignments complete, so should advance past development to qa
        expect(result.resumePhase).toBe('qa');
    });

    it('preserves bugfix iteration counter', () => {
        const collected = makeCollected(
            {
                phase: 'bugfix-triage',
                iteration: { bugfix: 2 },
                architecture: { style: 'monolith', components: [] },
                epics: [{ id: 'E1' }],
                userStories: [{ id: 'US-001' }],
                tasks: [{ id: 'T-001' }],
                assignments: [{ id: 'A-001' }],
                fileChanges: [{ path: 'src/app.ts' }],
                pullRequests: [{ branchName: 'feature/a', status: 'merged' }],
                testReports: [{ type: 'unit', status: 'fail' }],
                bugs: [{ id: 'BUG-001', severity: 'critical' }],
            },
            ['intake', 'architect', 'product-manager', 'dba', 'team-leader', 'development', 'qa'],
        );

        const result = reconstructState(collected);

        // Bugfix iteration counter should be preserved
        expect(result.state.iteration.bugfix).toBe(2);
    });

    it('resumes from finalize when all phases complete', () => {
        const collected = makeCollected(
            {
                phase: 'finalize',
                architecture: { style: 'monolith', components: [] },
                epics: [{ id: 'E1' }],
                userStories: [{ id: 'US-001' }],
                tasks: [{ id: 'T-001' }],
                assignments: [{ id: 'A-001' }],
                fileChanges: [{ path: 'src/app.ts' }],
                pullRequests: [{ branchName: 'feature/a', status: 'merged' }],
                testReports: [{ type: 'unit', status: 'pass' }],
                devopsPlan: { dockerfiles: [] },
                e2eStatus: 'passed',
                acceptance: { status: 'completed' },
            },
            ['intake', 'architect', 'product-manager', 'dba', 'team-leader',
             'development', 'qa', 'bugfix-triage', 'devops', 'e2e', 'acceptance-gate'],
        );

        const result = reconstructState(collected);

        expect(result.resumePhase).toBe('finalize');
    });

    it('skips codebase-analyzer for greenfield runs', () => {
        const collected = makeCollected(
            {
                phase: 'architect',
                input: {
                    systemName: 'test-app',
                    requirementsText: 'Build something',
                    mode: 'autonomous',
                    runType: 'greenfield',
                },
            },
            ['intake'],
        );

        const result = reconstructState(collected);

        // Should skip codebase-analyzer and go to architect
        expect(result.resumePhase).toBe('architect');
    });

    it('includes codebase-analyzer for maintain runs', () => {
        const collected = makeCollected(
            {
                phase: 'codebase-analyzer',
                input: {
                    systemName: 'test-app',
                    requirementsText: 'Fix bugs',
                    mode: 'autonomous',
                    runType: 'maintain',
                },
            },
            ['intake'],
        );

        const result = reconstructState(collected);

        // For maintain mode, codebase-analyzer should be the resume point
        expect(result.resumePhase).toBe('codebase-analyzer');
    });

    it('resumes from intake when workspacePath is missing', () => {
        // Override the collected object directly to simulate truly missing paths
        const stateSnapshot = makeStateSnapshot({
            workspacePath: '',
            outputPath: '',
            phase: 'architect',
        });

        const collected: CollectedRunState = {
            stateSnapshot,
            manifest: makeManifest() as any,
            ledgerEntries: [],
            responseIndex: [],
            agentArtifacts: [],
            gitBranches: { local: [], remote: [] },
            gitLog: [],
            workspaceFiles: [],
            prBranchStatus: [],
            outputPath: tmpDir,
            workspacePath: '', // no workspace
            workspaceExists: false,
            workspaceIsGitRepo: false,
            salvagePatches: [],
            tokenUsageRecords: [],
        };

        const result = reconstructState(collected);

        expect(result.resumePhase).toBe('intake');
        expect(result.warnings.some(w => w.includes('workspacePath or outputPath missing'))).toBe(true);
    });

    it('handles ledger-only phase resolution (degraded mode)', () => {
        const collected: CollectedRunState = {
            stateSnapshot: null,
            manifest: null,
            ledgerEntries: makeLedgerEntries(['intake', 'architect', 'product-manager']),
            responseIndex: [],
            agentArtifacts: [],
            gitBranches: { local: [], remote: [] },
            gitLog: [],
            workspaceFiles: [],
            prBranchStatus: [],
            outputPath: tmpDir,
            workspacePath: tmpDir,
            workspaceExists: true,
            workspaceIsGitRepo: false,
            salvagePatches: [],
            tokenUsageRecords: [],
        };

        const result = reconstructState(collected);

        expect(result.confidence).toBe('minimal');
        // Should resume from dba (first phase not in ledger)
        expect(result.resumePhase).toBe('dba');
    });
});
