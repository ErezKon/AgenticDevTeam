import { LogColors } from './log-colors.util';
import { OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } from '../config';
import {logToolAction} from './logger';

const TAG = `${LogColors.BRIGHT_MAGENTA}[oauth-auth]${LogColors.RESET}`;

// In-memory cache
let cachedToken: string | null = null;
let expiresAtMs = 0;
let inflightPromise: Promise<string> | null = null;

/**
 * Fetch a fresh Bearer token using OAuth2 client-credentials flow.
 * Caches the token in-process and refreshes 60s before expiry.
 * Concurrent callers share the same in-flight request.
 */
export async function getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s safety margin)
    if (cachedToken && Date.now() < expiresAtMs - 60_000) {
        return cachedToken;
    }

    // If another caller is already fetching, piggyback on that promise
    if (inflightPromise) {
        return inflightPromise;
    }

    inflightPromise = fetchNewToken();
    try {
        const token = await inflightPromise;
        return token;
    } finally {
        inflightPromise = null;
    }
}

/** @deprecated Use getAccessToken() instead */
export const getDellAccessToken = getAccessToken;

async function fetchNewToken(): Promise<string> {
    const clientId = OAUTH_CLIENT_ID;
    const clientSecret = OAUTH_CLIENT_SECRET;

    if (!OAUTH_TOKEN_URL) {
        throw new Error(
            'OAUTH_TOKEN_URL must be set in .env file. See .env.example for the template.'
        );
    }

    if (!clientId || !clientSecret) {
        throw new Error(
            'OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET (or DELL_CLIENT_ID and DELL_CLIENT_SECRET) must be set in .env file. ' +
            'See .env.example for the template.'
        );
    }

    const tokenString = `${clientId}:${clientSecret}`;
    const encodedToken = Buffer.from(tokenString).toString('base64');

    logToolAction(`${TAG} Requesting new access token from ${OAUTH_TOKEN_URL}...`);

    const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${encodedToken}`,
        },
        body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
            `OAuth token request failed: ${response.status} ${response.statusText}. ${body}`
        );
    }

    const data = await response.json() as {
        access_token: string;
        token_type: string;
        expires_in: number;
    };

    if (!data.access_token) {
        throw new Error('OAuth response missing access_token');
    }

    cachedToken = data.access_token;
    expiresAtMs = Date.now() + data.expires_in * 1000;

    logToolAction(`${TAG} Fetched new token (expires in ${data.expires_in}s)`);

    return cachedToken;
}
