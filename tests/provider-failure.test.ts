import {
    classifyProviderFailure,
    isProviderLevelFailure,
    ProviderRecoveryFailedError,
    type ProviderFailureClassification,
} from '../src/conductor/provider-failure';

// ---- classifyProviderFailure ------------------------------------------------

describe('classifyProviderFailure', () => {
    // -- billing --------------------------------------------------------------

    describe('billing', () => {
        it('classifies status 402 as billing', () => {
            const result = classifyProviderFailure({ status: 402, message: 'Payment Required' });
            expect(result.kind).toBe('billing');
            expect(result.pauseable).toBe(true);
            expect(result.fatal).toBe(false);
        });

        it('classifies "credit balance" message as billing', () => {
            const result = classifyProviderFailure({ message: 'Your credit balance is too low' });
            expect(result.kind).toBe('billing');
            expect(result.pauseable).toBe(true);
            expect(result.fatal).toBe(false);
        });

        it('classifies "insufficient funds" message as billing', () => {
            const result = classifyProviderFailure({ message: 'insufficient funds on account' });
            expect(result.kind).toBe('billing');
        });

        it('classifies "payment required" message as billing', () => {
            const result = classifyProviderFailure({ message: 'payment required' });
            expect(result.kind).toBe('billing');
        });

        it('classifies "spending limit" message as billing', () => {
            const result = classifyProviderFailure({ message: 'You have exceeded your spending limit' });
            expect(result.kind).toBe('billing');
        });

        it('classifies "exceeded quota" message as billing (billing patterns take priority)', () => {
            const result = classifyProviderFailure({ message: 'You have exceeded your quota' });
            expect(result.kind).toBe('billing');
            expect(result.pauseable).toBe(true);
        });

        it('classifies errorType matching billing pattern', () => {
            const result = classifyProviderFailure({
                message: 'something went wrong',
                error: { type: 'billing_error' },
            });
            expect(result.kind).toBe('billing');
        });

        it('classifies a 4xx with billing message via the re-check branch', () => {
            // A status like 400 that does NOT match earlier status-code checks
            // but whose message matches billing patterns => billing
            const result = classifyProviderFailure({
                status: 400,
                message: 'Your credit balance is too low',
            });
            expect(result.kind).toBe('billing');
            expect(result.pauseable).toBe(true);
        });
    });

    // -- auth -----------------------------------------------------------------

    describe('auth', () => {
        it('classifies status 401 as auth', () => {
            const result = classifyProviderFailure({ status: 401, message: 'Unauthorized' });
            expect(result.kind).toBe('auth');
            expect(result.pauseable).toBe(false);
            expect(result.fatal).toBe(true);
        });

        it('classifies status 403 as auth', () => {
            const result = classifyProviderFailure({ status: 403, message: 'Forbidden' });
            expect(result.kind).toBe('auth');
            expect(result.pauseable).toBe(false);
            expect(result.fatal).toBe(true);
        });

        it('classifies "invalid api key" message as auth', () => {
            const result = classifyProviderFailure({ message: 'invalid api key provided' });
            expect(result.kind).toBe('auth');
            expect(result.fatal).toBe(true);
        });

        it('classifies "authentication_error" errorType as auth', () => {
            const result = classifyProviderFailure({
                message: 'request failed',
                error: { type: 'authentication_error' },
            });
            expect(result.kind).toBe('auth');
        });

        it('classifies "permission denied" message as auth', () => {
            const result = classifyProviderFailure({ message: 'permission denied' });
            expect(result.kind).toBe('auth');
        });

        it('classifies "access denied" message as auth', () => {
            const result = classifyProviderFailure({ message: 'access denied' });
            expect(result.kind).toBe('auth');
        });
    });

    // -- model-not-found ------------------------------------------------------

    describe('model-not-found', () => {
        it('classifies status 404 as model-not-found', () => {
            const result = classifyProviderFailure({ status: 404, message: 'Not Found' });
            expect(result.kind).toBe('model-not-found');
            expect(result.pauseable).toBe(false);
            expect(result.fatal).toBe(true);
        });

        it('classifies "model not found" message as model-not-found', () => {
            const result = classifyProviderFailure({ message: 'The model not found in registry' });
            expect(result.kind).toBe('model-not-found');
        });

        it('classifies "does not exist" message as model-not-found', () => {
            const result = classifyProviderFailure({ message: 'The model does not exist' });
            expect(result.kind).toBe('model-not-found');
        });

        it('classifies "unknown model" message as model-not-found', () => {
            const result = classifyProviderFailure({ message: 'unknown model requested' });
            expect(result.kind).toBe('model-not-found');
        });

        it('classifies "invalid model" message as model-not-found', () => {
            const result = classifyProviderFailure({ message: 'invalid model: gpt-9000' });
            expect(result.kind).toBe('model-not-found');
        });
    });

    // -- quota ----------------------------------------------------------------

    describe('quota', () => {
        it('classifies status 429 as quota', () => {
            const result = classifyProviderFailure({ status: 429, message: 'Too Many Requests' });
            expect(result.kind).toBe('quota');
            expect(result.pauseable).toBe(true);
            expect(result.fatal).toBe(false);
        });

        it('classifies "rate limit exceeded" message as quota', () => {
            const result = classifyProviderFailure({ message: 'rate limit exceeded, retry later' });
            expect(result.kind).toBe('quota');
        });

        it('classifies "too many requests" message as quota', () => {
            const result = classifyProviderFailure({ message: 'too many requests' });
            expect(result.kind).toBe('quota');
        });

        it('classifies "quota exceeded" errorType as quota', () => {
            const result = classifyProviderFailure({
                message: 'something',
                type: 'quota_exceeded',
            });
            expect(result.kind).toBe('quota');
        });

        it('classifies "token limit" message as quota', () => {
            const result = classifyProviderFailure({ message: 'token limit reached' });
            expect(result.kind).toBe('quota');
        });

        it('classifies "request limit" message as quota', () => {
            const result = classifyProviderFailure({ message: 'request limit reached' });
            expect(result.kind).toBe('quota');
        });
    });

    // -- transient -------------------------------------------------------------

    describe('transient', () => {
        it('classifies status 500 as transient', () => {
            const result = classifyProviderFailure({ status: 500, message: 'Internal Server Error' });
            expect(result.kind).toBe('transient');
            expect(result.pauseable).toBe(false);
            expect(result.fatal).toBe(false);
        });

        it('classifies status 502 as transient', () => {
            const result = classifyProviderFailure({ status: 502, message: 'Bad Gateway' });
            expect(result.kind).toBe('transient');
        });

        it('classifies status 503 as transient', () => {
            const result = classifyProviderFailure({ status: 503, message: 'Service Unavailable' });
            expect(result.kind).toBe('transient');
        });

        it('classifies "ECONNRESET" message as transient', () => {
            const result = classifyProviderFailure({ message: 'read ECONNRESET' });
            expect(result.kind).toBe('transient');
        });

        it('classifies "socket hang up" message as transient', () => {
            const result = classifyProviderFailure({ message: 'socket hang up' });
            expect(result.kind).toBe('transient');
        });

        it('classifies "ETIMEDOUT" message as transient', () => {
            const result = classifyProviderFailure({ message: 'connect ETIMEDOUT 1.2.3.4:443' });
            expect(result.kind).toBe('transient');
        });

        it('classifies "network error" message as transient', () => {
            const result = classifyProviderFailure({ message: 'network error' });
            expect(result.kind).toBe('transient');
        });

        it('classifies "fetch failed" message as transient', () => {
            const result = classifyProviderFailure({ message: 'fetch failed' });
            expect(result.kind).toBe('transient');
        });
    });

    // -- unknown --------------------------------------------------------------

    describe('unknown', () => {
        it('classifies a 4xx without billing match as unknown', () => {
            const result = classifyProviderFailure({ status: 422, message: 'Unprocessable Entity' });
            expect(result.kind).toBe('unknown');
            expect(result.pauseable).toBe(false);
            expect(result.fatal).toBe(false);
        });

        it('classifies errors with no recognizable pattern as unknown', () => {
            const result = classifyProviderFailure({ message: 'something completely unexpected' });
            expect(result.kind).toBe('unknown');
            expect(result.pauseable).toBe(false);
            expect(result.fatal).toBe(false);
        });

        it('classifies an empty error object as unknown', () => {
            const result = classifyProviderFailure({});
            expect(result.kind).toBe('unknown');
        });
    });

    // -- edge cases -----------------------------------------------------------

    describe('edge cases', () => {
        it('handles a plain string error', () => {
            const result = classifyProviderFailure('plain string error');
            expect(result.kind).toBe('unknown');
            expect(result.message).toBe('plain string error');
        });

        it('handles a string with a billing keyword', () => {
            const result = classifyProviderFailure('insufficient credits');
            // String errors: errObj.message is undefined, so message = String(err)
            // The combined text includes "insufficient credits"
            expect(result.kind).toBe('billing');
        });

        it('handles null error', () => {
            const result = classifyProviderFailure(null);
            expect(result.kind).toBe('unknown');
        });

        it('handles undefined error', () => {
            const result = classifyProviderFailure(undefined);
            expect(result.kind).toBe('unknown');
        });

        it('extracts status from statusCode property', () => {
            const result = classifyProviderFailure({ statusCode: 429, message: 'throttled' });
            expect(result.kind).toBe('quota');
        });

        it('extracts status from response.status property', () => {
            const result = classifyProviderFailure({
                response: { status: 401 },
                message: 'failed',
            });
            expect(result.kind).toBe('auth');
        });

        it('extracts errorType from error.type property', () => {
            const result = classifyProviderFailure({
                message: 'failure',
                error: { type: 'authentication_error' },
            });
            expect(result.kind).toBe('auth');
        });

        it('extracts errorType from top-level type property', () => {
            const result = classifyProviderFailure({
                message: 'failure',
                type: 'rate_limit_error',
            });
            expect(result.kind).toBe('quota');
        });

        it('preserves the original message in the classification', () => {
            const result = classifyProviderFailure({ status: 500, message: 'Oops, server broke' });
            expect(result.message).toBe('Oops, server broke');
        });
    });
});

// ---- isProviderLevelFailure -------------------------------------------------

describe('isProviderLevelFailure', () => {
    it('returns true for billing', () => {
        const c: ProviderFailureClassification = { kind: 'billing', pauseable: true, fatal: false, message: '' };
        expect(isProviderLevelFailure(c)).toBe(true);
    });

    it('returns true for auth', () => {
        const c: ProviderFailureClassification = { kind: 'auth', pauseable: false, fatal: true, message: '' };
        expect(isProviderLevelFailure(c)).toBe(true);
    });

    it('returns true for quota', () => {
        const c: ProviderFailureClassification = { kind: 'quota', pauseable: true, fatal: false, message: '' };
        expect(isProviderLevelFailure(c)).toBe(true);
    });

    it('returns false for model-not-found', () => {
        const c: ProviderFailureClassification = { kind: 'model-not-found', pauseable: false, fatal: true, message: '' };
        expect(isProviderLevelFailure(c)).toBe(false);
    });

    it('returns false for transient', () => {
        const c: ProviderFailureClassification = { kind: 'transient', pauseable: false, fatal: false, message: '' };
        expect(isProviderLevelFailure(c)).toBe(false);
    });

    it('returns false for unknown', () => {
        const c: ProviderFailureClassification = { kind: 'unknown', pauseable: false, fatal: false, message: '' };
        expect(isProviderLevelFailure(c)).toBe(false);
    });
});

// ---- ProviderRecoveryFailedError --------------------------------------------

describe('ProviderRecoveryFailedError', () => {
    it('has name "ProviderRecoveryFailedError"', () => {
        const classification: ProviderFailureClassification = {
            kind: 'billing',
            pauseable: true,
            fatal: false,
            message: 'credit balance too low',
        };
        const err = new ProviderRecoveryFailedError(classification);
        expect(err.name).toBe('ProviderRecoveryFailedError');
    });

    it('includes the kind and message in the error message', () => {
        const classification: ProviderFailureClassification = {
            kind: 'auth',
            pauseable: false,
            fatal: true,
            message: 'invalid api key',
        };
        const err = new ProviderRecoveryFailedError(classification);
        expect(err.message).toContain('auth');
        expect(err.message).toContain('invalid api key');
    });

    it('exposes the classification as a property', () => {
        const classification: ProviderFailureClassification = {
            kind: 'quota',
            pauseable: true,
            fatal: false,
            message: 'rate limit exceeded',
        };
        const err = new ProviderRecoveryFailedError(classification);
        expect(err.classification).toBe(classification);
    });

    it('is an instance of Error', () => {
        const classification: ProviderFailureClassification = {
            kind: 'transient',
            pauseable: false,
            fatal: false,
            message: 'server error',
        };
        const err = new ProviderRecoveryFailedError(classification);
        expect(err).toBeInstanceOf(Error);
    });
});
