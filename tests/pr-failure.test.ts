/**
 * Tests for PR failure classifier (Sub-Plan 06 SS4).
 *
 * Each test uses a literal error payload observed in the pacman8/retroboard3 run logs.
 */
import { classifyPrFailure, isFatalPrFailure } from '../src/conductor/pr-failure';

describe('classifyPrFailure', () => {
    it('classifies GitHub 422 "A pull request already exists" as pr-already-exists', () => {
        const err = new Error('GitHub API error: Validation Failed ([{"resource":"PullRequest","code":"custom","message":"A pull request already exists for ErezSCE:pacman8/feature/us-001-pacman-movement."}])');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('pr-already-exists');
        expect(result.retryable).toBe(false);
    });

    it('classifies "No commits between" as no-commits', () => {
        const err = new Error('No commits between project/retroboard3 and retroboard3/feature/us-007-reconnect');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('no-commits');
        expect(result.retryable).toBe(false);
    });

    it('classifies "Pull Request has merge conflicts" as merge-conflict', () => {
        const err = new Error('Merge failed: Pull Request has merge conflicts');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('merge-conflict');
        expect(result.retryable).toBe(false);
    });

    it('classifies "CONFLICT (content)" with "Merge conflict" as merge-conflict', () => {
        // "CONFLICT (content): Merge conflict" matches merge-conflict first due to pattern ordering
        const err = new Error('CONFLICT (content): Merge conflict in src/App.tsx');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('merge-conflict');
        expect(result.retryable).toBe(false);
    });

    it('classifies bare "CONFLICT (content)" as rebase-failed', () => {
        const err = new Error('CONFLICT (content): content conflict in src/App.tsx');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rebase-failed');
        expect(result.retryable).toBe(false);
    });

    it('classifies "could not apply" as rebase-failed', () => {
        const err = new Error('error: could not apply abc1234... feat: add game engine');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rebase-failed');
        expect(result.retryable).toBe(false);
    });

    it('classifies "needs merge" as rebase-failed', () => {
        const err = new Error('error: you need to resolve your current index first needs merge');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rebase-failed');
        expect(result.retryable).toBe(false);
    });

    it('classifies "non-fast-forward" as push-rejected (retryable)', () => {
        const err = new Error('! [rejected] feature -> feature (non-fast-forward)');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('push-rejected');
        expect(result.retryable).toBe(true);
    });

    it('classifies "Updates were rejected" as push-rejected (retryable)', () => {
        const err = new Error('Updates were rejected because the remote contains work that you do not have locally.');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('push-rejected');
        expect(result.retryable).toBe(true);
    });

    it('classifies "Bad credentials" as auth', () => {
        const err = new Error('Bad credentials');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('auth');
        expect(result.retryable).toBe(false);
    });

    it('classifies numeric 401 status as auth', () => {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('auth');
    });

    it('classifies numeric 403 status as auth', () => {
        const err = Object.assign(new Error('Something went wrong'), { status: 403 });
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('auth');
    });

    it('classifies "rate limit" as rate-limit (retryable)', () => {
        const err = new Error('API rate limit exceeded for user');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rate-limit');
        expect(result.retryable).toBe(true);
    });

    it('classifies "secondary rate limit" as rate-limit', () => {
        const err = new Error('You have exceeded a secondary rate limit');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rate-limit');
        expect(result.retryable).toBe(true);
    });

    it('classifies 429 status as rate-limit', () => {
        const err = Object.assign(new Error('Too many requests'), { status: 429 });
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rate-limit');
        expect(result.retryable).toBe(true);
    });

    it('classifies ECONNRESET as network (retryable)', () => {
        const err = new Error('read ECONNRESET');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('network');
        expect(result.retryable).toBe(true);
    });

    it('classifies ETIMEDOUT as network (retryable)', () => {
        const err = new Error('connect ETIMEDOUT 140.82.121.3:443');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('network');
        expect(result.retryable).toBe(true);
    });

    it('classifies "socket hang up" as network (retryable)', () => {
        const err = new Error('socket hang up');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('network');
        expect(result.retryable).toBe(true);
    });

    it('classifies unknown errors as unknown', () => {
        const err = new Error('Something completely unexpected happened');
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('unknown');
        expect(result.retryable).toBe(false);
    });

    it('handles null/undefined error gracefully', () => {
        expect(classifyPrFailure(null).kind).toBe('unknown');
        expect(classifyPrFailure(undefined).kind).toBe('unknown');
    });

    it('extracts message from stderr property', () => {
        const err = { message: 'git error', stderr: 'CONFLICT (content): merge conflict in file.ts' };
        const result = classifyPrFailure(err);
        // "merge conflict" in stderr matches merge-conflict pattern
        expect(result.kind).toBe('merge-conflict');
    });

    it('extracts rebase-failed from stderr without merge keyword', () => {
        const err = { message: 'git error', stderr: 'could not apply abc123... feat: add game' };
        const result = classifyPrFailure(err);
        expect(result.kind).toBe('rebase-failed');
    });
});

describe('isFatalPrFailure', () => {
    it('returns true for auth errors', () => {
        const result = classifyPrFailure(new Error('Bad credentials'));
        expect(isFatalPrFailure(result)).toBe(true);
    });

    it('returns false for rate-limit errors', () => {
        const result = classifyPrFailure(new Error('rate limit exceeded'));
        expect(isFatalPrFailure(result)).toBe(false);
    });

    it('returns false for network errors', () => {
        const result = classifyPrFailure(new Error('ECONNRESET'));
        expect(isFatalPrFailure(result)).toBe(false);
    });

    it('returns false for merge-conflict errors', () => {
        const result = classifyPrFailure(new Error('Pull Request has merge conflicts'));
        expect(isFatalPrFailure(result)).toBe(false);
    });

    it('returns false for unknown errors', () => {
        const result = classifyPrFailure(new Error('something else'));
        expect(isFatalPrFailure(result)).toBe(false);
    });
});
