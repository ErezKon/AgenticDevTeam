/**
 * Process-wide LLM request throttle.
 *
 * All agent LLM traffic funnels through `throttledFetch`, giving us a single
 * point to enforce concurrency, request spacing, and a GLOBAL cooldown when
 * the gateway returns 429. Without this, N parallel agents each retry
 * independently and sustain the rate-limit storm (runs 5 & 6: 1,171 retries).
 */
import { getLogger } from './logger';

const log = getLogger('[llm-throttle]', 214);

// ─── Configuration (env-driven with sane defaults) ──────────────────────────

/** Max concurrent LLM requests in flight process-wide. */
const LLM_MAX_CONCURRENT_REQUESTS =
    parseInt(process.env.LLM_MAX_CONCURRENT_REQUESTS ?? '2', 10);

/** Minimum spacing between request starts (ms). */
const LLM_MIN_REQUEST_INTERVAL_MS =
    parseInt(process.env.LLM_MIN_REQUEST_INTERVAL_MS ?? '400', 10);

/** Maximum adaptive interval ceiling (ms). */
const LLM_MAX_REQUEST_INTERVAL_MS =
    parseInt(process.env.LLM_MAX_REQUEST_INTERVAL_MS ?? '5000', 10);

/** Base cooldown duration on 429 (ms). Doubles per consecutive 429. */
const LLM_COOLDOWN_BASE_MS =
    parseInt(process.env.LLM_COOLDOWN_BASE_MS ?? '5000', 10);

/** Maximum cooldown duration (ms). */
const LLM_COOLDOWN_MAX_MS =
    parseInt(process.env.LLM_COOLDOWN_MAX_MS ?? '90000', 10);

// ─── Module-level singleton state ───────────────────────────────────────────

/** Semaphore: how many requests are currently in flight. */
let inFlight = 0;

/** Monotonic timestamp for next available request slot. */
let nextSlotAt = 0;

/** Global cooldown gate: no requests before this timestamp. */
let cooldownUntil = 0;

/** Consecutive 429 responses (resets on success). */
let consecutive429 = 0;

/** Consecutive successes since last 429 (for adaptive decay). */
let consecutiveSuccesses = 0;

/** Current adaptive interval (starts at the configured minimum). */
let currentIntervalMs = LLM_MIN_REQUEST_INTERVAL_MS;

/** FIFO queue of waiting requests. */
const queue: Array<{ resolve: () => void }> = [];

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface ThrottleStats {
    total: number;
    throttledWaits: number;
    rateLimited: number;
    cooldownMsTotal: number;
}

let stats: ThrottleStats = {
    total: 0,
    throttledWaits: 0,
    rateLimited: 0,
    cooldownMsTotal: 0,
};

export function getThrottleStats(): ThrottleStats {
    return { ...stats };
}

export function logThrottleStats(): void {
    log.info(
        `Requests: ${stats.total}, rate-limited: ${stats.rateLimited}, ` +
        `throttled waits: ${stats.throttledWaits}, total cooldown: ${(stats.cooldownMsTotal / 1000).toFixed(0)}s`,
    );
}

/**
 * Reset internal state (for testing only).
 * @internal
 */
export function _resetThrottleState(): void {
    inFlight = 0;
    nextSlotAt = 0;
    cooldownUntil = 0;
    consecutive429 = 0;
    consecutiveSuccesses = 0;
    currentIntervalMs = LLM_MIN_REQUEST_INTERVAL_MS;
    queue.length = 0;
    stats = { total: 0, throttledWaits: 0, rateLimited: 0, cooldownMsTotal: 0 };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function is429Error(response: Response | null, error: any): boolean {
    if (response?.status === 429) return true;
    if (error?.status === 429) return true;
    const msg = error?.message ?? '';
    return (
        msg.includes('429')
        || msg.includes('Request limit')
        || msg.includes('Token limit')
        || msg.includes('Rate limit')
    );
}

/** Wait until `Date.now() >= target`, resolving via a single setTimeout. */
function sleepUntil(target: number): Promise<void> {
    const delta = target - Date.now();
    if (delta <= 0) return Promise.resolve();
    return new Promise(r => setTimeout(r, delta));
}

/** Acquire a semaphore slot (FIFO). */
async function acquireSlot(): Promise<void> {
    // Queue behind existing waiters even if a slot looks free, otherwise a
    // late arrival can steal the slot a waiter was just handed (starvation)
    // and push `inFlight` above the configured maximum.
    if (queue.length === 0 && inFlight < LLM_MAX_CONCURRENT_REQUESTS) {
        inFlight++;
        return;
    }
    // Wait in FIFO queue for a slot to open. The releasing request hands its
    // slot over without decrementing `inFlight`, so the count stays accurate.
    stats.throttledWaits++;
    await new Promise<void>(resolve => {
        queue.push({ resolve });
    });
}

/** Release a semaphore slot and wake the next queued request. */
function releaseSlot(): void {
    const next = queue.shift();
    if (next) {
        // Direct hand-off: the slot stays taken, so no other caller can grab it.
        next.resolve();
        return;
    }
    inFlight--;
}

/** Apply spacing: advance `nextSlotAt` and wait until that time. */
async function waitForSpacing(): Promise<void> {
    const now = Date.now();
    if (nextSlotAt <= now) {
        nextSlotAt = now + currentIntervalMs;
        return;
    }
    // Must wait for the existing slot time
    stats.throttledWaits++;
    const waitTarget = nextSlotAt;
    nextSlotAt = waitTarget + currentIntervalMs;
    await sleepUntil(waitTarget);
}

/** Wait for the global cooldown gate. */
async function waitForCooldown(): Promise<void> {
    if (cooldownUntil <= Date.now()) return;
    stats.throttledWaits++;
    await sleepUntil(cooldownUntil);
}

/** Handle a 429 response: escalate cooldown and adapt interval. */
function handleRateLimit(retryAfterHeader?: string | null): void {
    consecutive429++;
    consecutiveSuccesses = 0;
    stats.rateLimited++;

    // Adaptive interval increase
    currentIntervalMs = Math.min(currentIntervalMs * 1.5, LLM_MAX_REQUEST_INTERVAL_MS);

    // Compute cooldown duration
    let delay: number;
    if (retryAfterHeader) {
        const parsed = parseFloat(retryAfterHeader);
        if (!isNaN(parsed)) {
            delay = parsed * 1000; // header is in seconds
        } else {
            delay = LLM_COOLDOWN_BASE_MS * Math.pow(2, consecutive429 - 1);
        }
    } else {
        delay = LLM_COOLDOWN_BASE_MS * Math.pow(2, consecutive429 - 1);
    }
    delay = Math.min(delay, LLM_COOLDOWN_MAX_MS);

    // Apply +/-25% jitter
    const jitter = 0.75 + Math.random() * 0.5;
    delay = Math.round(delay * jitter);

    cooldownUntil = Date.now() + delay;
    stats.cooldownMsTotal += delay;

    log.warn(
        `Global LLM cooldown ${delay}ms (consecutive 429s: ${consecutive429}, ` +
        `in-flight: ${inFlight}, queued: ${queue.length})`,
    );
}

/** Handle a successful response: reset counters and decay interval. */
function handleSuccess(): void {
    consecutive429 = 0;
    consecutiveSuccesses++;

    // After 20 consecutive successes, decay the adaptive interval
    if (consecutiveSuccesses >= 20 && currentIntervalMs > LLM_MIN_REQUEST_INTERVAL_MS) {
        currentIntervalMs = Math.max(currentIntervalMs / 1.2, LLM_MIN_REQUEST_INTERVAL_MS);
        consecutiveSuccesses = 0; // reset counter so decay happens in bursts of 20
    }
}

// ─── Provider Pause Gate (Plan 24, A3) ──────────────────────────────────────

/** Max time to wait for a provider outage to clear (ms). */
const PROVIDER_PAUSE_MAX_MS =
    parseInt(process.env.PROVIDER_PAUSE_MAX_MS ?? '900000', 10);

/** Whether the process-wide provider pause gate is active. */
let providerPaused = false;

/** Resolve all waiting callers when the gate clears. */
let pauseGateResolvers: Array<() => void> = [];

/** Total ms spent in provider pause state. */
let totalPausedMs = 0;

/** Get total ms the system spent paused due to provider outages. */
export function getProviderPausedMs(): number {
    return totalPausedMs;
}

/**
 * Pause all LLM traffic due to a provider-level failure (billing, quota, etc.).
 * Probes with exponential backoff up to PROVIDER_PAUSE_MAX_MS.
 * Returns true if the provider recovered, false if it did not.
 */
export async function awaitProviderRecovery(
    probeFn?: () => Promise<boolean>,
): Promise<boolean> {
    if (providerPaused) {
        // Already paused — wait on the existing gate
        return new Promise<boolean>(resolve => {
            pauseGateResolvers.push(() => resolve(!providerPaused));
        });
    }

    providerPaused = true;
    const pauseStart = Date.now();
    log.warn(`Provider unavailable — pausing all LLM traffic (max ${PROVIDER_PAUSE_MAX_MS / 1000}s)`);

    let backoff = 10_000; // 10s initial
    const maxBackoff = 120_000; // 2 min max per probe

    while (Date.now() - pauseStart < PROVIDER_PAUSE_MAX_MS) {
        await new Promise(r => setTimeout(r, backoff));

        // Probe: if a probe function is provided, use it; otherwise just clear
        if (probeFn) {
            try {
                const recovered = await probeFn();
                if (recovered) {
                    const elapsed = Date.now() - pauseStart;
                    totalPausedMs += elapsed;
                    providerPaused = false;
                    log.info(`Provider recovered after ${(elapsed / 1000).toFixed(0)}s pause`);
                    // Wake all waiters
                    for (const resolve of pauseGateResolvers) resolve();
                    pauseGateResolvers = [];
                    return true;
                }
            } catch {
                // probe failed — continue waiting
            }
        } else {
            // No probe function — just wait the full duration and give up
            break;
        }

        backoff = Math.min(backoff * 2, maxBackoff);
    }

    const elapsed = Date.now() - pauseStart;
    totalPausedMs += elapsed;
    log.error(`Provider did not recover after ${(elapsed / 1000).toFixed(0)}s — giving up`);
    // Wake all waiters with failure
    for (const resolve of pauseGateResolvers) resolve();
    pauseGateResolvers = [];
    // Keep providerPaused=true so new calls immediately fail
    return false;
}

/** Check if the provider pause gate is active. */
export function isProviderPaused(): boolean {
    return providerPaused;
}

/**
 * Plan 25: Create a lightweight probe function that tests whether the
 * provider is accessible again. Uses a minimal model list request
 * (no tokens billed) via the same base URL the agents use.
 *
 * Falls back to a simple HTTP GET against the OpenAI-compatible `/models`
 * endpoint. If the request succeeds with a non-4xx status, the provider
 * is assumed to be back.
 */
export function createProviderProbe(baseUrl?: string): () => Promise<boolean> {
    // Use the OpenAI base URL from env, falling back to the standard URL
    const url = baseUrl
        ?? process.env.OPENAI_BASE_URL
        ?? process.env.OPENAI_API_BASE
        ?? 'https://api.openai.com/v1';
    const modelsUrl = `${url.replace(/\/+$/, '')}/models`;
    const apiKey = process.env.OPENAI_API_KEY
        ?? process.env.ANTHROPIC_API_KEY
        ?? '';

    return async (): Promise<boolean> => {
        try {
            const resp = await fetch(modelsUrl, {
                method: 'GET',
                headers: apiKey
                    ? { 'Authorization': `Bearer ${apiKey}` }
                    : {},
                signal: AbortSignal.timeout(10_000),
            });
            // 2xx or 3xx = provider is reachable
            // 401/403 = auth error (not billing) — provider is reachable
            // 402 = still billing issue
            if (resp.status === 402) return false;
            if (resp.status >= 200 && resp.status < 500) return true;
            return false;
        } catch {
            return false;
        }
    };
}

/** Clear the provider pause state (for recovery or testing). */
export function clearProviderPause(): void {
    providerPaused = false;
    for (const resolve of pauseGateResolvers) resolve();
    pauseGateResolvers = [];
}

// ─── Exported throttle wrapper ──────────────────────────────────────────────

/**
 * Wrap an inner fetch function with process-wide LLM throttling.
 *
 * The returned fetch enforces:
 * - Max concurrency (semaphore)
 * - Minimum spacing between request starts
 * - Global cooldown on 429 responses (affects ALL callers)
 * - Adaptive interval increase on 429, decay on success
 */
export function throttledFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
    const wrapped: typeof globalThis.fetch = async (input, init?) => {
        stats.total++;

        // 1. Wait for global cooldown
        await waitForCooldown();

        // 2. Acquire semaphore slot (FIFO)
        await acquireSlot();

        try {
            // 3. Enforce request spacing
            await waitForSpacing();

            // 4. Re-check cooldown (may have been set while we waited)
            await waitForCooldown();

            // 5. Execute the actual request
            let response: Response;
            try {
                response = await inner(input, init);
            } catch (fetchErr: any) {
                // Inner fetch threw (network error, etc.) — check for 429 pattern
                if (is429Error(null, fetchErr) && !fetchErr._throttleHandled) {
                    fetchErr._throttleHandled = true;
                    handleRateLimit(null);
                }
                throw fetchErr;
            }

            // 6. Check for 429
            if (response.status === 429) {
                const retryAfter = response.headers?.get('retry-after') ?? null;
                handleRateLimit(retryAfter);
                // Rethrow as an error so the caller (retryWithBackoff) can handle it
                const body = await response.text().catch(() => '');
                const err = new Error(`429 Rate limit exceeded: ${body}`);
                (err as any).status = 429;
                (err as any)._throttleHandled = true;
                throw err;
            }

            // 7. Success
            handleSuccess();
            return response;
        } finally {
            releaseSlot();
        }
    };

    return wrapped as typeof globalThis.fetch;
}
