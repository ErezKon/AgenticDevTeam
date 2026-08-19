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
    | 'pr:opened' | 'pr:reviewed' | 'pr:merged' | 'pr:blocked' | 'pr:conflict' | 'pr:salvage' | 'pr:strong-fixer' | 'pr:config-change-flagged'
    // Plan 22 G3: a branch is pushed long before its PR is opened. Without these
    // a pushed-but-PR-less branch is indistinguishable from a crashed run.
    | 'branch:pushed' | 'branch:pr-pending'
    // Plan 24 D2: branch exceeded its per-branch cost or wall-time cap.
    | 'branch:budget-exceeded'
    // Plan 26, A2: some dev agents on a branch crashed but others completed.
    | 'branch:partial-failure'
    // Plan 26, A4: critical quality gates (typecheck/build) blocked PR creation.
    | 'branch:gates-blocked'
    // Plan 27-B: dispatch halted by DISPATCH_HALT_POLICY when a branch fails.
    | 'dispatch:halted'
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
    | 'run:paused'
    | 'run:budget-stop'
    | 'run:provider-stop'
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
    'run:error', 'run:blocked', 'run:budget-stop', 'run:provider-stop',
    'agent:budget-exhausted',
    'product-verify:result',
    'test-run:result',
    'salvage:written',
    'review:abstained',
]);

// ─── Singleton state ────────────────────────────────────────────────────────

import { getRunContext, type EventBusState } from './run-context';

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // avoid the default 10-listener warning

let _buffer: RunEvent[] = [];
let _bufferSize = EVENT_BUFFER_SIZE;
let _priorityBuffer: RunEvent[] = [];
let _priorityBufferSize = EVENT_PRIORITY_BUFFER_SIZE;

/** Get the active event bus state — per-run scoped or module default. */
function _active(): { emitter: EventEmitter; buffer: RunEvent[]; setBuffer: (b: RunEvent[]) => void; bufferSize: number; priorityBuffer: RunEvent[]; priorityBufferSize: number } {
    const ctx = getRunContext();
    if (ctx) {
        const s = ctx.eventBus as EventBusState;
        return {
            emitter: s.emitter,
            get buffer() { return s.buffer as RunEvent[]; },
            setBuffer(b: RunEvent[]) { s.buffer = b; },
            bufferSize: s.bufferSize,
            get priorityBuffer() { return s.priorityBuffer as RunEvent[]; },
            priorityBufferSize: s.priorityBufferSize,
        };
    }
    return {
        emitter,
        get buffer() { return _buffer; },
        setBuffer(b: RunEvent[]) { _buffer = b; },
        bufferSize: _bufferSize,
        get priorityBuffer() { return _priorityBuffer; },
        priorityBufferSize: _priorityBufferSize,
    };
}

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

    const bus = _active();

    // Ring buffer
    bus.buffer.push(event);
    if (bus.buffer.length > bus.bufferSize) {
        bus.setBuffer(bus.buffer.slice(bus.buffer.length - bus.bufferSize));
    }

    // Priority buffer (never evicts high-severity events)
    if (PRIORITY_TYPES.has(type)) {
        if (bus.priorityBuffer.length < bus.priorityBufferSize) {
            bus.priorityBuffer.push(event);
        }
    }

    // Notify listeners (never throw)
    try {
        bus.emitter.emit('run-event', event);
    } catch (err: any) {
        log.warn(`Event listener error on ${type}: ${err?.message ?? err}`);
    }
}

/**
 * Subscribe to all run events. Returns an unsubscribe function.
 */
export function onRunEvent(cb: (e: RunEvent) => void): () => void {
    const bus = _active();
    const safeListener = (e: RunEvent) => {
        try {
            cb(e);
        } catch (err: any) {
            log.warn(`Event listener threw on ${e.type}: ${err?.message ?? err}`);
        }
    };
    bus.emitter.on('run-event', safeListener);
    return () => { bus.emitter.removeListener('run-event', safeListener); };
}

/** Last N events from the ring buffer, for backfilling a reconnecting dashboard. */
export function getRecentEvents(limit?: number): RunEvent[] {
    const bus = _active();
    const n = limit ?? bus.bufferSize;
    if (n >= bus.buffer.length) return [...bus.buffer];
    return bus.buffer.slice(bus.buffer.length - n);
}

/** All priority events (never evicted). */
export function getPriorityEvents(): RunEvent[] {
    return [..._active().priorityBuffer];
}

/** Combined view: priority events + recent ring events, deduplicated and sorted. */
export function getAllEvents(limit?: number): RunEvent[] {
    const bus = _active();
    const seen = new Set<string>();
    const all: RunEvent[] = [];
    // Priority first
    for (const e of bus.priorityBuffer) {
        const key = `${e.ts}:${e.type}`;
        if (!seen.has(key)) {
            seen.add(key);
            all.push(e);
        }
    }
    // Ring buffer
    for (const e of bus.buffer) {
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
