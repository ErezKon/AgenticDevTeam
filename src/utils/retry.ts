/**
 * Shared retry-with-backoff helper for rate-limited LLM calls.
 *
 * Catches 429 / "Rate limit" / "Request limit" / "Token limit" errors and
 * retries with exponential backoff (configurable via env vars).
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

function isRateLimitError(err: any): boolean {
    return (
        err?.status === 429
        || err?.message?.includes('429')
        || err?.message?.includes('Rate limit')
        || err?.message?.includes('Request limit')
        || err?.message?.includes('Token limit')
    );
}

/**
 * Retry an async function with exponential backoff + jitter on rate-limit errors.
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
            if (isRateLimitError(err) && attempt < attempts) {
                const baseDelay = Math.min(initialMs * Math.pow(2, attempt - 1), MAX_DELAY_MS);
                // Add +/-30% random jitter to stagger concurrent retries
                const jitter = baseDelay * (0.7 + Math.random() * 0.6);
                const delay = Math.round(Math.min(jitter, MAX_DELAY_MS));
                log.warn(
                    `${label}: rate-limited (attempt ${attempt}/${attempts}), retrying in ${(delay / 1000).toFixed(1)}s...`,
                );
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw new Error(`${label}: all ${attempts} retry attempts exhausted`);
}
