/**
 * Jest setup file — runs before every test file.
 *
 * 1. Polyfills globalThis.crypto for Node < 19.
 * 2. Loads .env via dotenv.
 * 3. Validates required environment variables.
 */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

const REQUIRED_ENV = [
    'OAUTH_TOKEN_URL',
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'LLM_BASE_URL',
] as const;

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
    console.warn(
        `\n⚠  Missing required env vars: ${missing.join(', ')}.\n` +
        `   Some tests will fail. Copy .env.example → .env and fill in values.\n`
    );
}
