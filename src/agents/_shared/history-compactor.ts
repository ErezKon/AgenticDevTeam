/**
 * ReAct history compaction — `preModelHook` transformer.
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
 * Replace any string arg value longer than ELIDE_ARG_THRESHOLD with
 * a `[N chars elided]` stub. Preserves short args (e.g. filePath) verbatim.
 */
function elideBigArgs(args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.length > ELIDE_ARG_THRESHOLD) {
            result[key] = `[${value.length} chars elided]`;
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Build a one-line stub for a ToolMessage, preserving the tool name
 * and the original content size so the model knows what was there.
 */
function stubToolContent(m: ToolMessage): string {
    const contentLen = typeof m.content === 'string'
        ? m.content.length
        : JSON.stringify(m.content).length;
    const name = m.name ?? 'unknown_tool';
    return `[${name} -> ${contentLen} chars, elided]`;
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
    opts?: { keepRecent?: number; maxChars?: number },
): { messages: BaseMessage[]; stats: CompactionStats } {
    const keepRecent = opts?.keepRecent ?? HISTORY_KEEP_RECENT_TOOL_RESULTS;
    const maxChars = opts?.maxChars ?? HISTORY_MAX_CHARS;

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
    // Walk backwards counting ToolMessages until we've found `keepRecent`.
    // Everything at index >= recentBoundary is kept verbatim.
    let recentBoundary = messages.length; // default: everything is eligible for stubbing
    if (keepRecent > 0) {
        let toolResultsSeen = 0;
        let foundBoundary = false;
        for (let i = messages.length - 1; i >= 1; i--) { // skip index 0 (task msg)
            if (isToolMessage(messages[i])) {
                toolResultsSeen++;
                if (toolResultsSeen >= keepRecent) {
                    // Find the start of the group that contains this tool message.
                    // Walk back to find the AIMessage that triggered it.
                    recentBoundary = i;
                    // Walk further back: the AIMessage with tool_calls that produced
                    // this ToolMessage group should also be in the recent window.
                    for (let j = i - 1; j >= 1; j--) {
                        const candidate = messages[j];
                        if (isAIMessage(candidate) && candidate.tool_calls?.length) {
                            recentBoundary = j;
                            break;
                        }
                    }
                    foundBoundary = true;
                    break;
                }
            }
        }
        // If total tool results < keepRecent, all messages are "recent"
        if (!foundBoundary) {
            recentBoundary = 1; // nothing is eligible for stubbing
        }
    }

    // ── Build the compacted message array ────────────────────────────────
    const compacted: BaseMessage[] = [];

    // Rule 1: first message is always kept verbatim
    compacted.push(messages[0]);

    // Process middle section (index 1..recentBoundary-1): eligible for stubbing
    for (let i = 1; i < recentBoundary; i++) {
        const m = messages[i];

        // Rule 2: Stub older ToolMessages
        if (isToolMessage(m)) {
            const stub = stubToolContent(m as ToolMessage);
            compacted.push(new ToolMessage({
                content: stub,
                tool_call_id: (m as ToolMessage).tool_call_id,
                name: (m as ToolMessage).name,
            }));
            toolResultsStubbed++;
            continue;
        }

        // Rule 3: Elide big args in older AIMessage tool calls
        if (isAIMessage(m) && m.tool_calls?.length) {
            let anyElided = false;
            const elidedToolCalls = m.tool_calls.map(tc => {
                const elidedArgs = elideBigArgs(tc.args as Record<string, unknown>);
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
