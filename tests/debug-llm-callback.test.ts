/**
 * LLM request/response tracing (DEBUG_MODE) — DebugTraceCallbackHandler.
 *
 * The handler is the only record of what each model call actually received
 * after history compaction, so it must capture the exact request, keep it
 * compact (messages de-duplicated per agent instance) and preserve the
 * provider's error diagnostics.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    DEBUG_MODE: true,
    DEBUG_TRACE_MAX_FIELD_CHARS: 5000,
}));

import * as fs from 'fs';
import * as path from 'path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';
import { RunContext, runWithContext } from '../src/utils/run-context';
import { initDebugTrace, _resetDebugTrace } from '../src/utils/debug-trace';
import { DebugTraceCallbackHandler } from '../src/utils/debug-llm-callback';

const TOOLS = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } }];
const PARAMS = {
    invocation_params: { model: 'gpt-x', max_tokens: 100, temperature: 0.3, tools: TOOLS, api_key: 'never-recorded-key' },
};

let outDir: string;

beforeEach(() => {
    _resetDebugTrace();
    outDir = makeTempDir('adt-llm-trace-');
});

afterEach(() => cleanupDir(outDir));

const traceFile = () => path.join(outDir, 'debug', 'trace.jsonl');
const llmRecords = (event: string) => readJsonl(traceFile()).filter(r => r.kind === 'llm' && r.event === event);
const inRun = (fn: () => void) => runWithContext(new RunContext('run-llm'), async () => {
    initDebugTrace(outDir);
    fn();
});

describe('DebugTraceCallbackHandler', () => {
    it('runs inline (awaited) so records stay ordered and keep the run context', () => {
        expect(new DebugTraceCallbackHandler('architect', 'm', 'architect').awaitHandlers).toBe(true);
    });

    it('records the exact request and de-duplicates messages this agent already sent', async () => {
        const system = new SystemMessage('You are a dev.');
        const task = new HumanMessage('Build the board.');
        const ai = new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }] });
        const toolResult = new ToolMessage({ content: 'file body', tool_call_id: 'call_1', name: 'read_file' });

        await inRun(() => {
            const handler = new DebugTraceCallbackHandler('junior-react', 'gpt-x', 'development');
            handler.setInvocationId('inv-1');
            handler.handleChatModelStart({}, [[system, task]], 'run-1', undefined, PARAMS, [], { thread_id: 't-1', langgraph_step: 1 });
            handler.handleChatModelStart({}, [[system, task, ai, toolResult]], 'run-2', undefined, PARAMS, [], { thread_id: 't-1', langgraph_step: 3 });
        });

        const [first, second] = llmRecords('start');
        expect(first).toMatchObject({
            llmRunId: 'run-1', agentId: 'junior-react', model: 'gpt-x', phase: 'development', invocationId: 'inv-1',
            threadId: 't-1', step: 1, messageCount: 2,
            params: { model: 'gpt-x', max_tokens: 100, temperature: 0.3 },
            tools: { names: ['read_file'], schemas: TOOLS },
        });
        expect(first.params).not.toHaveProperty('api_key');
        expect(first.messages[0]).toMatchObject({ i: 0, role: 'system', content: 'You are a dev.', hash: expect.any(String) });

        expect(second.messages[0]).toEqual({ i: 0, role: 'system', ref: first.messages[0].hash, chars: 'You are a dev.'.length });
        expect(second.messages[1]).toEqual({ i: 1, role: 'human', ref: first.messages[1].hash, chars: 'Build the board.'.length });
        expect(second.messages[2]).toMatchObject({ role: 'ai', tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }] });
        expect(second.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'file body' });
        expect(second.tools).toEqual({ names: ['read_file'], ref: first.tools.hash });
        expect(fs.readFileSync(traceFile(), 'utf-8')).not.toContain('never-recorded-key');
    });

    it('ignores moving Anthropic cache_control markers when de-duplicating', async () => {
        const marked = new HumanMessage({ content: [{ type: 'text', text: 'task', cache_control: { type: 'ephemeral' } }] as any });
        const unmarked = new HumanMessage({ content: [{ type: 'text', text: 'task' }] });

        await inRun(() => {
            const handler = new DebugTraceCallbackHandler('architect', 'claude-sonnet-5', 'architect');
            handler.handleChatModelStart({}, [[marked]], 'r1', undefined, {}, [], {});
            handler.handleChatModelStart({}, [[unmarked]], 'r2', undefined, {}, [], {});
        });

        const [first, second] = llmRecords('start');
        expect(first.messages[0]).toMatchObject({ cacheBreakpoint: true, content: [{ type: 'text', text: 'task' }] });
        expect(first.messages[0].content[0]).not.toHaveProperty('cache_control');
        expect(second.messages[0]).toEqual({ i: 0, role: 'human', ref: first.messages[0].hash, chars: first.messages[0].chars });
    });

    it('replaces binary content blocks with a size marker', async () => {
        const base64 = 'A'.repeat(800);
        const screenshot = new HumanMessage({
            content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }, { type: 'text', text: 'see image' }] as any,
        });

        await inRun(() => {
            new DebugTraceCallbackHandler('qa-e2e', 'gpt-x', 'e2e')
                .handleChatModelStart({}, [[screenshot]], 'r1', undefined, {}, [], {});
        });

        const [start] = llmRecords('start');
        expect(start.messages[0].content[0]).toEqual({ type: 'image_url', omittedChars: expect.any(Number) });
        expect(start.messages[0].content[1]).toEqual({ type: 'text', text: 'see image' });
        expect(fs.readFileSync(traceFile(), 'utf-8')).not.toContain(base64);
    });

    it('records the response: text, tool calls, thinking, usage, stop reason and served model', async () => {
        await inRun(() => {
            const handler = new DebugTraceCallbackHandler('architect', 'claude-sonnet-5', 'architect');
            handler.handleChatModelStart({}, [[new HumanMessage('design it')]], 'run-9', undefined, {}, [], {});
            const message = new AIMessage({
                content: [{ type: 'thinking', thinking: 'plan first' }, { type: 'text', text: '{"ok":true}' }] as any,
                response_metadata: { stop_reason: 'end_turn', model: 'claude-sonnet-5-20260101' },
                usage_metadata: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
            });
            handler.handleLLMEnd({ generations: [[{ text: '', message } as any]] }, 'run-9');
        });

        const [end] = llmRecords('end');
        expect(end).toMatchObject({
            llmRunId: 'run-9', agentId: 'architect',
            stopReason: 'end_turn', responseModel: 'claude-sonnet-5-20260101',
            usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
            output: { text: '{"ok":true}', blocks: 'thinking×1, text×1', thinking: 'plan first', toolCalls: [] },
        });
        expect(typeof end.durationMs).toBe('number');
    });

    it('records provider errors with status and request-id, and indexes them as failures', async () => {
        const err = Object.assign(new Error('429 Too Many Requests'), {
            status: 429,
            headers: new Map([['request-id', 'req_9'], ['retry-after', '30']]),
        });

        await inRun(() => {
            const handler = new DebugTraceCallbackHandler('qa-unit', 'gpt-x', 'qa');
            handler.handleChatModelStart({}, [[new HumanMessage('write tests')]], 'run-e', undefined, {}, [], {});
            handler.handleLLMError(err, 'run-e');
        });

        const [failure] = llmRecords('error');
        expect(failure).toMatchObject({
            llmRunId: 'run-e', agentId: 'qa-unit',
            error: { status: 429, message: '429 Too Many Requests', headers: { 'request-id': 'req_9', 'retry-after': '30' } },
        });
        const errors = readJsonl(path.join(outDir, 'debug', 'errors.jsonl'));
        expect(errors.map(r => r.seq)).toEqual([failure.seq]);
    });
});
