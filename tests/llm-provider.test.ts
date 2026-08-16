/**
 * LLM provider detection & model factory — unit tests.
 *
 * All tests are pure: no LLM, no git, no network.
 * LangChain model constructors are mocked to verify correct class selection
 * and configuration passthrough.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const sharedLoggerInstance = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => sharedLoggerInstance),
    setRunLogPath: jest.fn(),
}));

/** Records every `withConfig` call across all ChatOpenAI instances. */
const withConfigCalls: any[] = [];
const MockChatOpenAI = jest.fn().mockImplementation(function (this: any, opts: any) {
    Object.assign(this, {
        _type: 'ChatOpenAI',
        ...opts,
        withConfig: jest.fn(function (this: any, cfg: any) {
            withConfigCalls.push(cfg);
            return Object.assign(Object.create(Object.getPrototypeOf(this)), this, { _configured: cfg });
        }),
    });
});
const MockChatAnthropic = jest.fn().mockImplementation(function (this: any, opts: any) {
    Object.assign(this, { _type: 'ChatAnthropic', ...opts });
});
const MockChatGoogleGenerativeAI = jest.fn().mockImplementation(function (this: any, opts: any) {
    Object.assign(this, { _type: 'ChatGoogleGenerativeAI', ...opts });
});

jest.mock('@langchain/openai', () => ({ ChatOpenAI: MockChatOpenAI }));
jest.mock('@langchain/anthropic', () => ({ ChatAnthropic: MockChatAnthropic }));
jest.mock('@langchain/google-genai', () => ({ ChatGoogleGenerativeAI: MockChatGoogleGenerativeAI }));

// ─── detectProvider (auto mode) ─────────────────────────────────────────────

describe('detectProvider (auto mode)', () => {
    afterEach(() => { jest.resetModules(); });

    function loadDetectProvider(providerDetection = 'auto') {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            LLM_PROVIDER_DETECTION: providerDetection,
            ANTHROPIC_API_KEY: 'test-anthropic-key',
            ANTHROPIC_BASE_URL: '',
            GOOGLE_API_KEY: 'test-google-key',
            GOOGLE_BASE_URL: '',
        }));
        return require('../src/agents/_shared/llm-provider') as typeof import('../src/agents/_shared/llm-provider');
    }

    it.each([
        ['claude-sonnet-4-20250514', 'anthropic'],
        ['claude-opus-4-20250514', 'anthropic'],
        ['claude-3-haiku-20240307', 'anthropic'],
        ['anthropic-custom-model', 'anthropic'],
        ['Claude-Sonnet-4', 'anthropic'],      // case-insensitive
        ['CLAUDE-OPUS-4', 'anthropic'],         // uppercase
    ])('model "%s" → provider "%s"', (model, expected) => {
        const { detectProvider } = loadDetectProvider();
        expect(detectProvider(model)).toBe(expected);
    });

    it.each([
        ['gemini-2.5-pro', 'google'],
        ['gemini-2.5-flash', 'google'],
        ['gemini-1.5-pro-latest', 'google'],
        ['Gemini-2.5-Pro', 'google'],           // case-insensitive
    ])('model "%s" → provider "%s"', (model, expected) => {
        const { detectProvider } = loadDetectProvider();
        expect(detectProvider(model)).toBe(expected);
    });

    it.each([
        ['gpt-oss-120b', 'openai'],
        ['gpt-4o', 'openai'],
        ['o1-preview', 'openai'],
        ['llama-3-3-70b-instruct', 'openai'],
        ['mistral-small-3-1-24b-instruct-2503', 'openai'],
        ['gemma-3-27b-it', 'openai'],
        ['some-custom-model', 'openai'],
        ['', 'openai'],                          // empty string
    ])('model "%s" → provider "%s" (OpenAI fallback)', (model, expected) => {
        const { detectProvider } = loadDetectProvider();
        expect(detectProvider(model)).toBe(expected);
    });
});

// ─── detectProvider (escape hatch: LLM_PROVIDER_DETECTION=openai) ───────────

describe('detectProvider (escape hatch)', () => {
    afterEach(() => { jest.resetModules(); });

    it('forces all models through openai when LLM_PROVIDER_DETECTION=openai', () => {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            LLM_PROVIDER_DETECTION: 'openai',
            ANTHROPIC_API_KEY: 'key',
            ANTHROPIC_BASE_URL: '',
            GOOGLE_API_KEY: 'key',
            GOOGLE_BASE_URL: '',
        }));
        const { detectProvider } = require('../src/agents/_shared/llm-provider');

        expect(detectProvider('claude-sonnet-4-20250514')).toBe('openai');
        expect(detectProvider('gemini-2.5-pro')).toBe('openai');
        expect(detectProvider('gpt-4o')).toBe('openai');
    });
});

// ─── createChatModel ────────────────────────────────────────────────────────

describe('createChatModel', () => {
    afterEach(() => {
        jest.resetModules();
        MockChatOpenAI.mockClear();
        MockChatAnthropic.mockClear();
        MockChatGoogleGenerativeAI.mockClear();
        withConfigCalls.length = 0;
    });

    function loadModule(overrides: Record<string, any> = {}) {
        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            LLM_PROVIDER_DETECTION: 'auto',
            ANTHROPIC_API_KEY: 'test-anthropic-key',
            ANTHROPIC_BASE_URL: '',
            GOOGLE_API_KEY: 'test-google-key',
            GOOGLE_BASE_URL: '',
            ...overrides,
        }));
        return require('../src/agents/_shared/llm-provider') as typeof import('../src/agents/_shared/llm-provider');
    }

    const baseOpts = {
        modelName: '',
        temperature: 0.3,
        maxTokens: 4096,
        timeout: 30000,
        callbacks: [],
    };

    it('creates ChatAnthropic for a Claude model', () => {
        const { createChatModel } = loadModule();
        const model = createChatModel({ ...baseOpts, modelName: 'claude-sonnet-4-20250514' });

        expect(MockChatAnthropic).toHaveBeenCalledTimes(1);
        expect(MockChatOpenAI).not.toHaveBeenCalled();
        expect(MockChatGoogleGenerativeAI).not.toHaveBeenCalled();

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.model).toBe('claude-sonnet-4-20250514');
        expect(args.temperature).toBe(0.3);
        expect(args.maxTokens).toBe(4096);
        expect(args.anthropicApiKey).toBe('test-anthropic-key');
        expect(args.maxRetries).toBe(0);
    });

    it('creates ChatGoogleGenerativeAI for a Gemini model', () => {
        const { createChatModel } = loadModule();
        const model = createChatModel({ ...baseOpts, modelName: 'gemini-2.5-pro' });

        expect(MockChatGoogleGenerativeAI).toHaveBeenCalledTimes(1);
        expect(MockChatOpenAI).not.toHaveBeenCalled();
        expect(MockChatAnthropic).not.toHaveBeenCalled();

        const args = MockChatGoogleGenerativeAI.mock.calls[0][0];
        expect(args.model).toBe('gemini-2.5-pro');
        expect(args.temperature).toBe(0.3);
        expect(args.maxOutputTokens).toBe(4096);
        expect(args.apiKey).toBe('test-google-key');
        expect(args.maxRetries).toBe(0);
    });

    it('creates ChatOpenAI for an OpenAI-compatible model', () => {
        const { createChatModel } = loadModule();
        const model = createChatModel({
            ...baseOpts,
            modelName: 'gpt-oss-120b',
            apiKey: 'oauth-token',
            baseURL: 'https://llm.example.com/v1',
        });

        expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
        expect(MockChatAnthropic).not.toHaveBeenCalled();
        expect(MockChatGoogleGenerativeAI).not.toHaveBeenCalled();

        const args = MockChatOpenAI.mock.calls[0][0];
        expect(args.model).toBe('gpt-oss-120b');
        expect(args.temperature).toBe(0.3);
        expect(args.maxTokens).toBe(4096);
        expect(args.apiKey).toBe('oauth-token');
        expect(args.maxRetries).toBe(0);
        expect(args.configuration.baseURL).toBe('https://llm.example.com/v1');
    });

    // Plan 21, E2: `modelKwargs.response_format` is spread verbatim into the
    // request body and is rejected by the OpenAI Responses API (`*codex*`,
    // `gpt-5.x-pro`). It must be passed as a call option via `withConfig`.
    it('enables JSON mode via withConfig, not modelKwargs, when jsonMode=true', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'gpt-4o', jsonMode: true });

        const args = MockChatOpenAI.mock.calls[0][0];
        expect(args.modelKwargs).toBeUndefined();
        expect(withConfigCalls).toEqual([{ response_format: { type: 'json_object' } }]);
    });

    it('uses withConfig for Responses-API models too (gpt-5.3-codex)', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'gpt-5.3-codex', jsonMode: true });

        const args = MockChatOpenAI.mock.calls[0][0];
        expect(args.modelKwargs).toBeUndefined();
        expect(withConfigCalls).toEqual([{ response_format: { type: 'json_object' } }]);
    });

    it('preserves callbacks through withConfig (token attribution survives)', () => {
        const { createChatModel } = loadModule();
        const cb = { name: 'token-cb' } as any;
        const model: any = createChatModel({ ...baseOpts, modelName: 'gpt-5.3-codex', jsonMode: true, callbacks: [cb] });

        expect(MockChatOpenAI.mock.calls[0][0].callbacks).toEqual([cb]);
        expect(model.callbacks).toEqual([cb]);
    });

    it('does not set JSON mode when jsonMode=false', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'gpt-4o', jsonMode: false });

        const args = MockChatOpenAI.mock.calls[0][0];
        expect(args.modelKwargs).toBeUndefined();
        expect(withConfigCalls).toHaveLength(0);
    });

    // Streaming is required — Anthropic's HTTP endpoint times out after ~10
    // minutes on non-streaming requests. The sanitizer (Plan 21 A2) handles residue.
    it('enables streaming on ChatAnthropic', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'claude-sonnet-4-20250514' });

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.streaming).toBe(true);
    });

    // Plan 21, A3: topP/topK were accepted by every agent builder but never forwarded.
    it('forwards topP/topK to non-adaptive ChatAnthropic models', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'claude-opus-4-20250514', topP: 0.85, topK: 40 });

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.topP).toBe(0.85);
        expect(args.topK).toBe(40);
    });

    // Adaptive-only models reject temperature/topK/topP via validateInvocationParamCompatibility.
    it.each([
        'claude-opus-4-7-20260101',
        'claude-opus-4-8-20260301',
        'claude-opus-5-20260601',
        'claude-fable-5-20260601',
        'claude-mythos-5-20260101',
        'claude-mythos-preview-20260101',
    ])('omits temperature/topK/topP for adaptive-only model "%s"', (modelName) => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName, temperature: 0.2, topP: 0.85, topK: 40 });

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.temperature).toBeUndefined();
        expect(args.topP).toBeUndefined();
        expect(args.topK).toBeUndefined();
        // Streaming and other params still present
        expect(args.streaming).toBe(true);
        expect(args.maxTokens).toBe(baseOpts.maxTokens);
        expect(args.model).toBe(modelName);
    });

    it('passes temperature/topP/topK for non-adaptive Claude models', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'claude-sonnet-4-20250514', topP: 0.9, topK: 30 });

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.temperature).toBe(0.3);
        expect(args.topP).toBe(0.9);
        expect(args.topK).toBe(30);
    });

    it('forwards topP to ChatOpenAI', () => {
        const { createChatModel } = loadModule();
        createChatModel({ ...baseOpts, modelName: 'gpt-4o', topP: 0.9 });

        expect(MockChatOpenAI.mock.calls[0][0].topP).toBe(0.9);
    });

    it('passes ANTHROPIC_BASE_URL via clientOptions when set', () => {
        const { createChatModel } = loadModule({
            ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        });
        createChatModel({ ...baseOpts, modelName: 'claude-opus-4-20250514' });

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.clientOptions).toEqual({ baseURL: 'https://proxy.example.com' });
    });

    it('does not set clientOptions when ANTHROPIC_BASE_URL is empty', () => {
        const { createChatModel } = loadModule({ ANTHROPIC_BASE_URL: '' });
        createChatModel({ ...baseOpts, modelName: 'claude-sonnet-4-20250514' });

        const args = MockChatAnthropic.mock.calls[0][0];
        expect(args.clientOptions).toBeUndefined();
    });

    it('passes GOOGLE_BASE_URL via baseUrl when set', () => {
        const { createChatModel } = loadModule({
            GOOGLE_BASE_URL: 'https://proxy.example.com',
        });
        createChatModel({ ...baseOpts, modelName: 'gemini-2.5-flash' });

        const args = MockChatGoogleGenerativeAI.mock.calls[0][0];
        expect(args.baseUrl).toBe('https://proxy.example.com');
    });

    it('does not set baseUrl when GOOGLE_BASE_URL is empty', () => {
        const { createChatModel } = loadModule({ GOOGLE_BASE_URL: '' });
        createChatModel({ ...baseOpts, modelName: 'gemini-2.5-pro' });

        const args = MockChatGoogleGenerativeAI.mock.calls[0][0];
        expect(args.baseUrl).toBeUndefined();
    });

    it('passes customFetch to OpenAI configuration', () => {
        const { createChatModel } = loadModule();
        const customFetch = jest.fn();
        createChatModel({ ...baseOpts, modelName: 'llama-3-3-70b', customFetch });

        const args = MockChatOpenAI.mock.calls[0][0];
        expect(args.configuration.fetch).toBe(customFetch);
    });

    it('forces OpenAI when LLM_PROVIDER_DETECTION=openai even for Claude model', () => {
        const { createChatModel } = loadModule({ LLM_PROVIDER_DETECTION: 'openai' });
        createChatModel({ ...baseOpts, modelName: 'claude-sonnet-4-20250514', apiKey: 'tok' });

        expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
        expect(MockChatAnthropic).not.toHaveBeenCalled();
    });
});

// ─── Missing API key warnings ───────────────────────────────────────────────

describe('missing API key warnings', () => {
    afterEach(() => {
        jest.resetModules();
        MockChatAnthropic.mockClear();
        MockChatGoogleGenerativeAI.mockClear();
    });

    it('warns when Anthropic API key is missing', () => {
        sharedLoggerInstance.warn.mockClear();

        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            LLM_PROVIDER_DETECTION: 'auto',
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_BASE_URL: '',
            GOOGLE_API_KEY: 'key',
            GOOGLE_BASE_URL: '',
        }));

        const { createChatModel } = require('../src/agents/_shared/llm-provider');
        createChatModel({ modelName: 'claude-sonnet-4-20250514', temperature: 0.3, callbacks: [] });

        expect(sharedLoggerInstance.warn).toHaveBeenCalledWith(
            expect.stringContaining('ANTHROPIC_API_KEY is not set'),
        );
    });

    it('warns when Google API key is missing', () => {
        sharedLoggerInstance.warn.mockClear();

        jest.mock('../src/config', () => ({
            ...jest.requireActual('../src/config'),
            LLM_PROVIDER_DETECTION: 'auto',
            ANTHROPIC_API_KEY: 'key',
            ANTHROPIC_BASE_URL: '',
            GOOGLE_API_KEY: '',
            GOOGLE_BASE_URL: '',
        }));

        const { createChatModel } = require('../src/agents/_shared/llm-provider');
        createChatModel({ modelName: 'gemini-2.5-pro', temperature: 0.3, callbacks: [] });

        expect(sharedLoggerInstance.warn).toHaveBeenCalledWith(
            expect.stringContaining('GOOGLE_API_KEY is not set'),
        );
    });
});
