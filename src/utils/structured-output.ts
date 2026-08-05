/**
 * Structured output validation for LLM agent responses.
 *
 * Consolidates the three duplicate JSON-extraction strategies that were
 * scattered across nodes.ts and pr-workflow.ts, and adds Zod-based
 * schema validation with a repair prompt so callers can ask the agent
 * to fix specific violations instead of silently absorbing them as
 * `undefined` / `?? []` defaults (PART A7).
 */
import { z } from 'zod';
import { getLogger } from './logger';

const log = getLogger('[structured-output]', 183);

// ─── JSON Extraction ────────────────────────────────────────────────────────

export type ParseResult =
    | { ok: true; value: unknown }
    | { ok: false; error: string };

/**
 * Extract a JSON object from an LLM response.
 *
 * Strategy ladder (unchanged from the three copies this replaces):
 * direct JSON.parse -> fenced ```json block -> first balanced {...} run.
 */
export function parseAgentJson(raw: string): ParseResult {
    const trimmed = raw.trim();

    // Strategy 1: direct JSON.parse
    try {
        return { ok: true, value: JSON.parse(trimmed) };
    } catch { /* fall through */ }

    // Strategy 2: extract from ```json ... ``` code fence
    const codeBlock = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) {
        try {
            return { ok: true, value: JSON.parse(codeBlock[1].trim()) };
        } catch { /* fall through */ }
    }

    // Strategy 3: first balanced { ... } run
    const braces = trimmed.match(/(\{[\s\S]*\})/);
    if (braces) {
        try {
            return { ok: true, value: JSON.parse(braces[1]) };
        } catch { /* fall through */ }
    }

    return { ok: false, error: `Could not extract JSON. Response starts with: ${trimmed.substring(0, 200)}` };
}

// ─── Zod Validation ─────────────────────────────────────────────────────────

/**
 * Compact, model-readable summary of Zod issues: at most `max` `path: message` lines.
 */
export function summariseZodIssues(issues: z.ZodIssue[], max: number = 10): string {
    const lines = issues.slice(0, max).map(issue => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `- ${path}: ${issue.message}`;
    });
    if (issues.length > max) {
        lines.push(`- … and ${issues.length - max} more issue(s)`);
    }
    return lines.join('\n');
}

export interface ValidationOutcome<T> {
    ok: boolean;
    value: T;
    issues: string;
    repaired: boolean;
}

/**
 * safeParse the parsed output; on failure return the issue summary so the
 * caller can ask the agent to repair it.
 *
 * Schema violations previously became silent `undefined`s absorbed by `?? []`
 * defaults all over the codebase (PART A7) -- a testReport missing `status`
 * read as a pass.
 */
export function validateAgentOutput<T>(schema: z.ZodType<T>, parsed: unknown): ValidationOutcome<T> {
    const result = schema.safeParse(parsed);
    if (result.success) {
        return { ok: true, value: result.data, issues: '', repaired: false };
    }
    const issues = summariseZodIssues(result.error.issues);
    return { ok: false, value: parsed as T, issues, repaired: false };
}

// ─── Repair Prompt ──────────────────────────────────────────────────────────

/**
 * Prompt text asking the agent to fix a specific set of schema violations.
 */
export function buildRepairMessage(issues: string, originalRequest: string): string {
    return [
        'Your previous response did not match the required JSON schema.',
        '',
        'Problems:',
        issues,
        '',
        'Return the SAME information, corrected, as a single valid JSON object.',
        'Do not add commentary. Do not wrap it in markdown.',
    ].join('\n');
}

// ─── Validation Stats (module-level singleton) ──────────────────────────────

export interface ValidationStats {
    /** Total outputs validated against a schema. */
    validated: number;
    /** Outputs that required a repair round and then passed. */
    repaired: number;
    /** Outputs that failed validation even after repair attempts. */
    failed: number;
}

let stats: ValidationStats = { validated: 0, repaired: 0, failed: 0 };

export function getValidationStats(): ValidationStats {
    return { ...stats };
}

export function logValidationStats(): void {
    log.info(
        `Output validation: ${stats.validated} validated, ${stats.repaired} repaired, ${stats.failed} failed`,
    );
}

/**
 * Reset internal state (for testing only).
 * @internal
 */
export function _resetValidationStats(): void {
    stats = { validated: 0, repaired: 0, failed: 0 };
}

/** Increment the validated counter. */
export function _recordValidated(): void { stats.validated++; }

/** Increment the repaired counter. */
export function _recordRepaired(): void { stats.repaired++; }

/** Increment the failed counter. */
export function _recordFailed(): void { stats.failed++; }
