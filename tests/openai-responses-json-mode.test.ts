/**
 * OpenAI Responses-API JSON mode — integration-with-the-real-package test
 * (Plan 21, sub-plan B).
 *
 * `tests/llm-provider.test.ts` mocks `@langchain/openai`, so it can only prove
 * that we call `withConfig`. This suite uses the REAL package (no network, no
 * auth — `invocationParams()` is pure) to prove the resulting request body is
 * the one each API actually accepts:
 *
 *   - `gpt-5.3-codex` -> Responses API      -> `text.format.type === 'json_object'`
 *   - `gpt-4o`        -> Chat Completions   -> `response_format.type === 'json_object'`
 *
 * The old `modelKwargs.response_format` emitted a top-level `response_format`
 * on BOTH, which the Responses API rejects with a 400.
 */
import { createChatModel } from '../src/agents/_shared/llm-provider';

/** `invocationParams` is protected; it is stable public-in-practice API for this check. */
function invocationParams(model: any): any {
    return model.invocationParams({});
}

const baseOpts = {
    temperature: 0.3,
    maxTokens: 1024,
    timeout: 30_000,
    callbacks: [],
    apiKey: 'test-key-not-used',
};

describe('OpenAI JSON mode across both APIs', () => {
    it('Responses-API model emits text.format, not top-level response_format', () => {
        const model = createChatModel({ ...baseOpts, modelName: 'gpt-5.3-codex', jsonMode: true });
        const params = invocationParams(model);

        expect(params.response_format).toBeUndefined();
        expect(params.text?.format?.type).toBe('json_object');
    });

    it('Chat-Completions model still emits response_format', () => {
        const model = createChatModel({ ...baseOpts, modelName: 'gpt-4o', jsonMode: true });
        const params = invocationParams(model);

        expect(params.response_format).toEqual({ type: 'json_object' });
        expect(params.text).toBeUndefined();
    });

    it('jsonMode=false leaves both response_format and text unset', () => {
        const model = createChatModel({ ...baseOpts, modelName: 'gpt-5.3-codex', jsonMode: false });
        const params = invocationParams(model);

        expect(params.response_format).toBeUndefined();
        expect(params.text?.format).toBeUndefined();
    });

    it('does not force a Chat-Completions model onto the Responses API', () => {
        const model: any = createChatModel({ ...baseOpts, modelName: 'gpt-4o', jsonMode: true });
        expect(invocationParams(model).text).toBeUndefined();
    });
});
