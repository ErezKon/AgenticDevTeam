/**
 * Event bus — unit tests.
 *
 * All tests are pure: no LLM, no git, no network.
 */

// Mock config before importing event-bus
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    EVENT_BUFFER_SIZE: 5,
}));

import {
    emitRunEvent,
    onRunEvent,
    getRecentEvents,
    _resetEventBus,
    type RunEvent,
} from '../src/utils/event-bus';

beforeEach(() => {
    _resetEventBus();
});

// ─── emitRunEvent + onRunEvent ──────────────────────────────────────────────

describe('emitRunEvent + onRunEvent', () => {
    it('delivers events to subscribers', () => {
        const received: RunEvent[] = [];
        onRunEvent((e) => received.push(e));

        emitRunEvent('phase:start', { phase: 'intake' });

        expect(received).toHaveLength(1);
        expect(received[0].type).toBe('phase:start');
        expect(received[0].payload).toEqual({ phase: 'intake' });
        expect(received[0].ts).toBeTruthy();
    });

    it('supports multiple subscribers', () => {
        let countA = 0;
        let countB = 0;
        onRunEvent(() => countA++);
        onRunEvent(() => countB++);

        emitRunEvent('agent:start', { agentId: 'architect' });

        expect(countA).toBe(1);
        expect(countB).toBe(1);
    });

    it('unsubscribe function works', () => {
        let count = 0;
        const unsub = onRunEvent(() => count++);

        emitRunEvent('agent:start', { agentId: 'a' });
        expect(count).toBe(1);

        unsub();
        emitRunEvent('agent:end', { agentId: 'a' });
        expect(count).toBe(1); // should not have increased
    });

    it('does not throw when a listener throws', () => {
        onRunEvent(() => { throw new Error('listener boom'); });
        // Should not throw
        expect(() => emitRunEvent('phase:end', { phase: 'intake' })).not.toThrow();
    });
});

// ─── Ring buffer ────────────────────────────────────────────────────────────

describe('ring buffer', () => {
    it('stores events up to EVENT_BUFFER_SIZE', () => {
        for (let i = 0; i < 5; i++) {
            emitRunEvent('transcript', { i });
        }
        expect(getRecentEvents()).toHaveLength(5);
    });

    it('evicts oldest events when buffer is full', () => {
        for (let i = 0; i < 8; i++) {
            emitRunEvent('transcript', { i });
        }
        const events = getRecentEvents();
        expect(events).toHaveLength(5); // buffer size is 5
        expect(events[0].payload.i).toBe(3); // oldest surviving
        expect(events[4].payload.i).toBe(7); // newest
    });

    it('getRecentEvents respects optional limit', () => {
        for (let i = 0; i < 5; i++) {
            emitRunEvent('transcript', { i });
        }
        const last2 = getRecentEvents(2);
        expect(last2).toHaveLength(2);
        expect(last2[0].payload.i).toBe(3);
        expect(last2[1].payload.i).toBe(4);
    });

    it('getRecentEvents returns a copy (not a reference)', () => {
        emitRunEvent('phase:start', { phase: 'qa' });
        const a = getRecentEvents();
        const b = getRecentEvents();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});

// ─── _resetEventBus ─────────────────────────────────────────────────────────

describe('_resetEventBus', () => {
    it('clears the buffer and removes listeners', () => {
        let count = 0;
        onRunEvent(() => count++);
        emitRunEvent('phase:start', { phase: 'intake' });
        expect(count).toBe(1);

        _resetEventBus();

        emitRunEvent('phase:end', { phase: 'intake' });
        expect(count).toBe(1); // listener was removed
        expect(getRecentEvents()).toHaveLength(1); // only the post-reset event
    });
});

// ─── Event types ────────────────────────────────────────────────────────────

describe('event types', () => {
    it('accepts all documented event types', () => {
        const types = [
            'phase:start', 'phase:end',
            'agent:start', 'agent:end',
            'tool:call',
            'pr:opened', 'pr:reviewed', 'pr:merged',
            'gate:result',
            'tokens:update',
            'budget:level',
            'transcript',
        ] as const;

        for (const type of types) {
            expect(() => emitRunEvent(type, {})).not.toThrow();
        }

        expect(getRecentEvents()).toHaveLength(5); // only last 5 (buffer size)
    });
});
