/**
 * Shared retry-with-backoff helper for rate-limited and transient LLM calls.
 *
 * Sub-Plan 08 §6: extended to handle transient network/stream failures
 * (ECONNRESET, socket hang up, Connection error, HTTP 5xx) in addition
 * to 429 rate-limit errors.  Only 4xx (other than 429) are non-retryable.
 */
import { getLogger } from './logger';

const log = getLogger('[retry]', 226);

/** Default max attempts — env-configurable via LLM_RETRY_ATTEMPTS. */
const DEFAULT_RETRY_ATTEMPTS =
    parseInt(process.env.LLM_RETRY_ATTEMPTS ?? '8', 10);

/** Default initial backoff (ms) — env-configurable via LLM_RETRY_INITIAL_MS. */
const DEFAULT_INITIAL_BACKOFF_MS =
    parseInt(process.env.LLM_RETRY_INITIAL_MS ?? '8000', 10);

/** Maximum computed delay cap (ms) — prevents 8s x 2^7 from exploding. */
const MAX_DELAY_MS =
    parseInt(process.env.LLM_RETRY_MAX_MS ?? '120000', 10);

/** Transient error patterns that warrant a retry (network/stream failures). */
const TRANSIENT_PATTERNS = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
    'socket hang up', 'Connection error', 'terminated', 'premature close',
    'network error', 'fetch failed',
];

export function isRateLimitError(err: any): boolean {
    return (
        err?.status === 429
        || err?.message?.includes('429')
        || err?.message?.includes('Rate limit')
        || err?.message?.includes('Request limit')
        || err?.message?.includes('Token limit')
    );
}

/**
 * Check whether an error is a transient network/stream failure
 * that should be retried.
 */
export function isTransientError(err: any): boolean {
    const status = err?.status ?? err?.statusCode;
    // HTTP 5xx are server errors — always retryable
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
    // Non-429 4xx are client errors — never retryable
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) return false;

    const msg = String(err?.message ?? err ?? '');
    return TRANSIENT_PATTERNS.some(pattern => msg.includes(pattern));
}

/**
 * Returns true if the error is retryable (rate-limit OR transient).
 */
export function isRetryableError(err: any): boolean {
    return isRateLimitError(err) || isTransientError(err);
}

/**
 * Retry an async function with exponential backoff + jitter on retryable errors.
 *
 * Jitter prevents the "thundering herd" problem where multiple agents
 * hit rate limits simultaneously and retry at identical intervals,
 * causing cascading collisions.
 *
 * @param fn        The async function to execute
 * @param label     A label for log messages (e.g. "dev-branch-x", "qa-lead")
 * @param attempts  Max number of attempts (default from LLM_RETRY_ATTEMPTS env, fallback 8)
 * @param initialMs Initial backoff delay in ms (default from LLM_RETRY_INITIAL_MS env, fallback 8000)
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    label: string,
    attempts: number = DEFAULT_RETRY_ATTEMPTS,
    initialMs: number = DEFAULT_INITIAL_BACKOFF_MS,
): Promise<T> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (isRetryableError(err) && attempt < attempts) {
                const isTransient = !isRateLimitError(err) && isTransientError(err);
                const baseDelay = Math.min(initialMs * Math.pow(2, attempt - 1), MAX_DELAY_MS);
                // Add +/-30% random jitter to stagger concurrent retries
                const jitter = baseDelay * (0.7 + Math.random() * 0.6);
                const delay = Math.round(Math.min(jitter, MAX_DELAY_MS));
                log.warn(
                    `${label}: ${isTransient ? 'transient error' : 'rate-limited'} (attempt ${attempt}/${attempts}), ` +
                    `retrying in ${(delay / 1000).toFixed(1)}s... [${err?.message?.slice(0, 100) ?? 'unknown'}]`,
                );
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw new Error(`${label}: all ${attempts} retry attempts exhausted`);
}
