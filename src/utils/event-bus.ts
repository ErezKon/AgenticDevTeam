/**
 * Typed singleton event bus — the backbone of run observability (Sub-Plan 8).
 *
 * Uses `node:events` internally. Emitting never throws — listener errors
 * are caught and logged, mirroring the token-tracker.ts pattern.
 *
 * A ring buffer keeps the last EVENT_BUFFER_SIZE events so a reconnecting
 * dashboard (or a GET /api/run/:id/events) can backfill.
 */
import { EventEmitter } from 'node:events';
import { EVENT_BUFFER_SIZE } from '../config';
import { getLogger } from './logger';

const log = getLogger('[EventBus]', 214);

// ─── Types ──────────────────────────────────────────────────────────────────

export type RunEventType =
    | 'phase:start' | 'phase:end'
    | 'agent:start' | 'agent:end' | 'agent:respawn'
    | 'tool:call'
    | 'pr:opened' | 'pr:reviewed' | 'pr:merged'
    | 'gate:result'
    | 'tokens:update'
    | 'budget:level'
    | 'transcript';

export interface RunEvent {
    type: RunEventType;
    ts: string;
    payload: Record<string, unknown>;
}

// ─── Singleton state ────────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // avoid the default 10-listener warning

let _buffer: RunEvent[] = [];
let _bufferSize = EVENT_BUFFER_SIZE;

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

/** Last N events, for backfilling a reconnecting dashboard. */
export function getRecentEvents(limit?: number): RunEvent[] {
    const n = limit ?? _bufferSize;
    if (n >= _buffer.length) return [..._buffer];
    return _buffer.slice(_buffer.length - n);
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset the event bus — tests only. */
export function _resetEventBus(): void {
    _buffer = [];
    emitter.removeAllListeners('run-event');
}
