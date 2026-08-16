/**
 * Token usage callback — unit tests (Plan 21, sub-plan D).
 *
 * One case per provider/transport combination. Reading only
 * `llmOutput.{tokenUsage,token_usage,usage}` recorded 5 token records for a
 * 60+ call run, which silently disabled `MAX_RUN_COST_USD` for the whole run.
 *
 * Pure: no LLM, no git, no network.
 */
import type { LLMResult } from '@langchain/core/outputs';

const recordCall = jest.fn();
jest.mock('../src/utils/token-tracker', () => ({
    tokenTracker: { recordCall: (...args: any[]) => recordCall(...args) },
}));

const loggerInstance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => loggerInstance),
    setRunLogPath: jest.fn(),
}));

import { TokenUsageCallbackHandler } from '../src/utils/token-callback';
import { normaliseUsage, sumUsageMetadata } from '../src/utils/token-usage-extractor';

/** Build an LLMResult whose single generation carries `usage_metadata`. */
function resultWithUsageMetadata(usage: any, llmOutput?: any): LLMResult {
    return {
        generations: [[{ text: '', message: { usage_metadata: usage } } as any]],
        ...(llmOutput ? { llmOutput } : {}),
    } as LLMResult;
}

function handler(): TokenUsageCallbackHandler {
    return new TokenUsageCallbackHandler('junior-go', 'test-model', 'development');
}

beforeEach(() => {
    recordCall.mockClear();
    loggerInstance.warn.mockClear();
    TokenUsageCallbackHandler.resetUsageWarnings();
});

describe('handleLLMEnd — tier 1 (llmOutput)', () => {
    it('OpenAI Chat Completions: llmOutput.tokenUsage', () => {
        handler().handleLLMEnd({
            generations: [],
            llmOutput: { tokenUsage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 } },
        } as LLMResult);

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
            inputTokens: 1200, outputTokens: 300, totalTokens: 1500,
        }));
    });

    it('OpenAI Responses API: llmOutput.estimatedTokenUsage', () => {
        handler().handleLLMEnd({
            generations: [],
            llmOutput: { estimatedTokenUsage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } },
        } as LLMResult);

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
            inputTokens: 900, outputTokens: 100, totalTokens: 1000,
        }));
    });

    it('Anthropic non-streaming: llmOutput.usage, with cache tokens folded into input', () => {
        handler().handleLLMEnd({
            generations: [],
            llmOutput: {
                usage: {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_creation_input_tokens: 400,
                    cache_read_input_tokens: 1500,
                },
            },
        } as LLMResult);

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
            inputTokens: 2000, outputTokens: 50, totalTokens: 2050,
        }));
    });

    it('snake_case token_usage is still supported', () => {
        handler().handleLLMEnd({
            generations: [],
            llmOutput: { token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        } as LLMResult);

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 15 }));
    });
});

describe('handleLLMEnd — tier 2 (generations[].message.usage_metadata)', () => {
    it('Anthropic streaming: usage_metadata is already cache-inclusive', () => {
        handler().handleLLMEnd(resultWithUsageMetadata({
            input_tokens: 2000,
            output_tokens: 50,
            total_tokens: 2050,
            input_token_details: { cache_creation: 400, cache_read: 1500 },
        }));

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
            inputTokens: 2000, outputTokens: 50, totalTokens: 2050,
        }));
    });

    it('Google Gemini: usage_metadata only', () => {
        handler().handleLLMEnd(resultWithUsageMetadata({
            input_tokens: 700, output_tokens: 120, total_tokens: 820,
        }));

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
            inputTokens: 700, outputTokens: 120, totalTokens: 820,
        }));
    });

    it('sums usage_metadata across multiple generations', () => {
        handler().handleLLMEnd({
            generations: [[
                { text: '', message: { usage_metadata: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } } as any,
                { text: '', message: { usage_metadata: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } } as any,
            ]],
        } as LLMResult);

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
            inputTokens: 30, outputTokens: 3, totalTokens: 33,
        }));
    });
});

describe('handleLLMEnd — no double counting / no silence', () => {
    it('prefers llmOutput when usage is present in BOTH places', () => {
        handler().handleLLMEnd(resultWithUsageMetadata(
            { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
            { tokenUsage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 } },
        ));

        expect(recordCall).toHaveBeenCalledTimes(1);
        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 1500 }));
    });

    it('WARNs once per agent+model when no usage is reported anywhere', () => {
        const h = handler();
        h.handleLLMEnd({ generations: [] } as unknown as LLMResult);
        h.handleLLMEnd({ generations: [] } as unknown as LLMResult);
        h.handleLLMEnd({ generations: [], llmOutput: {} } as LLMResult);

        expect(recordCall).not.toHaveBeenCalled();
        expect(loggerInstance.warn).toHaveBeenCalledTimes(1);
        expect(loggerInstance.warn.mock.calls[0][0]).toContain('no token usage');
    });

    it('records zero-total usage as "no usage" rather than a phantom record', () => {
        handler().handleLLMEnd({
            generations: [],
            llmOutput: { tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
        } as LLMResult);

        expect(recordCall).not.toHaveBeenCalled();
    });

    it('tags the record with the invocation id when set', () => {
        const h = handler();
        h.setInvocationId('inv-42');
        h.handleLLMEnd({ generations: [], llmOutput: { tokenUsage: { totalTokens: 5, promptTokens: 4, completionTokens: 1 } } } as LLMResult);

        expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'inv-42' }));
    });
});

describe('shared normalisation helpers', () => {
    it('normaliseUsage returns null for empty / unusable input', () => {
        expect(normaliseUsage(undefined)).toBeNull();
        expect(normaliseUsage(null)).toBeNull();
        expect(normaliseUsage({})).toBeNull();
    });

    it('normaliseUsage derives total when the provider omits it', () => {
        // Plan 22 D2: cache counters are always reported (0 when the provider
        // does not use a prompt cache) so a total cache miss is visible.
        expect(normaliseUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
            inputTokens: 7, outputTokens: 3, totalTokens: 10,
            cacheReadTokens: 0, cacheCreationTokens: 0,
        });
    });

    it('sumUsageMetadata returns null when nothing carries usage', () => {
        expect(sumUsageMetadata([])).toBeNull();
        expect(sumUsageMetadata([{}, { usage_metadata: null }])).toBeNull();
    });
});
