/**
 * Shared retry-with-backoff helper for rate-limited LLM calls.
 *
 * Catches 429 / "Rate limit" / "Request limit" errors and retries
 * with exponential backoff (default: 10 s × 2^attempt).
 */
import { getLogger } from './logger';

const log = getLogger('[retry]', 226);

const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 10_000;

function isRateLimitError(err: any): boolean {
    return (
        err?.status === 429
        || err?.message?.includes('429')
        || err?.message?.includes('Rate limit')
        || err?.message?.includes('Request limit')
    );
}

/**
 * Retry an async function with exponential backoff on rate-limit errors.
 *
 * @param fn        The async function to execute
 * @param label     A label for log messages (e.g. "dev-branch-x", "qa-lead")
 * @param attempts  Max number of attempts (default 5)
 * @param initialMs Initial backoff delay in ms (default 10 000)
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
                const delay = initialMs * Math.pow(2, attempt - 1);
                log.warn(
                    `${label}: rate-limited (attempt ${attempt}/${attempts}), retrying in ${delay / 1000}s...`,
                );
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw new Error(`${label}: all ${attempts} retry attempts exhausted`);
}
