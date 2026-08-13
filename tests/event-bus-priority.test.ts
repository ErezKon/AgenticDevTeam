/**
 * Tests for the priority buffer in event-bus.ts — Sub-Plan 12.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    EVENT_BUFFER_SIZE: 10,
    EVENT_PRIORITY_BUFFER_SIZE: 5,
}));

import { emitRunEvent, getRecentEvents, getPriorityEvents, getAllEvents, _resetEventBus } from '../src/utils/event-bus';

beforeEach(() => _resetEventBus());

describe('priority buffer', () => {
    it('retains priority events that ring buffer evicts', () => {
        // Emit 5 priority events
        for (let i = 0; i < 5; i++) {
            emitRunEvent('phase:start', { phase: `phase-${i}` });
        }
        // Emit 15 routine events to overflow the ring buffer (size 10)
        for (let i = 0; i < 15; i++) {
            emitRunEvent('tool:call', { i });
        }
        // Ring buffer should have evicted early events
        const recent = getRecentEvents();
        expect(recent.length).toBeLessThanOrEqual(10);

        // Priority buffer should still have all 5 phase events
        const priority = getPriorityEvents();
        expect(priority.length).toBe(5);
        expect(priority.every(e => e.type === 'phase:start')).toBe(true);
    });

    it('caps the priority buffer at EVENT_PRIORITY_BUFFER_SIZE', () => {
        // Emit 10 priority events — but cap is 5
        for (let i = 0; i < 10; i++) {
            emitRunEvent('acceptance:result', { i });
        }
        const priority = getPriorityEvents();
        expect(priority.length).toBe(5);
    });
});

describe('getAllEvents', () => {
    it('deduplicates and combines both buffers', () => {
        emitRunEvent('phase:start', { phase: 'intake' });
        emitRunEvent('tool:call', { name: 'read_file' });
        emitRunEvent('gate:result', { passed: true });

        const all = getAllEvents();
        // Should have exactly 3 unique events
        expect(all.length).toBe(3);
        // Should be sorted by timestamp
        for (let i = 1; i < all.length; i++) {
            expect(all[i].ts >= all[i - 1].ts).toBe(true);
        }
    });

    it('respects limit parameter', () => {
        // Use distinct priority event types so dedup does not collapse them
        emitRunEvent('phase:start', { phase: 'intake' });
        emitRunEvent('gate:result', { passed: true });
        emitRunEvent('acceptance:result', { status: 'accepted' });
        emitRunEvent('phase:end', { phase: 'intake' });
        const all = getAllEvents();
        expect(all.length).toBeGreaterThanOrEqual(4);
        const limited = getAllEvents(2);
        expect(limited.length).toBe(2);
    });
});

describe('new event types', () => {
    it('emits agent:budget-exhausted as priority', () => {
        emitRunEvent('agent:budget-exhausted', { agentId: 'sr-fe' });
        const priority = getPriorityEvents();
        expect(priority.length).toBe(1);
        expect(priority[0].type).toBe('agent:budget-exhausted');
    });

    it('emits product-verify:result as priority', () => {
        emitRunEvent('product-verify:result', { passed: false });
        expect(getPriorityEvents().length).toBe(1);
    });

    it('emits run:blocked as priority', () => {
        emitRunEvent('run:blocked', { reason: 'unrecoverable' });
        expect(getPriorityEvents().length).toBe(1);
    });
});
