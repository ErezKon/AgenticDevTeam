/**
 * ReAct history compaction — `wrapModelCall` middleware transformer.
 *
 * Compacts a ReAct message history before each LLM call, replacing older
 * tool results with one-line stubs and eliding large write_file/edit_file
 * arguments. This directly fixes the O(steps²) input-token growth that
 * dominates cost (see plan §0, evidence item 1).
 *
 * Pure function — no I/O, no LangGraph types beyond BaseMessage.
 */

import {
    AIMessage,
    ToolMessage,
    isAIMessage,
    isToolMessage,
    type BaseMessage,
} from '@langchain/core/messages';
import {
    HISTORY_KEEP_RECENT_TOOL_RESULTS,
    HISTORY_KEEP_RECENT_TURNS,
    HISTORY_KEEP_RECENT_WRITE_ARGS,
    HISTORY_MAX_CHARS,
} from '../../config';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompactionStats {
    originalChars: number;
    compactedChars: number;
    toolResultsStubbed: number;
    writeArgsStubbed: number;
}

/** Cumulative compaction stats across all invocations in a run. */
export interface CumulativeCompactionStats {
    invocations: number;
    totalOriginalChars: number;
    totalCompactedChars: number;
    totalToolResultsStubbed: number;
    totalWriteArgsStubbed: number;
    savedChars: number;
    savedPct: number;
}

// ─── Global stats accumulator ───────────────────────────────────────────────

let _cumulative = { invocations: 0, totalOriginal: 0, totalCompacted: 0, toolStubs: 0, writeStubs: 0 };

/** Record a compaction invocation's stats into the global accumulator. */
export function recordCompaction(stats: CompactionStats): void {
    _cumulative.invocations++;
    _cumulative.totalOriginal += stats.originalChars;
    _cumulative.totalCompacted += stats.compactedChars;
    _cumulative.toolStubs += stats.toolResultsStubbed;
    _cumulative.writeStubs += stats.writeArgsStubbed;
}

/** Get the cumulative compaction stats for the current run. */
export function getCumulativeCompactionStats(): CumulativeCompactionStats {
    const saved = _cumulative.totalOriginal - _cumulative.totalCompacted;
    return {
        invocations: _cumulative.invocations,
        totalOriginalChars: _cumulative.totalOriginal,
        totalCompactedChars: _cumulative.totalCompacted,
        totalToolResultsStubbed: _cumulative.toolStubs,
        totalWriteArgsStubbed: _cumulative.writeStubs,
        savedChars: saved,
        savedPct: _cumulative.totalOriginal > 0 ? Math.round((saved / _cumulative.totalOriginal) * 100) : 0,
    };
}

/** Reset cumulative stats (for testing / run start). */
export function _resetCompactionStats(): void {
    _cumulative = { invocations: 0, totalOriginal: 0, totalCompacted: 0, toolStubs: 0, writeStubs: 0 };
}

// ─── Compaction memoisation (Plan 24, C1) ───────────────────────────────────
//
// Once a message has been rendered as an elision marker, the marker bytes must
// be identical on every subsequent turn — otherwise the Anthropic prompt cache
// prefix is invalidated each time the recent window slides forward.  A
// module-level Map keyed by message id (or a synthetic key) stores the first
// rendering and reuses it verbatim.

let _compactionMemo: Map<string, string> = new Map();
let _memoThreadId: string = '';

/** Clear the memoisation cache (exposed for testing). */
export function _resetCompactionMemo(): void {
    _compactionMemo = new Map();
    _memoThreadId = '';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Measure the character length of a message's serialisable content. */
function messageChars(m: BaseMessage): number {
    const contentLen = typeof m.content === 'string'
        ? m.content.length
        : JSON.stringify(m.content).length;

    if (isAIMessage(m) && m.tool_calls?.length) {
        return contentLen + JSON.stringify(m.tool_calls).length;
    }
    return contentLen;
}

/** Threshold (chars) above which a string arg in a tool call is elided. */
const ELIDE_ARG_THRESHOLD = 400;

/**
 * Elision marker (Plan 22, B2).
 *
 * The old marker was `[1204 chars elided]`. In the pacmanclaude run a dev agent
 * saw fifteen of those in its own compacted history and then emitted
 * `write_file("src/persistence/SettingsStore.ts", "[770 chars elided]")` for
 * three brand-new files — pattern imitation, not a state bug. Two properties fix
 * that: the marker must not look like plausible source text, and it must carry
 * its own instruction. `checkWritePayload()` in `workspace-tools.ts` is the
 * belt-and-braces enforcement.
 */
function elisionMarker(chars: number, what: string): string {
    return `⟪ORCHESTRATOR-ELIDED ${chars} chars of ${what} — already on disk; NEVER copy this marker into a file⟫`;
}

/**
 * Replace any string arg value longer than ELIDE_ARG_THRESHOLD with an elision
 * marker. Preserves short args (e.g. filePath) verbatim.
 *
 * Plan 24, C1: each elided arg is memoised by `memoKey + argName` so the
 * Anthropic cache prefix stays byte-stable across turns.
 */
function elideBigArgs(args: Record<string, unknown>, memoKey: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.length > ELIDE_ARG_THRESHOLD) {
            const argMemoKey = `${memoKey}::arg::${key}`;
            const cached = _compactionMemo.get(argMemoKey);
            if (cached !== undefined) {
                result[key] = cached;
            } else {
                const marker = elisionMarker(value.length, `the "${key}" argument`);
                _compactionMemo.set(argMemoKey, marker);
                result[key] = marker;
            }
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Build a one-line stub for a ToolMessage, preserving the tool name
 * and the original content size so the model knows what was there.
 *
 * Plan 24, C1: the stub is memoised by message key so that the same message
 * always produces the exact same bytes, keeping the Anthropic cache prefix
 * stable as the recent window slides.
 */
function stubToolContent(m: ToolMessage, memoKey: string): string {
    const cached = _compactionMemo.get(memoKey);
    if (cached !== undefined) return cached;

    const contentLen = typeof m.content === 'string'
        ? m.content.length
        : JSON.stringify(m.content).length;
    const name = m.name ?? 'unknown_tool';
    const stub = elisionMarker(contentLen, `the ${name} result`);
    _compactionMemo.set(memoKey, stub);
    return stub;
}

// ─── Streaming content-block sanitiser (Plan 21, E1) ────────────────────────

/**
 * True for content-block types that are streaming *deltas* and must never be
 * re-sent to a provider (`input_json_delta`, `text_delta`, `thinking_delta`, …).
 */
function isDeltaBlock(type: unknown): boolean {
    return typeof type === 'string' && type.endsWith('_delta');
}

/** Content-block types that carry a provider-assigned tool-call id. */
const TOOL_USE_BLOCK_TYPES = new Set(['tool_use', 'server_tool_use']);

/**
 * Strip streaming residue from `AIMessage` content blocks.
 *
 * When `ChatAnthropic` runs with `streaming: true`, chunk reassembly can leave
 * `input_json_delta` blocks — and `tool_use` blocks with an empty `id` — inside
 * `AIMessage.content`. Older `@langchain/anthropic` re-sent those verbatim,
 * producing `400 … messages.N.content.M.tool_use.id: Field required` on the
 * *next* turn, which killed every dev and reviewer agent in the pacmanclaude run.
 *
 * `@langchain/anthropic@1.5.x` fixes this at the adapter level, but the failure
 * mode is silent, total, and billable — and the adapter fix does not cover
 * histories restored from a checkpoint that were corrupted by an older version.
 * So we sanitise defensively on every model call.
 *
 * `tool_calls` is deliberately left untouched: the provider adapter
 * re-materialises the `tool_use` blocks from it.
 *
 * Operates on a **copy** — the persisted graph state is never mutated.
 */
export function sanitizeStreamingContentBlocks(
    messages: BaseMessage[],
): { messages: BaseMessage[]; blocksDropped: number } {
    let blocksDropped = 0;
    const out = messages.map(m => {
        if (!isAIMessage(m) || !Array.isArray(m.content)) return m;

        const blocks = m.content as unknown[];
        // Plan 22 E1: `tool_use` blocks arrive with `input: ''` and the real
        // arguments follow in sibling `input_json_delta` blocks. Reconstruct the
        // input from those siblings so a repaired block is never sent with empty
        // arguments — the model's own history was showing it calling `read_file`
        // with no path at all.
        const deltaInputByIndex = new Map<unknown, string>();
        for (const block of blocks) {
            if (block === null || typeof block !== 'object') continue;
            const b = block as { type?: unknown; index?: unknown; input?: unknown };
            if (b.type === 'input_json_delta' && typeof b.input === 'string') {
                deltaInputByIndex.set(b.index, (deltaInputByIndex.get(b.index) ?? '') + b.input);
            }
        }

        const toolCallArgsById = new Map<string, unknown>();
        for (const tc of m.tool_calls ?? []) {
            if (tc.id) toolCallArgsById.set(tc.id, tc.args);
        }

        const cleaned: unknown[] = [];
        for (const block of blocks) {
            if (block === null || typeof block !== 'object') { cleaned.push(block); continue; }
            const b = block as { type?: unknown; id?: unknown; index?: unknown; input?: unknown };

            if (isDeltaBlock(b.type)) { blocksDropped++; continue; }

            if (typeof b.type === 'string' && TOOL_USE_BLOCK_TYPES.has(b.type)) {
                const id = b.id;
                const hasId = typeof id === 'string' && id.length > 0;
                const hasInput = b.input !== undefined && b.input !== '' && b.input !== null;

                // No id — the provider adapter re-materialises the call from
                // `tool_calls`, so the block is pure residue.
                if (!hasId) { blocksDropped++; continue; }

                if (!hasInput) {
                    // Prefer the authoritative parsed args from `tool_calls`.
                    const fromToolCalls = toolCallArgsById.get(id as string);
                    if (fromToolCalls !== undefined) { blocksDropped++; continue; }

                    // No matching tool_call: rebuild from the sibling deltas
                    // rather than forwarding an argument-less tool_use.
                    const raw = deltaInputByIndex.get(b.index);
                    if (raw) {
                        try {
                            cleaned.push({ ...b, input: JSON.parse(raw) });
                            blocksDropped++;    // the deltas were consumed
                            continue;
                        } catch { /* unparseable — fall through and drop */ }
                    }
                    blocksDropped++;
                    continue;
                }
            }

            cleaned.push(block);
        }

        if (cleaned.length === blocks.length) return m;

        return new AIMessage({
            content: cleaned as any,
            ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
            id: m.id,
        });
    });

    return { messages: blocksDropped > 0 ? out : messages, blocksDropped };
}

/**
 * Normalise a freshly-returned `AIMessageChunk` into a clean `AIMessage`
 * *before* it is persisted into graph state (Plan 22, E2).
 *
 * `sanitizeStreamingContentBlocks` deliberately works on a copy, so residue
 * accumulates in the checkpoint and is re-scanned on every subsequent turn —
 * which is why the pacmanclaude log shows `dropped 2 … dropped 31` growing
 * monotonically within one invocation. Normalising at the state boundary makes
 * that counter flat; the copy-based sanitiser stays as the checkpoint-resume
 * safety net.
 *
 * Returns the input unchanged when there is nothing to normalise.
 */
export function normaliseAIMessageForState<T>(message: T): T {
    const m = message as unknown as BaseMessage;
    if (!isAIMessage(m) || !Array.isArray(m.content)) return message;
    const { messages: [clean], blocksDropped } = sanitizeStreamingContentBlocks([m]);
    if (blocksDropped === 0) return message;
    return clean as unknown as T;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Compact a ReAct message history for the next LLM call.
 *
 * Rules, in order:
 *  1. Never touch the first message (the task) or the last `keepRecent`
 *     tool results — the model needs both to make its next decision.
 *  2. Replace the CONTENT of older ToolMessages with a one-line receipt:
 *     `[read_file src/App.tsx -> 4,210 chars, elided]`.
 *  3. Replace the `content` / `newString` ARGUMENTS of older write_file /
 *     edit_file tool calls with `[<n> chars elided - file already written]`.
 *     The tool NAME and PATH stay, so the model still knows what it did.
 *  4. If still over `maxChars`, drop the oldest stubbed pairs
 *     (never the first message, never the last `keepRecent`).
 *
 * **Critical invariant:** every `AIMessage` with `tool_calls` must always
 * be followed by its matching `ToolMessage`s. We stub, never delete,
 * unless we drop the whole AI/Tool group together in rule 4.
 */
export function compactHistory(
    messages: BaseMessage[],
    opts?: { keepRecent?: number; maxChars?: number; keepRecentTurns?: number; keepRecentWriteArgs?: number; threadId?: string },
): { messages: BaseMessage[]; stats: CompactionStats } {
    const keepRecent = opts?.keepRecent ?? HISTORY_KEEP_RECENT_TOOL_RESULTS;
    const keepRecentTurns = opts?.keepRecentTurns ?? HISTORY_KEEP_RECENT_TURNS;
    const keepRecentWriteArgs = opts?.keepRecentWriteArgs ?? HISTORY_KEEP_RECENT_WRITE_ARGS;
    const maxChars = opts?.maxChars ?? HISTORY_MAX_CHARS;

    // Plan 24, C1: clear the memoisation cache when the thread changes so
    // different invocations do not share stale elision markers.
    const threadId = opts?.threadId ?? '';
    if (threadId && threadId !== _memoThreadId) {
        _compactionMemo.clear();
        _memoThreadId = threadId;
    }

    const originalChars = messages.reduce((sum, m) => sum + messageChars(m), 0);
    let toolResultsStubbed = 0;
    let writeArgsStubbed = 0;

    // Short-circuit: nothing to compact (single message or empty)
    if (messages.length <= 1) {
        return {
            messages,
            stats: { originalChars, compactedChars: originalChars, toolResultsStubbed: 0, writeArgsStubbed: 0 },
        };
    }

    // ── Identify the "recent" window ────────────────────────────────────
    // Plan 22 B4: the boundary is measured in *model turns*, not tool results.
    // Counting tool results puts the boundary INSIDE the current turn when a
    // model batches 8–11 parallel calls, so the compactor was stubbing results
    // the model was about to reason over — which forced the re-reads that then
    // exhausted the tool budget. `keepRecent` survives as a lower bound.
    const turnBoundary = findTurnBoundary(messages, keepRecentTurns);
    const resultBoundary = findToolResultBoundary(messages, keepRecent);
    const recentBoundary = Math.min(turnBoundary, resultBoundary);

    // Indices of AIMessages holding one of the last `keepRecentWriteArgs` write
    // turns. Their arguments stay verbatim: the model needs to see its most
    // recent writes to diff against them, and this is exactly the window where
    // placeholder imitation was observed (Plan 22 B3).
    const exemptWriteArgIndexes = findRecentWriteTurnIndexes(messages, keepRecentWriteArgs);

    // ── Build the compacted message array ────────────────────────────────
    const compacted: BaseMessage[] = [];

    // Rule 1: first message is always kept verbatim
    compacted.push(messages[0]);

    // Process middle section (index 1..recentBoundary-1): eligible for stubbing
    for (let i = 1; i < recentBoundary; i++) {
        const m = messages[i];

        // Rule 2: Stub older ToolMessages
        if (isToolMessage(m)) {
            // Plan 24, C1: use message id (or tool_call_id + index) as memo key
            const tm = m as ToolMessage;
            const memoKey = tm.id ?? `tool::${tm.tool_call_id}::${i}`;
            const stub = stubToolContent(tm, memoKey);
            compacted.push(new ToolMessage({
                content: stub,
                tool_call_id: tm.tool_call_id,
                name: tm.name,
            }));
            toolResultsStubbed++;
            continue;
        }

        // Rule 3: Elide big args in older AIMessage tool calls
        if (isAIMessage(m) && m.tool_calls?.length) {
            if (exemptWriteArgIndexes.has(i)) {
                compacted.push(m);
                continue;
            }
            let anyElided = false;
            // Plan 24, C1: memo key per AI message + tool call index
            const aiMemoBase = m.id ?? `ai::${i}`;
            const elidedToolCalls = m.tool_calls.map((tc, tcIdx) => {
                const tcMemoKey = `${aiMemoBase}::tc::${tcIdx}`;
                const elidedArgs = elideBigArgs(tc.args as Record<string, unknown>, tcMemoKey);
                if (JSON.stringify(elidedArgs) !== JSON.stringify(tc.args)) {
                    anyElided = true;
                }
                return { ...tc, args: elidedArgs };
            });

            if (anyElided) {
                writeArgsStubbed++;
                compacted.push(new AIMessage({
                    content: m.content,
                    tool_calls: elidedToolCalls,
                    id: m.id,
                }));
            } else {
                compacted.push(m);
            }
            continue;
        }

        // All other messages in the old section: keep as-is
        compacted.push(m);
    }

    // Recent window: keep verbatim
    for (let i = recentBoundary; i < messages.length; i++) {
        compacted.push(messages[i]);
    }

    // If nothing was stubbed or elided, return the original array unchanged
    if (toolResultsStubbed === 0 && writeArgsStubbed === 0) {
        return {
            messages,
            stats: { originalChars, compactedChars: originalChars, toolResultsStubbed: 0, writeArgsStubbed: 0 },
        };
    }

    // ── Rule 4: hard ceiling — drop oldest stubbed groups ────────────────
    let currentChars = compacted.reduce((sum, m) => sum + messageChars(m), 0);

    if (currentChars > maxChars) {
        // Identify droppable groups: contiguous AI(tool_calls)+ToolMessage
        // groups in the middle section (between index 1 and the recent boundary).
        // We must drop entire groups to maintain the tool_call_id pairing.
        const droppableGroups = identifyDroppableGroups(compacted, keepRecent);

        // Drop from oldest first
        const dropIndices = new Set<number>();
        for (const group of droppableGroups) {
            if (currentChars <= maxChars) break;
            for (const idx of group) {
                currentChars -= messageChars(compacted[idx]);
                dropIndices.add(idx);
            }
        }

        if (dropIndices.size > 0) {
            const filtered = compacted.filter((_, i) => !dropIndices.has(i));
            const compactedChars = filtered.reduce((sum, m) => sum + messageChars(m), 0);
            return {
                messages: filtered,
                stats: { originalChars, compactedChars, toolResultsStubbed, writeArgsStubbed },
            };
        }
    }

    const compactedChars = compacted.reduce((sum, m) => sum + messageChars(m), 0);
    return {
        messages: compacted,
        stats: { originalChars, compactedChars, toolResultsStubbed, writeArgsStubbed },
    };
}

// ─── Recent-window boundary helpers (Plan 22, B3/B4) ────────────────────────

/** Tool names whose arguments carry file content worth protecting from elision. */
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file']);

/** Indexes of every AIMessage that carries at least one tool call. */
function turnIndexes(messages: BaseMessage[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < messages.length; i++) {
        const m = messages[i];
        if (isAIMessage(m) && m.tool_calls?.length) out.push(i);
    }
    return out;
}

/**
 * First index of the window containing the last `keepTurns` tool-calling AI
 * turns. Everything at or after the returned index is kept verbatim, so a turn's
 * results are never split from the turn that produced them.
 */
export function findTurnBoundary(messages: BaseMessage[], keepTurns: number): number {
    if (keepTurns <= 0) return messages.length;
    const turns = turnIndexes(messages);
    if (turns.length === 0) return messages.length;
    if (turns.length <= keepTurns) return 1;      // nothing old enough to stub
    return turns[turns.length - keepTurns];
}

/**
 * Legacy boundary: first index of the window containing the last `keepRecent`
 * ToolMessages, extended back to the AI turn that produced them. Retained as a
 * lower bound so `HISTORY_KEEP_RECENT_TOOL_RESULTS` still has an effect.
 */
export function findToolResultBoundary(messages: BaseMessage[], keepRecent: number): number {
    if (keepRecent <= 0) return messages.length;
    let seen = 0;
    for (let i = messages.length - 1; i >= 1; i--) {
        if (!isToolMessage(messages[i])) continue;
        seen++;
        if (seen < keepRecent) continue;
        let boundary = i;
        for (let j = i - 1; j >= 1; j--) {
            const candidate = messages[j];
            if (isAIMessage(candidate) && candidate.tool_calls?.length) { boundary = j; break; }
        }
        return boundary;
    }
    return 1;   // fewer tool results than keepRecent — everything is "recent"
}

/**
 * Indexes of the AIMessages holding the last `keepWriteTurns` turns that
 * contained a write tool call. Their arguments are exempt from elision.
 */
export function findRecentWriteTurnIndexes(messages: BaseMessage[], keepWriteTurns: number): Set<number> {
    const exempt = new Set<number>();
    if (keepWriteTurns <= 0) return exempt;
    for (let i = messages.length - 1; i >= 1 && exempt.size < keepWriteTurns; i--) {
        const m = messages[i];
        if (!isAIMessage(m) || !m.tool_calls?.length) continue;
        if (m.tool_calls.some(tc => WRITE_TOOL_NAMES.has(tc.name))) exempt.add(i);
    }
    return exempt;
}

/**
 * Identify groups of messages that can be dropped together.
 * A group is an AIMessage with tool_calls followed by its matching ToolMessages.
 * Returns arrays of indices, oldest first, excluding the first message and
 * the last `keepRecent` tool results.
 */
function identifyDroppableGroups(
    messages: BaseMessage[],
    keepRecent: number,
): number[][] {
    const groups: number[][] = [];

    // Find the recent boundary (last keepRecent ToolMessages)
    let recentStart = messages.length;
    let seen = 0;
    for (let i = messages.length - 1; i >= 1; i--) {
        if (isToolMessage(messages[i])) {
            seen++;
            if (seen >= keepRecent) {
                // Walk back to find the parent AIMessage
                for (let j = i - 1; j >= 1; j--) {
                    const candidate = messages[j];
                    if (isAIMessage(candidate) && candidate.tool_calls?.length) {
                        recentStart = j;
                        break;
                    }
                }
                if (recentStart === messages.length) recentStart = i;
                break;
            }
        }
    }

    // Scan the droppable region (index 1..recentStart-1)
    let i = 1;
    while (i < recentStart) {
        const m = messages[i];
        if (isAIMessage(m) && m.tool_calls?.length) {
            const group = [i];
            // Collect the following ToolMessages that match
            const expectedIds = new Set(m.tool_calls.map(tc => tc.id));
            let j = i + 1;
            while (j < recentStart && isToolMessage(messages[j])) {
                group.push(j);
                j++;
            }
            groups.push(group);
            i = j;
        } else {
            i++;
        }
    }

    return groups;
}
