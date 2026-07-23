/**
 * OAuth Token Generation — live integration test.
 *
 * Validates that the configured OAuth2 client-credentials endpoint
 * returns a valid bearer token and that caching works.
 */
import { getAccessToken } from '../src/utils/oauth-auth.util';

describe('OAuth Token Generation', () => {
    it('should fetch a valid access token from the configured OAuth endpoint', async () => {
        const token = await getAccessToken();

        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(0);
    });

    it('should return the same cached token on subsequent calls', async () => {
        const token1 = await getAccessToken();
        const token2 = await getAccessToken();

        expect(token1).toBe(token2);
    });
});
