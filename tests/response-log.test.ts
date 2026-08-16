/**
 * Full-response logging — outputs/<run>/full-responses/.
 *
 * run.log records what the pipeline decided; these dumps record what the model
 * actually returned. They are the only artefact that can distinguish "the agent
 * produced nothing" from "we failed to read what the agent produced".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
    initResponseLog, logAgentResponse, readResponseLogIndex, _resetResponseLog,
} from '../src/utils/response-log';
import { FULL_RESPONSE_LOG_DIR_NAME } from '../src/config';

let outDir: string;

beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-resplog-'));
    _resetResponseLog();
    initResponseLog(outDir);
});

afterEach(() => {
    _resetResponseLog();
    fs.rmSync(outDir, { recursive: true, force: true });
});

const logDir = () => path.join(outDir, FULL_RESPONSE_LOG_DIR_NAME);

describe('logAgentResponse', () => {
    it('writes one numbered file per invocation plus an index line', () => {
        const result = {
            messages: [
                new HumanMessage('design the system'),
                new AIMessage({ content: '{"architecture":{"style":"layered"}}' }),
            ],
        };
        const file = logAgentResponse(
            { agentId: 'architect', phase: 'architect', model: 'gpt-5.3-codex', userMessage: 'design the system' },
            result,
        );

        expect(file).toBe(path.join(logDir(), '001-architect-architect.json'));
        const dump = JSON.parse(fs.readFileSync(file!, 'utf-8'));

        // Messages keep LangChain's canonical serialisation, so a dump can be
        // replayed / diffed against a reference capture.
        expect(dump.model_request.messages).toHaveLength(2);
        expect(dump.model_request.messages[1].id).toEqual(['langchain_core', 'messages', 'AIMessage']);
        expect(dump.user_message).toBe('design the system');
        expect(dump.meta).toMatchObject({
            agentId: 'architect', phase: 'architect', model: 'gpt-5.3-codex',
            kind: 'invoke', textSource: 'string',
        });

        const index = readResponseLogIndex(outDir);
        expect(index).toHaveLength(1);
        expect(index[0]).toMatchObject({
            seq: 1, file: '001-architect-architect.json',
            agentId: 'architect', messageCount: 2, textSource: 'string',
        });
    });

    it('records content-block responses and their text source', () => {
        logAgentResponse({ agentId: 'architect', phase: 'architect', model: 'claude-sonnet-5' }, {
            messages: [new AIMessage({ content: [{ type: 'text', text: '{"epics":[]}' }] as any })],
        });

        const entry = readResponseLogIndex(outDir)[0];
        expect(entry.textSource).toBe('content-blocks');
        expect(entry.finalContentBlocks).toBe('text×1');
        expect(entry.textChars).toBe('{"epics":[]}'.length);
    });

    it('flags a reasoning-only response as producing no text', () => {
        logAgentResponse({ agentId: 'architect', phase: 'architect' }, {
            messages: [new AIMessage({ content: [{ type: 'reasoning', reasoning: 'thinking…' }] as any })],
        });

        const entry = readResponseLogIndex(outDir)[0];
        expect(entry.textSource).toBe('none');
        expect(entry.textChars).toBe(0);
        expect(entry.finalContentBlocks).toBe('reasoning×1');
    });

    it('captures structuredResponse when the provider returns one', () => {
        const file = logAgentResponse({ agentId: 'dba', phase: 'dba' }, {
            messages: [new AIMessage({ content: '{}' })],
            structuredResponse: { entities: [] },
        });
        const dump = JSON.parse(fs.readFileSync(file!, 'utf-8'));
        expect(dump.model_request.structuredResponse).toEqual({ entities: [] });
        expect(readResponseLogIndex(outDir)[0].hasStructuredResponse).toBe(true);
    });

    it('names repair attempts distinctly so a re-ask is visible in the flow', () => {
        const result = { messages: [new AIMessage({ content: '{}' })] };
        logAgentResponse({ agentId: 'architect', phase: 'architect' }, result);
        const repair = logAgentResponse(
            { agentId: 'architect', phase: 'architect', kind: 'repair', attempt: 1 }, result,
        );

        expect(path.basename(repair!)).toBe('002-architect-architect-repair1.json');
        expect(readResponseLogIndex(outDir).map(e => e.kind)).toEqual(['invoke', 'repair']);
    });

    it('stores each agent system prompt once and points later dumps at it', () => {
        const result = { messages: [new AIMessage({ content: '{}' })] };
        const meta = { agentId: 'architect', phase: 'architect', systemPrompt: 'YOU ARE THE ARCHITECT…' };

        const first = logAgentResponse(meta, result);
        const second = logAgentResponse(meta, result);

        expect(JSON.parse(fs.readFileSync(first!, 'utf-8')).system_prompt).toBe('YOU ARE THE ARCHITECT…');
        expect(JSON.parse(fs.readFileSync(second!, 'utf-8')).system_prompt)
            .toEqual({ see: '001-architect-architect.json' });
    });

    it('is a no-op (never throws) when the log was not initialised', () => {
        _resetResponseLog();
        expect(logAgentResponse({ agentId: 'a', phase: 'p' }, { messages: [] })).toBeNull();
    });

    it('survives cyclic and non-serialisable payloads', () => {
        const cyclic: any = { messages: [] };
        cyclic.self = cyclic;
        const file = logAgentResponse({ agentId: 'qa-lead', phase: 'qa' }, cyclic);
        expect(file).not.toBeNull();
        expect(() => JSON.parse(fs.readFileSync(file!, 'utf-8'))).not.toThrow();
    });
});
