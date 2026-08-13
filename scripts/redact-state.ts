#!/usr/bin/env tsx
/**
 * Redact sensitive data from state.json files for use as test fixtures.
 * Usage: npx tsx scripts/redact-state.ts <input> <output>
 */
import * as fs from 'fs';

const REDACTED = '***REDACTED***';

const SENSITIVE_KEY_RE = /token|apiKey|secret|password|authorization/i;
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{20,}/g;
const ACCESS_TOKEN_URL_RE = /x-access-token:[^@]+@/g;

function redact(obj: any): any {
    if (typeof obj === 'string') {
        return obj
            .replace(GH_TOKEN_RE, REDACTED)
            .replace(ACCESS_TOKEN_URL_RE, `x-access-token:${REDACTED}@`);
    }
    if (Array.isArray(obj)) return obj.map(redact);
    if (obj && typeof obj === 'object') {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = SENSITIVE_KEY_RE.test(key) && typeof value === 'string'
                ? REDACTED
                : redact(value);
        }
        return result;
    }
    return obj;
}

const [,, input, output] = process.argv;
if (!input || !output) { console.error('Usage: npx tsx scripts/redact-state.ts <input> <output>'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(input, 'utf-8'));
fs.writeFileSync(output, JSON.stringify(redact(data), null, 2), 'utf-8');
console.log(`Redacted ${input} → ${output}`);
