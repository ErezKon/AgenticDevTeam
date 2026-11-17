/**
 * Cache-stable history compaction — "epoch" mode (Plan 30-06).
 *
 * The sliding compactor rewrote the history on every call: each turn the recent
 * window moved, a result that had been verbatim became a stub, and the prompt
 * changed at that point — so Anthropic could cache nothing past the task. In the
 * claudeopus5 run junior-angular sent ~8k uncached tokens on each of its 912 calls.
 *
 * An epoch compactor belongs to one agent instance. It compacts the history,
 * freezes the result, and from then on only appends: every call sends the frozen
 * view followed by the raw messages that arrived since, so each request extends
 * the previous one byte for byte and is read from the cache. It starts a new epoch
 * (one cache write) only when the view exceeds `maxChars` (HISTORY_MAX_CHARS) or
 * more than `maxTurns` (HISTORY_EPOCH_MAX_TURNS) model turns were appended: it then
 * runs `compactHistory()` over the full raw history — keeping the last
 * HISTORY_KEEP_RECENT_TURNS turns verbatim — down to `targetChars`
 * (HISTORY_EPOCH_TARGET_CHARS) and freezes that.
 *
 * Invariants:
 *   - the first message (the task) is never touched;
 *   - a frozen view always ends after a complete turn (it is taken right before a
 *     model call), so a tool call is never separated from its results;
 *   - a different first message (a new task) or a history that no longer extends
 *     the frozen one starts over.
 */
import { isAIMessage, type BaseMessage } from '@langchain/core/messages';
import {
    HISTORY_EPOCH_MAX_TURNS, HISTORY_EPOCH_TARGET_CHARS, HISTORY_KEEP_RECENT_TURNS, HISTORY_MAX_CHARS,
} from '../../config';
import { compactHistory, messageChars, type CompactionResult } from './history-compactor';

export interface EpochOptions {
    maxChars?: number;
    maxTurns?: number;
    targetChars?: number;
    keepRecentTurns?: number;
    /** Compaction memo scope (CLI mode), as for `compactHistory`. */
    threadId?: string;
}

export interface EpochResult extends CompactionResult {
    /** This call started a new epoch: the history was compacted and frozen again. */
    recompacted: boolean;
}

interface Epoch {
    firstKey: string;
    /** Raw messages the frozen view stands for. */
    rawLen: number;
    /** Key of the last of them — the raw history must still contain it at that position. */
    anchorKey: string;
    view: BaseMessage[];
}

/** Identity of a message across calls: its id (graph state assigns one), else its role and content. */
function messageKey(m: BaseMessage): string {
    return m.id ?? `${m.getType()}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
}

/** Model turns — AI messages that call tools — in `messages`. */
function countTurns(messages: BaseMessage[]): number {
    return messages.filter(m => isAIMessage(m) && (m.tool_calls?.length ?? 0) > 0).length;
}

function totalChars(messages: BaseMessage[]): number {
    return messages.reduce((sum, m) => sum + messageChars(m), 0);
}

/** True when `raw` is the history the epoch was frozen from, plus messages appended since. */
function extendsEpoch(epoch: Epoch, raw: BaseMessage[]): boolean {
    return raw.length >= epoch.rawLen
        && messageKey(raw[0]) === epoch.firstKey
        && messageKey(raw[epoch.rawLen - 1]) === epoch.anchorKey;
}

/**
 * Create the epoch compactor of one agent instance. Call it before every model
 * call with the raw history; it returns the view to send.
 */
export function createEpochCompactor(opts: EpochOptions = {}): (raw: BaseMessage[]) => EpochResult {
    const maxChars = opts.maxChars ?? HISTORY_MAX_CHARS;
    const maxTurns = opts.maxTurns ?? HISTORY_EPOCH_MAX_TURNS;
    const targetChars = opts.targetChars ?? HISTORY_EPOCH_TARGET_CHARS;
    const keepRecentTurns = opts.keepRecentTurns ?? HISTORY_KEEP_RECENT_TURNS;
    let epoch: Epoch | null = null;

    return (raw) => {
        const originalChars = totalChars(raw);
        const append = (view: BaseMessage[]): EpochResult => ({
            messages: view,
            stats: { originalChars, compactedChars: totalChars(view), toolResultsStubbed: 0, writeArgsStubbed: 0 },
            stubbedToolCallIds: [],
            recompacted: false,
        });
        if (raw.length <= 1) return append(raw);
        if (epoch && !extendsEpoch(epoch, raw)) epoch = null;

        const tail = raw.slice(epoch?.rawLen ?? 1);
        const view = epoch ? [...epoch.view, ...tail] : raw;
        if (totalChars(view) <= maxChars && countTurns(tail) <= maxTurns) return append(view);

        const compacted = compactHistory(raw, { maxChars: targetChars, keepRecentTurns, threadId: opts.threadId });
        epoch = {
            firstKey: messageKey(raw[0]),
            rawLen: raw.length,
            anchorKey: messageKey(raw[raw.length - 1]),
            view: compacted.messages,
        };
        return { ...compacted, recompacted: true };
    };
}
