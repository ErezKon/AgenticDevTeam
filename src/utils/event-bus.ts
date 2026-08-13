/**
 * Typed singleton event bus — the backbone of run observability (Sub-Plan 12).
 *
 * Uses `node:events` internally. Emitting never throws — listener errors
 * are caught and logged, mirroring the token-tracker.ts pattern.
 *
 * Two buffers:
 * - A ring buffer (EVENT_BUFFER_SIZE, default 5000) for routine events.
 * - A priority buffer (EVENT_PRIORITY_BUFFER_SIZE, default 500, unbounded growth
 *   up to cap) that **never evicts** high-severity events: phase:*, gate:result,
 *   pr:blocked, acceptance:result, integrity:*, plan:coverage, run:error,
 *   agent:budget-exhausted.
 */
import { EventEmitter } from 'node:events';
import { EVENT_BUFFER_SIZE, EVENT_PRIORITY_BUFFER_SIZE } from '../config';
import { getLogger } from './logger';

const log = getLogger('[EventBus]', 214);

// ─── Types ──────────────────────────────────────────────────────────────────

export type RunEventType =
    | 'phase:start' | 'phase:end'
    | 'agent:start' | 'agent:end' | 'agent:respawn' | 'agent:budget-exhausted'
    | 'tool:call'
    | 'pr:opened' | 'pr:reviewed' | 'pr:merged' | 'pr:blocked' | 'pr:conflict' | 'pr:salvage'
    | 'gate:result'
    | 'acceptance:result'
    | 'plan:coverage'
    | 'qa:sufficiency'
    | 'traceability:update'
    | 'e2e:status'
    | 'devops:fallback'
    | 'product-verify:result'
    | 'integrity:finding'
    | 'review:abstained'
    | 'test-run:result'
    | 'salvage:written'
    | 'run:blocked'
    | 'run:error'
    | 'tokens:update'
    | 'budget:level'
    | 'transcript'
    | 'hitl:waiting';

export interface RunEvent {
    type: RunEventType;
    ts: string;
    payload: Record<string, unknown>;
}

// ─── Priority event types ───────────────────────────────────────────────────

/** Event types that are never evicted from the priority buffer. */
const PRIORITY_TYPES = new Set<string>([
    'phase:start', 'phase:end',
    'gate:result', 'pr:blocked',
    'acceptance:result',
    'integrity:finding',
    'plan:coverage',
    'run:error', 'run:blocked',
    'agent:budget-exhausted',
    'product-verify:result',
    'test-run:result',
    'salvage:written',
    'review:abstained',
]);

// ─── Singleton state ────────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // avoid the default 10-listener warning

let _buffer: RunEvent[] = [];
let _bufferSize = EVENT_BUFFER_SIZE;
let _priorityBuffer: RunEvent[] = [];
let _priorityBufferSize = EVENT_PRIORITY_BUFFER_SIZE;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Emit a typed run event. Never throws — listener errors are caught
 * and logged so a crashing dashboard subscriber cannot kill a run.
 */
export function emitRunEvent(type: RunEventType, payload: Record<string, unknown>): void {
    const event: RunEvent = {
        type,
        ts: new Date().toISOString(),
        payload,
    };

    // Ring buffer
    _buffer.push(event);
    if (_buffer.length > _bufferSize) {
        _buffer = _buffer.slice(_buffer.length - _bufferSize);
    }

    // Priority buffer (never evicts high-severity events)
    if (PRIORITY_TYPES.has(type)) {
        if (_priorityBuffer.length < _priorityBufferSize) {
            _priorityBuffer.push(event);
        }
    }

    // Notify listeners (never throw)
    try {
        emitter.emit('run-event', event);
    } catch (err: any) {
        log.warn(`Event listener error on ${type}: ${err?.message ?? err}`);
    }
}

/**
 * Subscribe to all run events. Returns an unsubscribe function.
 */
export function onRunEvent(cb: (e: RunEvent) => void): () => void {
    const safeListener = (e: RunEvent) => {
        try {
            cb(e);
        } catch (err: any) {
            log.warn(`Event listener threw on ${e.type}: ${err?.message ?? err}`);
        }
    };
    emitter.on('run-event', safeListener);
    return () => { emitter.removeListener('run-event', safeListener); };
}

/** Last N events from the ring buffer, for backfilling a reconnecting dashboard. */
export function getRecentEvents(limit?: number): RunEvent[] {
    const n = limit ?? _bufferSize;
    if (n >= _buffer.length) return [..._buffer];
    return _buffer.slice(_buffer.length - n);
}

/** All priority events (never evicted). */
export function getPriorityEvents(): RunEvent[] {
    return [..._priorityBuffer];
}

/** Combined view: priority events + recent ring events, deduplicated and sorted. */
export function getAllEvents(limit?: number): RunEvent[] {
    const seen = new Set<string>();
    const all: RunEvent[] = [];
    // Priority first
    for (const e of _priorityBuffer) {
        const key = `${e.ts}:${e.type}`;
        if (!seen.has(key)) {
            seen.add(key);
            all.push(e);
        }
    }
    // Ring buffer
    for (const e of _buffer) {
        const key = `${e.ts}:${e.type}`;
        if (!seen.has(key)) {
            seen.add(key);
            all.push(e);
        }
    }
    all.sort((a, b) => a.ts.localeCompare(b.ts));
    if (limit && all.length > limit) return all.slice(all.length - limit);
    return all;
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset the event bus — tests only. */
export function _resetEventBus(): void {
    _buffer = [];
    _priorityBuffer = [];
    emitter.removeAllListeners('run-event');
}
