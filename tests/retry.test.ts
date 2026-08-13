/**
 * Retry — unit tests for extended retryable error detection.
 *
 * Sub-Plan 08 §6: verifies that transient network errors (ECONNRESET,
 * socket hang up, Connection error, HTTP 502) are retryable, while
 * HTTP 404 and 401 are not.
 */
import { isRateLimitError, isTransientError, isRetryableError } from '../src/utils/retry';

// Mock logger
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

describe('Retry Error Classification', () => {
    describe('isRateLimitError', () => {
        it('detects 429 status', () => {
            expect(isRateLimitError({ status: 429, message: 'Too many requests' })).toBe(true);
        });

        it('detects "Rate limit" in message', () => {
            expect(isRateLimitError({ message: 'Rate limit exceeded' })).toBe(true);
        });

        it('detects "429" in message', () => {
            expect(isRateLimitError({ message: 'Error 429: rate limited' })).toBe(true);
        });

        it('rejects 200 status', () => {
            expect(isRateLimitError({ status: 200, message: 'OK' })).toBe(false);
        });
    });

    describe('isTransientError', () => {
        it('detects ECONNRESET', () => {
            expect(isTransientError({ message: 'read ECONNRESET' })).toBe(true);
        });

        it('detects socket hang up', () => {
            expect(isTransientError({ message: 'socket hang up' })).toBe(true);
        });

        it('detects Connection error', () => {
            expect(isTransientError({ message: 'Connection error.' })).toBe(true);
        });

        it('detects HTTP 502', () => {
            expect(isTransientError({ status: 502, message: 'Bad Gateway' })).toBe(true);
        });

        it('detects HTTP 503', () => {
            expect(isTransientError({ status: 503, message: 'Service Unavailable' })).toBe(true);
        });

        it('detects ETIMEDOUT', () => {
            expect(isTransientError({ message: 'connect ETIMEDOUT' })).toBe(true);
        });

        it('rejects HTTP 404', () => {
            expect(isTransientError({ status: 404, message: 'Not Found' })).toBe(false);
        });

        it('rejects HTTP 401', () => {
            expect(isTransientError({ status: 401, message: 'Unauthorized' })).toBe(false);
        });

        it('rejects HTTP 400', () => {
            expect(isTransientError({ status: 400, message: 'Bad Request' })).toBe(false);
        });
    });

    describe('isRetryableError', () => {
        it('rate limit errors are retryable', () => {
            expect(isRetryableError({ status: 429 })).toBe(true);
        });

        it('transient errors are retryable', () => {
            expect(isRetryableError({ message: 'socket hang up' })).toBe(true);
        });

        it('client errors are not retryable', () => {
            expect(isRetryableError({ status: 404, message: 'Not Found' })).toBe(false);
        });

        it('null/undefined are not retryable', () => {
            expect(isRetryableError(null)).toBe(false);
            expect(isRetryableError(undefined)).toBe(false);
        });
    });
});
