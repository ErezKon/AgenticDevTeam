/**
 * PR Failure Classifier -- categorises git / GitHub errors so the workflow
 * can take the right recovery action instead of failing opaquely.
 *
 * Every literal match string comes from real error payloads observed in
 * pacman8 and retroboard3 run logs (Sub-Plan 06 SS4).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type PrFailureKind =
    | 'pr-already-exists'
    | 'no-commits'
    | 'merge-conflict'
    | 'rebase-failed'
    | 'push-rejected'
    | 'auth'
    | 'rate-limit'
    | 'network'
    | 'unknown';

export interface PrFailureClassification {
    kind: PrFailureKind;
    message: string;
    retryable: boolean;
}

// ─── Matchers ───────────────────────────────────────────────────────────────

const MATCHERS: Array<{ kind: PrFailureKind; patterns: RegExp[]; retryable: boolean }> = [
    {
        kind: 'pr-already-exists',
        patterns: [/A pull request already exists for/i],
        retryable: false,
    },
    {
        kind: 'no-commits',
        patterns: [/No commits between/i],
        retryable: false,
    },
    {
        kind: 'merge-conflict',
        patterns: [
            /Pull Request has merge conflicts/i,
            /Merge conflict/i,
            /merge conflicts?$/im,
        ],
        retryable: false,
    },
    {
        kind: 'rebase-failed',
        patterns: [
            /CONFLICT \(content\)/i,
            /could not apply/i,
            /needs merge/i,
            /rebase.*failed/i,
        ],
        retryable: false,
    },
    {
        kind: 'push-rejected',
        patterns: [
            /non-fast-forward/i,
            /Updates were rejected/i,
        ],
        retryable: true,
    },
    {
        kind: 'auth',
        patterns: [
            /Bad credentials/i,
            /\b401\b/,
            /\b403\b.*forbidden/i,
        ],
        retryable: false,
    },
    {
        kind: 'rate-limit',
        patterns: [
            /rate limit/i,
            /\b429\b/,
            /secondary rate limit/i,
        ],
        retryable: true,
    },
    {
        kind: 'network',
        patterns: [
            /ECONNRESET/i,
            /ETIMEDOUT/i,
            /Connection error/i,
            /socket hang up/i,
        ],
        retryable: true,
    },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify a PR / git / GitHub error into a known failure kind.
 *
 * Match is attempted against `err.message`, `err.stderr`, and `err.status`.
 * Returns `'unknown'` when no pattern matches.
 */
export function classifyPrFailure(err: unknown): PrFailureClassification {
    const msg = extractMessage(err);

    for (const { kind, patterns, retryable } of MATCHERS) {
        for (const re of patterns) {
            if (re.test(msg)) {
                return { kind, message: msg, retryable };
            }
        }
    }

    // Check numeric status codes separately
    const status = (err as any)?.status;
    if (status === 401 || status === 403) {
        return { kind: 'auth', message: msg, retryable: false };
    }
    if (status === 429) {
        return { kind: 'rate-limit', message: msg, retryable: true };
    }

    return { kind: 'unknown', message: msg, retryable: false };
}

/**
 * Returns true when the classified error should halt the entire run
 * immediately (e.g. bad credentials -- no point burning more tokens).
 */
export function isFatalPrFailure(classification: PrFailureClassification): boolean {
    return classification.kind === 'auth';
}

// ─── Internals ──────────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
    if (!err) return '';
    if (typeof err === 'string') return err;
    const e = err as any;
    const parts: string[] = [];
    if (e.message) parts.push(String(e.message));
    if (e.stderr) parts.push(String(e.stderr));
    if (e.status) parts.push(`status=${e.status}`);
    if (e.errors && Array.isArray(e.errors)) {
        for (const sub of e.errors) {
            if (sub.message) parts.push(sub.message);
        }
    }
    return parts.join(' | ') || String(err);
}
