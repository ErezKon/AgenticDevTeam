/**
 * Read cache of one agent instance (Plan 24, C6; re-keyed in Plan 30-07).
 *
 * Until Plan 30-07 this was a process-global map keyed by agent id, meant to
 * survive agent instance lifetimes. That was the bug: a fresh instance — a
 * respawn, the next assignment, a repair agent — reading a file for the first
 * time was told "[CACHED — file unchanged since your last read. Do not re-read.]"
 * because an earlier instance had read it; and an agent whose earlier read had
 * since been stubbed out of its history by compaction got the same empty stub, so
 * re-reading could never return the content — the agent looped into BLOCKED.
 *
 * Now each agent instance owns its cache (its loop guard creates it, and it goes
 * away with the agent), so it is scoped to the run and the worktree the instance
 * works in. Each entry remembers which tool call returned the content and in which
 * turn. The compactor reports the tool calls whose results it stubbed or dropped
 * (`forget`), so the cache knows whether the model can still see a read:
 *   - still visible → a one-line pointer replaces a repeat of the identical read;
 *   - stubbed, dropped or changed → the read returns its content.
 */
import { createHash } from 'crypto';

/** An earlier identical read the model can still see in its history. */
export interface VisibleRead {
    /** The agent turn (model call) that returned it. */
    turn: number;
}

/** What a repeated read finds in the cache. */
export type CachedRead =
    | ({ kind: 'visible' } & VisibleRead)
    /** No tool call id was recorded (a direct tool invocation): position unknown, content kept. */
    | { kind: 'cached'; content: string };

export interface ReadCache {
    /** A repeat of `key` with no mutation since: where its result is, or null when none is known. */
    previous(key: string): CachedRead | null;
    /**
     * Record a read that executed. When its content is identical to an earlier
     * result of `key` that is still visible, that read is returned (and kept);
     * otherwise this result is stored and null is returned.
     */
    record(key: string, content: string, toolCallId: string | undefined, turn: number): VisibleRead | null;
    /** The model sees `key`'s latest result only shrunk: a repeat must return the content again. */
    demote(key: string): void;
    /** Results the compactor stubbed or dropped. Returns the keys whose reads are no longer visible. */
    forget(toolCallIds: Iterable<string>): string[];
}

interface Entry {
    hash: string;
    content: string;
    toolCallId?: string;
    turn: number;
}

function hashOf(content: string): string {
    return createHash('sha1').update(content).digest('hex');
}

/** Create the read cache of one agent instance. */
export function createReadCache(): ReadCache {
    const entries = new Map<string, Entry>();
    const keyByCall = new Map<string, string>();

    const store = (key: string, entry: Entry): void => {
        const old = entries.get(key);
        if (old?.toolCallId) keyByCall.delete(old.toolCallId);
        entries.set(key, entry);
        if (entry.toolCallId) keyByCall.set(entry.toolCallId, key);
    };

    return {
        previous(key) {
            const e = entries.get(key);
            if (!e) return null;
            return e.toolCallId ? { kind: 'visible', turn: e.turn } : { kind: 'cached', content: e.content };
        },
        record(key, content, toolCallId, turn) {
            const hash = hashOf(content);
            const e = entries.get(key);
            if (e?.toolCallId && e.hash === hash) return { turn: e.turn };
            store(key, { hash, content, toolCallId, turn });
            return null;
        },
        demote(key) {
            const e = entries.get(key);
            if (e) store(key, { ...e, toolCallId: undefined });
        },
        forget(toolCallIds) {
            const forgotten: string[] = [];
            for (const id of toolCallIds) {
                const key = keyByCall.get(id);
                if (key === undefined) continue;
                keyByCall.delete(id);
                entries.delete(key);
                forgotten.push(key);
            }
            return forgotten;
        },
    };
}
