/**
 * Architect node — end-to-end regression for the "empty mission report" failure.
 *
 * Symptom (runs of 2026-08-16, `claude-sonnet-5` and `gpt-5.3-codex`):
 *   [Architect] INFO Architecture: 0 components / Tech decisions: 0 / Epics: 0
 *   architect-mission.md -> "## Architecture Style\n\nundefined"
 * with no error, no schema-validation warning, and 5 020 output tokens billed.
 *
 * Cause: both providers return `AIMessage.content` as an ARRAY of content
 * blocks (Anthropic streaming; OpenAI Responses API for `*codex*` models).
 * `invokeAgent` treated any non-string content as opaque structured data and
 * returned it verbatim, bypassing JSON parsing AND schema validation, so
 * `output.architecture` was `undefined` while every `?? []` default silently
 * absorbed the damage.
 *
 * These tests drive the real `architectNode` with each provider's response
 * shape and assert the state it produces.
 */
import { architectNode } from '../src/conductor/nodes';
import type { ProjectStateType } from '../src/conductor/state';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/utils/oauth-auth.util', () => ({
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
}));

const mockInvoke = jest.fn();
jest.mock('../src/agents/architect/architect.agent', () => ({
    createArchitectAgent: jest.fn(() => ({ invoke: mockInvoke, setInvocationId: jest.fn() })),
}));

jest.mock('../src/agents/_shared/artifact', () => ({
    writeArtifact: jest.fn((opts: any) => ({ agentId: opts.agentId, path: '/mock/report.md', content: opts.content })),
}));

jest.mock('../src/utils/repo-contract-writer', () => ({
    writeRepoContract: jest.fn(),
    readRepoContract: jest.fn().mockReturnValue(null),
}));

jest.mock('../src/utils/retry', () => ({
    retryWithBackoff: jest.fn(async (fn: () => Promise<any>) => fn()),
}));

jest.mock('../src/utils/token-usage-extractor', () => ({
    extractTokenUsageFromMessages: jest.fn().mockReturnValue(null),
}));

jest.mock('../src/utils/token-tracker', () => ({
    tokenTracker: {
        startInvocation: jest.fn().mockReturnValue('inv-0'),
        endInvocation: jest.fn(),
        recordContextChars: jest.fn(),
        getRunSummary: jest.fn().mockReturnValue({ totalTokens: 0, totalCalls: 0, inputTokens: 0, outputTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0, byAgent: [] }),
    },
}));

jest.mock('../src/utils/token-report', () => ({
    refreshTokenReport: jest.fn(),
    generateTokenReport: jest.fn().mockReturnValue({ jsonPath: '/mock.json', htmlPath: '/mock.html' }),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A minimal but schema-VALID ArchitectOutput payload. */
const architectPayload = {
    architecture: {
        style: 'layered',
        components: [{
            name: 'GameEngine', type: 'service', description: 'Core loop',
            technology: 'TypeScript', communicatesWith: ['Renderer'],
        }],
        dataFlow: 'input -> engine -> renderer',
        integrations: [],
        nonFunctional: ['60 fps'],
        mermaidDiagram: 'graph TD; A-->B;',
    },
    techStack: [{ layer: 'frontend', choice: 'TypeScript + Canvas', alternatives: ['Phaser'], rationale: 'no runtime deps' }],
    epics: [{ id: 'EPIC-001', title: 'Core gameplay', description: 'Movement and collisions', components: ['GameEngine'] }],
    repoContract: {
        layout: 'single-root',
        roots: [{
            dir: '.', kind: 'frontend', stack: 'node',
            entryPoints: ['src/main.ts'], sourceDirs: ['src'], testDirs: ['tests'],
            scripts: { build: 'vite build', test: 'jest' },
            buildOutputDir: 'dist',
        }],
        modules: [{
            id: 'MOD-ENGINE', path: 'src/engine.ts', componentName: 'GameEngine',
            exports: [{ name: 'tick', kind: 'function', signature: 'tick(dt: number): void' }],
            dependsOn: [],
        }],
        namingConvention: 'camelCase files',
        sharedTypes: [],
        frozenPaths: [],
    },
};

function makeState(): ProjectStateType {
    return {
        input: {
            systemName: 'pacman',
            requirementsText: 'Build a Pacman game',
            mode: 'autonomous' as const,
            runType: 'greenfield' as const,
        },
        workspacePath: '/tmp/adt-architect-test-workspace',
        outputPath: '/tmp/adt-architect-test-output',
        systemBranch: 'project/pacman',
        gitContext: { token: 't', owner: 'o', repo: 'r', defaultBranch: 'main' },
        codebaseAnalysis: null,
        architecture: null,
        epics: [], techStack: [], dbDesign: null, userStories: [], tasks: [],
        assignments: [], completedAssignmentIds: [], fileChanges: [],
        testPlan: null, testReports: [], bugs: [], fixedBugIds: [],
        devopsPlan: null, runningContainers: [], pullRequests: [],
        phase: 'intake' as any, iteration: { bugfix: 0 }, approvals: [],
        pendingRerun: null, phaseFeedback: {}, cancelled: false,
        artifacts: [], transcript: [], tokenUsage: [],
        acceptance: null, latestGateReport: null,
        unrecoverable: null, verificationErrors: [], dispatchRounds: [],
        attemptedBugIds: [], bugAttempts: {}, planViolations: [],
        repoContract: null, completionEvidence: [], salvageBranches: [],
        phantomFileChanges: [], qaClaimDiscrepancies: [],
        e2eStatus: 'not-run' as const, e2eSkipReason: null, e2eEvidence: null,
        invariantViolations: [],
    } as unknown as ProjectStateType;
}

beforeEach(() => mockInvoke.mockReset());

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('architectNode with provider content-block responses', () => {
    it('parses the OpenAI Responses API shape (gpt-5.3-codex)', async () => {
        mockInvoke.mockResolvedValue({
            messages: [{
                _getType: () => 'ai',
                content: [{ type: 'text', text: JSON.stringify(architectPayload), annotations: [] }],
                response_metadata: { finish_reason: 'stop' },
            }],
        });

        const update = await architectNode(makeState());

        expect(update.architecture?.style).toBe('layered');
        expect(update.architecture?.components).toHaveLength(1);
        expect(update.techStack).toHaveLength(1);
        expect(update.epics).toHaveLength(1);
        expect(update.repoContract?.modules).toHaveLength(1);
    });

    it('parses the Anthropic streaming shape, ignoring thinking blocks (claude-sonnet-5)', async () => {
        mockInvoke.mockResolvedValue({
            messages: [{
                _getType: () => 'ai',
                content: [
                    { type: 'thinking', thinking: 'Considering a layered design…' },
                    { type: 'text', text: JSON.stringify(architectPayload).slice(0, 40) },
                    { type: 'text', text: JSON.stringify(architectPayload).slice(40) },
                ],
            }],
        });

        const update = await architectNode(makeState());

        expect(update.architecture?.style).toBe('layered');
        expect(update.epics).toHaveLength(1);
    });

    it('still parses a plain string response (Chat Completions)', async () => {
        mockInvoke.mockResolvedValue({
            messages: [{ _getType: () => 'ai', content: JSON.stringify(architectPayload) }],
        });

        const update = await architectNode(makeState());
        expect(update.architecture?.components).toHaveLength(1);
    });

    it('fails loudly instead of writing an empty report when the model returns no text', async () => {
        // Reasoning-only response: the pre-fix code returned the raw block array,
        // producing "## Architecture Style\n\nundefined" with zero warnings.
        mockInvoke.mockResolvedValue({
            messages: [{ _getType: () => 'ai', content: [{ type: 'reasoning', reasoning: 'thinking…' }] }],
        });

        await expect(architectNode(makeState())).rejects.toThrow(/architect/i);
        // One initial call + AGENT_OUTPUT_REPAIR_ATTEMPTS re-asks — never a silent pass.
        expect(mockInvoke.mock.calls.length).toBeGreaterThan(1);
    });

    it('recovers via the repair loop when the first response is unusable', async () => {
        mockInvoke
            .mockResolvedValueOnce({ messages: [{ _getType: () => 'ai', content: [{ type: 'reasoning', reasoning: 'thinking…' }] }] })
            .mockResolvedValue({ messages: [{ _getType: () => 'ai', content: [{ type: 'text', text: JSON.stringify(architectPayload) }] }] });

        const update = await architectNode(makeState());
        expect(update.architecture?.style).toBe('layered');
    });
});
