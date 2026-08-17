/**
 * Provider failure classification (Plan 24, A3).
 *
 * Separates billing/auth/quota errors (pauseable, fatal to all branches)
 * from transient/unknown errors (retryable per-branch failures).
 */

import { getLogger } from '../utils/logger';

const log = getLogger('[Provider-Failure]', 202);

export type ProviderFailureKind =
    | 'billing'
    | 'auth'
    | 'quota'
    | 'model-not-found'
    | 'transient'
    | 'unknown';

export interface ProviderFailureClassification {
    kind: ProviderFailureKind;
    /** If true, the run should pause and probe for recovery. */
    pauseable: boolean;
    /** If true, the run should halt immediately (no recovery possible). */
    fatal: boolean;
    message: string;
}

// ── Patterns ─────────────────────────────────────────────────────────────────

const BILLING_PATTERNS = [
    /credit balance/i,
    /insufficient (funds|quota|credits?)/i,
    /billing/i,
    /payment required/i,
    /exceeded.*quota/i,
    /spending limit/i,
];

const AUTH_PATTERNS = [
    /authentication[_ ]error/i,
    /invalid[_ ]api[_ ]key/i,
    /unauthorized/i,
    /forbidden/i,
    /permission[_ ](denied|error)/i,
    /access[_ ]denied/i,
];

const QUOTA_PATTERNS = [
    /rate[_ ]limit/i,
    /too[_ ]many[_ ]requests/i,
    /quota[_ ]exceeded/i,
    /token[_ ]limit/i,
    /request[_ ]limit/i,
];

const MODEL_NOT_FOUND_PATTERNS = [
    /model[_ ]not[_ ]found/i,
    /does[_ ]not[_ ]exist/i,
    /unknown[_ ]model/i,
    /invalid[_ ]model/i,
];

const TRANSIENT_PATTERNS = [
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /EPIPE/i,
    /socket hang up/i,
    /connection error/i,
    /terminated/i,
    /premature close/i,
    /network error/i,
    /fetch failed/i,
    /internal server error/i,
    /service unavailable/i,
    /bad gateway/i,
    /gateway timeout/i,
];

// ── Classifier ───────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(text));
}

/**
 * Classify a provider error into a structured failure with recovery hints.
 */
export function classifyProviderFailure(err: unknown): ProviderFailureClassification {
    const errObj = err as any;
    const status: number = errObj?.status ?? errObj?.statusCode ?? errObj?.response?.status ?? 0;
    const message: string = errObj?.message ?? String(err);
    const errorType: string = errObj?.error?.type ?? errObj?.type ?? '';
    const combined = `${message} ${errorType}`;

    // 1. Billing — pauseable (might recover if the user tops up or rate resets)
    if (matchesAny(combined, BILLING_PATTERNS) || status === 402) {
        return { kind: 'billing', pauseable: true, fatal: false, message };
    }

    // 2. Auth — fatal (no recovery without human intervention)
    if (matchesAny(combined, AUTH_PATTERNS) || status === 401 || status === 403) {
        return { kind: 'auth', pauseable: false, fatal: true, message };
    }

    // 3. Model not found — fatal
    if (matchesAny(combined, MODEL_NOT_FOUND_PATTERNS) || status === 404) {
        return { kind: 'model-not-found', pauseable: false, fatal: true, message };
    }

    // 4. Quota / rate limit — pauseable
    if (matchesAny(combined, QUOTA_PATTERNS) || status === 429) {
        return { kind: 'quota', pauseable: true, fatal: false, message };
    }

    // 5. Transient — retryable per-branch
    if (status >= 500 || matchesAny(combined, TRANSIENT_PATTERNS)) {
        return { kind: 'transient', pauseable: false, fatal: false, message };
    }

    // 6. Non-429 4xx — classify as billing if the specific Anthropic error shape
    //    matches (invalid_request_error with credit balance text)
    if (status >= 400 && status < 500) {
        if (matchesAny(combined, BILLING_PATTERNS)) {
            return { kind: 'billing', pauseable: true, fatal: false, message };
        }
        // Other 4xx — unknown, don't pause but also don't retry
        return { kind: 'unknown', pauseable: false, fatal: false, message };
    }

    return { kind: 'unknown', pauseable: false, fatal: false, message };
}

/**
 * Returns true if the error is a provider-level failure that should NOT
 * consume the branch's attempt. The branch's assignments should remain
 * pending and its worktree/local branch cleaned up (not salvaged).
 */
export function isProviderLevelFailure(classification: ProviderFailureClassification): boolean {
    return classification.kind === 'billing'
        || classification.kind === 'auth'
        || classification.kind === 'quota';
}
