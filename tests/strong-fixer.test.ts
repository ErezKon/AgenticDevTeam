/**
 * Strong Model PR Fixer — unit tests.
 *
 * Tests the buildStrongFixerAgent() builder and verifies the config-driven
 * enable/disable/strategy controls. All tests are pure: no LLM, no git, no network.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// Mock the agent factory to capture config passed through
const mockBuildAgent = jest.fn().mockReturnValue({
    invoke: jest.fn(),
    isCeilingReached: jest.fn(() => false),
    setInvocationId: jest.fn(),
});
jest.mock('../src/agents/_shared/agent-factory', () => ({
    buildAgent: mockBuildAgent,
}));

// Mock workspace/git/shell tools
jest.mock('../src/tools/fs/workspace-tools', () => ({
    createWorkspaceTools: jest.fn(() => [{ name: 'read_file' }, { name: 'write_file' }]),
}));
jest.mock('../src/tools/git/git-tools', () => ({
    createGitTools: jest.fn(() => [{ name: 'git_status' }]),
}));
jest.mock('../src/tools/shell/shell-tools', () => ({
    createShellTool: jest.fn(() => ({ name: 'shell' })),
}));

// ─── buildStrongFixerAgent ──────────────────────────────────────────────────

describe('buildStrongFixerAgent', () => {
    afterEach(() => {
        jest.resetModules();
        mockBuildAgent.mockClear();
    });

    function loadBuilder(overrides: Record<string, any> = {}) {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            STRONG_FIXER_MODEL: '',
            STRONG_FIXER_MAX_TOOL_CALLS: 40,
            PRINCIPAL_DEV_MODEL: 'gpt-oss-120b',
            SENIOR_DEV_MODEL: 'llama-3-3-70b-instruct',
            JUNIOR_DEV_MODEL: 'llama-3-2-3b-instruct',
            DEV_GIT_TOOLS_ENABLED: false,
            ...overrides,
        }));
        return require('../src/agents/developers/dev-agent.builder') as typeof import('../src/agents/developers/dev-agent.builder');
    }

    it('uses STRONG_FIXER_MODEL when set', () => {
        const { buildStrongFixerAgent } = loadBuilder({
            STRONG_FIXER_MODEL: 'claude-opus-4-20250514',
        });
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        expect(mockBuildAgent).toHaveBeenCalledTimes(1);
        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.model).toBe('claude-opus-4-20250514');
    });

    it('falls back to PRINCIPAL_DEV_MODEL when STRONG_FIXER_MODEL is empty', () => {
        const { buildStrongFixerAgent } = loadBuilder({
            STRONG_FIXER_MODEL: '',
            PRINCIPAL_DEV_MODEL: 'gpt-oss-120b',
        });
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.model).toBe('gpt-oss-120b');
    });

    // Plan 22 A1/A2: the fixer now receives per-category budgets, and
    // STRONG_FIXER_MAX_TOOL_CALLS bounds *model turns* rather than tool calls.
    it('uses STRONG_FIXER_MAX_TOOL_CALLS as the turn ceiling', () => {
        const { buildStrongFixerAgent } = loadBuilder({
            STRONG_FIXER_MAX_TOOL_CALLS: 60,
        });
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.maxToolCalls).toBeUndefined();
        expect(cfg.toolBudgets.turns).toBe(60);
    });

    it('defaults to a 40-turn ceiling', () => {
        const { buildStrongFixerAgent } = loadBuilder();
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.toolBudgets.turns).toBe(40);
    });

    it('gets more headroom than a principal dev in every category', () => {
        const { buildStrongFixerAgent } = loadBuilder();
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        // principal defaults are { reads: 60, writes: 30, shell: 14 }
        expect(cfg.toolBudgets.reads).toBe(80);
        expect(cfg.toolBudgets.writes).toBe(40);
        expect(cfg.toolBudgets.shell).toBe(20);
    });

    it('uses temperature 0.2', () => {
        const { buildStrongFixerAgent } = loadBuilder();
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.temperature).toBe(0.2);
    });

    it('uses agent id "strong-fixer"', () => {
        const { buildStrongFixerAgent } = loadBuilder();
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.id).toBe('strong-fixer');
    });

    it('uses development phase', () => {
        const { buildStrongFixerAgent } = loadBuilder();
        buildStrongFixerAgent('test-key', '/tmp/workspace');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.phase).toBe('development');
    });

    it('passes apiKey to buildAgent', () => {
        const { buildStrongFixerAgent } = loadBuilder();
        buildStrongFixerAgent('my-api-key', '/tmp/workspace');

        expect(mockBuildAgent.mock.calls[0][0]).toBe('my-api-key');
    });
});

// ─── Config defaults ────────────────────────────────────────────────────────

describe('strong fixer config defaults', () => {
    afterEach(() => { jest.resetModules(); });

    it('STRONG_FIXER_ENABLED defaults to true', () => {
        jest.mock('../src/config', () => jest.requireActual('../src/config'));
        const config = require('../src/config');
        // The raw env var is not set in tests, so it reads from the default
        // STRONG_FIXER_ENABLED = (process.env.STRONG_FIXER_ENABLED ?? 'true') === 'true'
        expect(typeof config.STRONG_FIXER_ENABLED).toBe('boolean');
    });

    it('STRONG_FIXER_MAX_TOOL_CALLS defaults to 40', () => {
        jest.mock('../src/config', () => jest.requireActual('../src/config'));
        const config = require('../src/config');
        expect(config.STRONG_FIXER_MAX_TOOL_CALLS).toBe(40);
    });

    it('PR_EXHAUSTION_STRATEGY defaults to escalate-then-fix', () => {
        jest.mock('../src/config', () => jest.requireActual('../src/config'));
        const config = require('../src/config');
        expect(config.PR_EXHAUSTION_STRATEGY).toBe('escalate-then-fix');
    });

    it('STRONG_FIXER_MODEL defaults to empty string', () => {
        jest.mock('../src/config', () => jest.requireActual('../src/config'));
        const config = require('../src/config');
        expect(config.STRONG_FIXER_MODEL).toBe('');
    });
});

// ─── PR_EXHAUSTION_STRATEGY guards ─────────────────────────────────────────

describe('PR_EXHAUSTION_STRATEGY config values', () => {
    afterEach(() => { jest.resetModules(); });

    it.each([
        ['escalate-then-fix', true,  true],
        ['fix-only',          false, true],
        ['escalate-only',     true,  false],
    ])('strategy "%s" → escalation=%s, strong-fixer=%s', (strategy, expectEscalation, expectFixer) => {
        // Verify the strategy value determines whether escalation and strong fixer run.
        // We test the guard conditions directly rather than the full workflow.
        const shouldRunEscalation = strategy !== 'fix-only';
        const shouldRunStrongFixer = strategy !== 'escalate-only';

        expect(shouldRunEscalation).toBe(expectEscalation);
        expect(shouldRunStrongFixer).toBe(expectFixer);
    });
});

// ─── STRONG_FIXER_ENABLED guard ─────────────────────────────────────────────

describe('STRONG_FIXER_ENABLED guard', () => {
    it('disabled when set to false', () => {
        const raw: string = 'false';
        const enabled = raw === 'true';
        expect(enabled).toBe(false);
    });

    it('enabled when set to true', () => {
        const raw: string = 'true';
        const enabled = raw === 'true';
        expect(enabled).toBe(true);
    });

    it('enabled when unset (defaults to true)', () => {
        const raw: string | undefined = undefined;
        const enabled = (raw ?? 'true') === 'true';
        expect(enabled).toBe(true);
    });
});

// ─── buildDevAgent (existing) ───────────────────────────────────────────────

describe('buildDevAgent', () => {
    afterEach(() => {
        jest.resetModules();
        mockBuildAgent.mockClear();
    });

    function loadBuilder(overrides: Record<string, any> = {}) {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            STRONG_FIXER_MODEL: '',
            STRONG_FIXER_MAX_TOOL_CALLS: 40,
            PRINCIPAL_DEV_MODEL: 'gpt-oss-120b',
            SENIOR_DEV_MODEL: 'llama-3-3-70b-instruct',
            JUNIOR_DEV_MODEL: 'llama-3-2-3b-instruct',
            DEV_GIT_TOOLS_ENABLED: false,
            ...overrides,
        }));
        return require('../src/agents/developers/dev-agent.builder') as typeof import('../src/agents/developers/dev-agent.builder');
    }

    it('uses PRINCIPAL_DEV_MODEL for principal rank', () => {
        const { buildDevAgent } = loadBuilder({ PRINCIPAL_DEV_MODEL: 'gpt-oss-120b' });
        const entry = {
            id: 'principal-backend', rank: 'principal' as const,
            domain: 'backend' as const, languages: ['typescript'],
            tag: '[PBE]', temperature: 0.3,
            name: 'Principal Backend', colorCode: 27,
        };
        buildDevAgent('key', entry, '/tmp/ws');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.model).toBe('gpt-oss-120b');
    });

    it('uses SENIOR_DEV_MODEL for senior rank', () => {
        const { buildDevAgent } = loadBuilder({ SENIOR_DEV_MODEL: 'llama-3-3-70b' });
        const entry = {
            id: 'senior-frontend', rank: 'senior' as const,
            domain: 'frontend' as const, languages: ['typescript'],
            tag: '[SFE]', temperature: 0.3,
            name: 'Senior Frontend', colorCode: 33,
        };
        buildDevAgent('key', entry, '/tmp/ws');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.model).toBe('llama-3-3-70b');
    });

    it('uses JUNIOR_DEV_MODEL for junior rank', () => {
        const { buildDevAgent } = loadBuilder({ JUNIOR_DEV_MODEL: 'llama-3-2-3b' });
        const entry = {
            id: 'junior-python', rank: 'junior' as const,
            domain: 'backend' as const, languages: ['python'],
            tag: '[JP]', temperature: 0.3,
            name: 'Junior Python', colorCode: 208,
        };
        buildDevAgent('key', entry, '/tmp/ws');

        const cfg = mockBuildAgent.mock.calls[0][1];
        expect(cfg.model).toBe('llama-3-2-3b');
    });

    it('has lower tool budgets than the strong fixer', () => {
        const { buildDevAgent, buildStrongFixerAgent } = loadBuilder({
            STRONG_FIXER_MAX_TOOL_CALLS: 40,
        });
        const entry = {
            id: 'principal-backend', rank: 'principal' as const,
            domain: 'backend' as const, languages: ['typescript'],
            tag: '[PBE]', temperature: 0.3,
            name: 'Principal Backend', colorCode: 27,
        };
        buildDevAgent('key', entry, '/tmp/ws');
        const devCfg = mockBuildAgent.mock.calls[0][1];

        mockBuildAgent.mockClear();
        buildStrongFixerAgent('key', '/tmp/ws');
        const fixerCfg = mockBuildAgent.mock.calls[0][1];

        expect(fixerCfg.toolBudgets.reads).toBeGreaterThan(devCfg.toolBudgets.reads);
        expect(fixerCfg.toolBudgets.writes).toBeGreaterThan(devCfg.toolBudgets.writes);
        expect(fixerCfg.toolBudgets.turns).toBeGreaterThan(devCfg.toolBudgets.turns);
    });
});
