/**
 * Secret redaction — shared by git output handling and the debug trace.
 *
 * Extracted from git-exec.ts so that modules git-exec itself depends on
 * (shell-exec → debug-trace) can redact without an import cycle. Keep this
 * module dependency-free.
 */

const REDACTED = '***REDACTED***';

/** Values shorter than this are never scrubbed by exact match (too many false positives). */
const MIN_SECRET_VALUE_LENGTH = 8;

/** Patterns that match tokens / PATs / credentials in command output, logs and traces. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/x-access-token:[^@]*@/g, REDACTED],
    [/ghp_\w+/g, REDACTED],
    [/gho_\w+/g, REDACTED],
    [/\bgh[usr]_[A-Za-z0-9]{20,}/g, REDACTED],
    [/github_pat_\w+/g, REDACTED],
    [/Authorization:\s*(?:Basic|Bearer|token)\s+\S+/gi, REDACTED],
    [/\/\/[^/\s:@]+:[^/\s@]+@/g, `//${REDACTED}@`],
    [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
];

/**
 * Replace known secret patterns in text with a redacted placeholder.
 * Safe to call on any string — returns input unchanged if no secrets found.
 */
export function redactSecrets(text: string): string {
    let result = text;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

/**
 * Replace every occurrence of the given secret values (e.g. the configured
 * GitHub token or API keys) with a redacted placeholder. Catches secrets
 * whose format no pattern recognises. Values under 8 characters are ignored.
 */
export function redactValues(text: string, values: readonly string[]): string {
    let result = text;
    for (const value of values) {
        if (value.length >= MIN_SECRET_VALUE_LENGTH && result.includes(value)) {
            result = result.split(value).join(REDACTED);
        }
    }
    return result;
}
