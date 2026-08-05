/**
 * LLM Throttle — unit tests for the process-wide request scheduler.
 *
 * Tests concurrency enforcement, global cooldown propagation across callers,
 * and stats tracking. Uses real timers with small delays (<=2s) to match
 * the style used in other tests in this project.
 */

// Set env vars BEFORE importing the module (module reads them at load time)
process.env.LLM_MAX_CONCURRENT_REQUESTS = '2';
process.env.LLM_MIN_REQUEST_INTERVAL_MS = '50';
process.env.LLM_MAX_REQUEST_INTERVAL_MS = '500';
process.env.LLM_COOLDOWN_BASE_MS = '500';
process.env.LLM_COOLDOWN_MAX_MS = '2000';

import { throttledFetch, getThrottleStats, _resetThrottleState } from '../src/utils/llm-throttle';

// Mock logger to avoid console noise
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

describe('LLM Throttle', () => {
    beforeEach(() => {
        _resetThrottleState();
    });

    it('enforces max concurrency — no more than LLM_MAX_CONCURRENT_REQUESTS in flight', async () => {
        let maxOverlap = 0;
        let currentOverlap = 0;

        const inner: typeof globalThis.fetch = async (_url, _init?) => {
            currentOverlap++;
            if (currentOverlap > maxOverlap) maxOverlap = currentOverlap;
            // Simulate 50ms request processing
            await new Promise(r => setTimeout(r, 50));
            currentOverlap--;
            return new Response('ok', { status: 200 });
        };

        const throttled = throttledFetch(inner);

        // Fire 5 calls concurrently
        const promises = Array.from({ length: 5 }, (_, i) =>
            throttled(`http://example.com/api/${i}`, {}),
        );

        await Promise.all(promises);

        // Max concurrent should be exactly 2 (LLM_MAX_CONCURRENT_REQUESTS)
        expect(maxOverlap).toBeLessThanOrEqual(2);
        expect(maxOverlap).toBeGreaterThan(0);

        // Stats should track all 5
        const stats = getThrottleStats();
        expect(stats.total).toBe(5);
    }, 15000);

    it('keeps the concurrency cap when callers arrive while others are queued', async () => {
        // Regression: releasing a slot used to decrement the counter *and* wake a
        // waiter, so a caller arriving in between could take the same slot and
        // push in-flight requests above the configured maximum.
        let maxOverlap = 0;
        let currentOverlap = 0;

        const inner: typeof globalThis.fetch = async (_url, _init?) => {
            currentOverlap++;
            if (currentOverlap > maxOverlap) maxOverlap = currentOverlap;
            await new Promise(r => setTimeout(r, 60));
            currentOverlap--;
            return new Response('ok', { status: 200 });
        };

        const throttled = throttledFetch(inner);
        const promises: Promise<unknown>[] = [];

        // Two batches: the second arrives while the first batch is still queued.
        for (let i = 0; i < 4; i++) promises.push(throttled(`http://example.com/a/${i}`, {}));
        await new Promise(r => setTimeout(r, 70));
        for (let i = 0; i < 4; i++) promises.push(throttled(`http://example.com/b/${i}`, {}));

        await Promise.all(promises);

        expect(maxOverlap).toBeLessThanOrEqual(2);
        expect(getThrottleStats().total).toBe(8);
    }, 20000);

    it('global cooldown from a 429 delays a DIFFERENT caller', async () => {
        let callCount = 0;
        const callTimestamps: number[] = [];

        const inner: typeof globalThis.fetch = async (_url, _init?) => {
            callCount++;
            callTimestamps.push(Date.now());
            if (callCount === 1) {
                // First call returns 429 with Retry-After: 1 (second)
                return new Response('', {
                    status: 429,
                    headers: { 'retry-after': '1' },
                });
            }
            return new Response('ok', { status: 200 });
        };

        const throttled = throttledFetch(inner);

        // First call: will get 429, which sets a global cooldown
        const call1Promise = throttled('http://example.com/api/a', {}).catch(() => {});

        // Wait a tiny bit for call1 to complete and set cooldown
        await call1Promise;

        // Second call from a "different caller" — should be delayed by the cooldown
        const beforeCall2 = Date.now();
        await throttled('http://example.com/api/b', {});
        const afterCall2 = Date.now();

        // The second call should have waited for the cooldown (~1s from Retry-After)
        // Allow some tolerance (at least 400ms given jitter of +/-25%)
        const elapsed = afterCall2 - beforeCall2;
        expect(elapsed).toBeGreaterThanOrEqual(350);

        // Stats should show 1 rate-limited event
        const stats = getThrottleStats();
        expect(stats.rateLimited).toBe(1);
    }, 15000);

    it('tracks stats correctly — rateLimited count and total', async () => {
        let callCount = 0;

        const inner: typeof globalThis.fetch = async (_url, _init?) => {
            callCount++;
            if (callCount <= 2) {
                // First two calls return 429
                return new Response('rate limited', { status: 429 });
            }
            return new Response('ok', { status: 200 });
        };

        const throttled = throttledFetch(inner);

        // Call 1: 429 -> throws
        await throttled('http://example.com/1', {}).catch(() => {});

        // Call 2: 429 -> throws (waits for cooldown first)
        await throttled('http://example.com/2', {}).catch(() => {});

        // Call 3: 200 -> success
        const response = await throttled('http://example.com/3', {});
        expect(response.status).toBe(200);

        const stats = getThrottleStats();
        expect(stats.total).toBe(3);
        expect(stats.rateLimited).toBe(2);
        expect(stats.cooldownMsTotal).toBeGreaterThan(0);
    }, 30000);
});
