/**
 * LangChain callback that records every LLM call of an agent into the debug
 * trace (DEBUG_MODE): the exact request the model received — after history
 * compaction, cache breakpoints and tool withdrawal — plus the response,
 * usage, stop reason, served model and provider errors.
 *
 * Messages are de-duplicated per handler (one handler per agent instance):
 * the first time a message is sent it is recorded in full with a `hash`;
 * later requests carry `{ ref: hash }` instead, so a 40-turn ReAct loop
 * stores one copy of its history rather than forty.
 *
 * Created with `_awaitHandler: true`: by default LangChain queues callbacks
 * in the background, which would reorder these records relative to tool and
 * command records and lose the run's AsyncLocalStorage context.
 */
import { createHash } from 'crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { trace, serializeError } from './debug-trace';
import { getRunContext, type RunContext } from './run-context';
import { usageFromLLMResult } from './token-usage-extractor';
import { describeContentBlocks, extractTextFromContentBlocks } from './structured-output';

/** Model parameters worth recording (never credentials). */
const PARAM_KEYS = [
    'model', 'model_name', 'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens',
    'maxOutputTokens', 'tool_choice', 'parallel_tool_calls', 'response_format', 'text',
    'thinking', 'reasoning', 'reasoning_effort', 'stop', 'stop_sequences', 'stream',
];

/** Binary content blocks replaced by a size marker. */
const BINARY_BLOCK_TYPES = new Set(['image', 'image_url', 'media', 'document', 'file', 'audio', 'input_audio']);

interface ProjectedMessage {
    role: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
    cacheBreakpoint?: true;
    content: unknown;
    chars: number;
}

export class DebugTraceCallbackHandler extends BaseCallbackHandler {
    name = 'DebugTraceCallbackHandler';

    private readonly runCtx: RunContext | undefined;
    private invocationId: string | undefined;
    /** Hashes of messages / tool schemas this agent instance has already recorded in full. */
    private readonly seen = new Set<string>();
    private readonly startedAt = new Map<string, number>();

    constructor(
        private readonly agentId: string,
        private readonly model: string,
        private readonly phase: string,
    ) {
        super({ _awaitHandler: true });
        this.runCtx = getRunContext();
    }

    /** Tag subsequent LLM records with a token-tracker invocation id. */
    setInvocationId(id: string | undefined): void {
        this.invocationId = id;
    }

    handleChatModelStart(
        _llm: unknown,
        messages: BaseMessage[][],
        runId: string,
        _parentRunId?: string,
        extraParams?: Record<string, unknown>,
        _tags?: string[],
        metadata?: Record<string, unknown>,
    ): void {
        this.startedAt.set(runId, Date.now());
        const request = (messages[0] ?? []).map(projectMessage);
        const params = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
        trace({
            kind: 'llm',
            event: 'start',
            llmRunId: runId,
            ...this.identity(),
            threadId: metadata?.thread_id,
            step: metadata?.langgraph_step,
            params: pickParams(params),
            tools: this.describeTools(params.tools),
            messageCount: request.length,
            requestChars: request.reduce((sum, m) => sum + m.chars, 0),
            messages: request.map((m, i) => this.dedupe(m, i)),
        }, { ctx: this.runCtx });
    }

    handleLLMEnd(output: LLMResult, runId: string): void {
        const generation = output.generations?.[0]?.[0] as
            { text?: string; message?: any; generationInfo?: Record<string, unknown> } | undefined;
        const message = generation?.message;
        const content = message?.content ?? generation?.text;
        const meta = (message?.response_metadata ?? {}) as Record<string, unknown>;
        trace({
            kind: 'llm',
            event: 'end',
            llmRunId: runId,
            ...this.identity(),
            durationMs: this.elapsed(runId),
            usage: usageFromLLMResult(output) ?? undefined,
            stopReason: meta.stop_reason ?? meta.finish_reason
                ?? message?.additional_kwargs?.stop_reason ?? generation?.generationInfo?.finish_reason,
            responseModel: meta.model ?? meta.model_name,
            responseId: message?.id ?? meta.id,
            output: {
                text: typeof content === 'string' ? content : (extractTextFromContentBlocks(content) ?? undefined),
                blocks: describeContentBlocks(content),
                toolCalls: projectToolCalls(message?.tool_calls) ?? [],
                thinking: thinkingText(content),
            },
        }, { ctx: this.runCtx });
    }

    handleLLMError(err: unknown, runId: string): void {
        trace({
            kind: 'llm',
            event: 'error',
            llmRunId: runId,
            ...this.identity(),
            durationMs: this.elapsed(runId),
            error: serializeError(err),
        }, { ctx: this.runCtx });
    }

    private identity(): Record<string, unknown> {
        return { agentId: this.agentId, model: this.model, phase: this.phase, invocationId: this.invocationId };
    }

    private elapsed(runId: string): number | undefined {
        const started = this.startedAt.get(runId);
        this.startedAt.delete(runId);
        return started === undefined ? undefined : Date.now() - started;
    }

    /**
     * Full message (with `hash`) on first sight; `{ ref }` once this agent instance has recorded it.
     * The hash ignores `cacheBreakpoint` — Anthropic breakpoints move every turn.
     */
    private dedupe(message: ProjectedMessage, index: number): Record<string, unknown> {
        const { cacheBreakpoint, ...hashable } = message;
        const hash = shortHash(hashable);
        const marker = cacheBreakpoint ? { cacheBreakpoint } : {};
        if (this.seen.has(hash)) return { i: index, role: message.role, ref: hash, chars: message.chars, ...marker };
        this.seen.add(hash);
        return { i: index, hash, ...message };
    }

    /** Tool names on every call; the full schemas the first time this agent instance sends them. */
    private describeTools(tools: unknown): Record<string, unknown> | undefined {
        if (!Array.isArray(tools)) return undefined;
        const names = tools.map((t: any) => t?.function?.name ?? t?.name ?? 'unknown');
        if (tools.length === 0) return { names };
        const hash = shortHash(tools);
        if (this.seen.has(hash)) return { names, ref: hash };
        this.seen.add(hash);
        return { names, hash, schemas: tools };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortHash(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value) ?? '').digest('hex').slice(0, 12);
}

function pickParams(params: Record<string, unknown>): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const key of PARAM_KEYS) {
        if (params[key] !== undefined) picked[key] = params[key];
    }
    return picked;
}

function roleOf(message: any): string {
    if (typeof message?._getType === 'function') return message._getType();
    if (typeof message?.getType === 'function') return message.getType();
    return message?.type ?? message?.role ?? 'unknown';
}

function projectToolCalls(toolCalls: unknown): ProjectedMessage['tool_calls'] | undefined {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
    return toolCalls.map((c: any) => ({ id: c?.id, name: c?.name, args: c?.args }));
}

/** Content without Anthropic `cache_control` markers (they move every turn) and without binary payloads. */
function normaliseContent(content: unknown): { content: unknown; cacheBreakpoint: boolean } {
    if (!Array.isArray(content)) return { content, cacheBreakpoint: false };
    let cacheBreakpoint = false;
    const blocks = content.map((block) => {
        if (!block || typeof block !== 'object') return block;
        const { cache_control, ...rest } = block as Record<string, unknown>;
        if (cache_control !== undefined) cacheBreakpoint = true;
        if (typeof rest.type === 'string' && BINARY_BLOCK_TYPES.has(rest.type)) {
            return { type: rest.type, omittedChars: JSON.stringify(rest).length };
        }
        return rest;
    });
    return { content: blocks, cacheBreakpoint };
}

function projectMessage(message: BaseMessage): ProjectedMessage {
    const m = message as any;
    const { content, cacheBreakpoint } = normaliseContent(m.content);
    const toolCalls = projectToolCalls(m.tool_calls);
    const chars = (typeof content === 'string' ? content.length : (JSON.stringify(content) ?? '').length)
        + (toolCalls ? JSON.stringify(toolCalls).length : 0);
    return {
        role: roleOf(m),
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(cacheBreakpoint ? { cacheBreakpoint: true as const } : {}),
        content,
        chars,
    };
}

/** Concatenated thinking / reasoning blocks — the model's own explanation of what it is doing. */
function thinkingText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts = content
        .filter((b: any) => b && (b.type === 'thinking' || b.type === 'reasoning'))
        .map((b: any) => b.thinking ?? b.reasoning ?? b.text ?? '')
        .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);
    return parts.length > 0 ? parts.join('\n') : undefined;
}
