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
import { jsonrepair } from 'jsonrepair';
import { getLogger } from './logger';

const log = getLogger('[structured-output]', 183);

// ─── JSON Extraction ────────────────────────────────────────────────────────

export type ParseResult =
    | { ok: true; value: unknown; wasTruncated?: boolean; rawLength?: number }
    | { ok: false; error: string; wasTruncated?: boolean; rawLength?: number };

/**
 * Extract a JSON object from an LLM response.
 *
 * Strategy ladder (unchanged from the three copies this replaces):
 * direct JSON.parse -> fenced ```json block -> first balanced {...} run.
 */
export function parseAgentJson(raw: string): ParseResult {
    const trimmed = raw.trim();
    const rawLength = trimmed.length;

    // Strategy 1: direct JSON.parse
    try {
        return { ok: true, value: JSON.parse(trimmed), rawLength };
    } catch { /* fall through */ }

    // Strategy 2: extract from ```json ... ``` code fence
    const codeBlock = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) {
        try {
            return { ok: true, value: JSON.parse(codeBlock[1].trim()), rawLength };
        } catch { /* fall through */ }
    }

    // Strategy 3: first balanced { ... } run
    const braces = trimmed.match(/(\{[\s\S]*\})/);
    if (braces) {
        try {
            return { ok: true, value: JSON.parse(braces[1]), rawLength };
        } catch { /* fall through */ }
    }

    // Strategy 4: repair malformed / truncated JSON with jsonrepair.
    // Only attempt if the input looks like it may contain JSON (has { or [).
    const looksLikeJson = /[{\[]/.test(trimmed);
    if (looksLikeJson) {
        try {
            const repaired = jsonrepair(trimmed);
            const value = JSON.parse(repaired);
            if (typeof value === 'object' && value !== null) {
                log.warn('parseAgentJson: recovered via jsonrepair (input was malformed/truncated)');
                return { ok: true, value, wasTruncated: true, rawLength };
            }
        } catch { /* fall through */ }

        // Strategy 4b: jsonrepair on the slice starting from the first '{'.
        // This handles truncated JSON embedded in prose where the closing '}' is
        // missing (so the balanced-braces regex in strategy 3 can't match).
        const firstBrace = trimmed.indexOf('{');
        if (firstBrace >= 0) {
            try {
                const slice = trimmed.slice(firstBrace);
                const repaired = jsonrepair(slice);
                const value = JSON.parse(repaired);
                if (typeof value === 'object' && value !== null) {
                    log.warn('parseAgentJson: recovered via jsonrepair on brace-extracted slice');
                    return { ok: true, value, wasTruncated: true, rawLength };
                }
            } catch { /* fall through */ }
        }
    }

    // Detect structural truncation even when jsonrepair fails
    const wasTruncated = detectTruncation(trimmed);
    return { ok: false, error: `Could not extract JSON. Response starts with: ${trimmed.substring(0, 200)}`, wasTruncated, rawLength };
}

/**
 * Heuristic: detect structurally incomplete JSON (unbalanced braces/brackets,
 * trailing partial token, or mid-string cut-off).
 */
export function detectTruncation(raw: string): boolean {
    let braceDepth = 0;
    let bracketDepth = 0;
    let inString = false;
    let escaped = false;
    for (const ch of raw) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '[') bracketDepth++;
        else if (ch === ']') bracketDepth--;
    }
    // Unbalanced delimiters or still inside a string → truncated
    return braceDepth > 0 || bracketDepth > 0 || inString;
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

// ─── Field-Level Repair ─────────────────────────────────────────────────────

export interface FieldRepairResult {
    value: unknown;
    unrepairable: z.ZodIssue[];
    repaired: Array<{ path: string; from: unknown; to: unknown }>;
}

/**
 * Repair schema violations in place without re-asking for the whole payload.
 *
 * Deterministic coercions:
 * - Enum near-miss: case-insensitive / whitespace-trimmed / hyphen-normalised match
 * - Missing required string with known default (taskType→'feature', priority→'medium', complexity→'moderate')
 * - Scalar where array expected → [value]
 * - Array where scalar expected → first element
 * - String where object expected → JSON.parse attempt, else { name: value }
 * - Numeric strings → numbers; "true"/"false" → booleans
 */
export function repairFieldViolations<T>(
    raw: unknown,
    schema: z.ZodType<T>,
    _opts?: { coerce?: boolean },
): FieldRepairResult {
    const repaired: FieldRepairResult['repaired'] = [];
    const result = schema.safeParse(raw);
    if (result.success) {
        return { value: raw, unrepairable: [], repaired };
    }

    const mutable = structuredClone(raw) as Record<string, unknown>;
    const remaining: z.ZodIssue[] = [];

    for (const issue of result.error.issues) {
        const pathStr = issue.path.join('.');
        const parent = getNestedParent(mutable, issue.path as (string | number)[]);
        const lastKey = issue.path[issue.path.length - 1];
        if (!parent || lastKey === undefined) { remaining.push(issue); continue; }
        const oldVal = parent[lastKey];

        let fixed = false;

        // Enum near-miss (zod v3 uses 'invalid_enum_value', zod v4 uses 'invalid_value' with 'values')
        const isEnumIssue = (issue.code as string) === 'invalid_enum_value' && 'options' in issue;
        const isValueIssue = (issue.code as string) === 'invalid_value' && 'values' in issue;
        if ((isEnumIssue || isValueIssue)) {
            const options = ((issue as any).options ?? (issue as any).values) as string[];
            const input = String(oldVal).trim().toLowerCase().replace(/[-_\s]+/g, '');
            const match = options.find(o => o.toLowerCase().replace(/[-_\s]+/g, '') === input);
            if (match) {
                parent[lastKey] = match;
                repaired.push({ path: pathStr, from: oldVal, to: match });
                fixed = true;
            } else {
                // Known defaults for common fields
                const fieldName = String(lastKey);
                const defaults: Record<string, string> = {
                    taskType: 'feature', priority: 'medium', complexity: 'moderate',
                    rank: 'senior', status: 'pass',
                };
                // Also map common synonyms
                const synonyms: Record<string, Record<string, string>> = {
                    taskType: { task: 'feature', story: 'feature', 'story-task': 'feature', bugfix: 'fix', enhancement: 'feature', improvement: 'refactor' },
                };
                const syn = synonyms[fieldName]?.[String(oldVal).toLowerCase()];
                if (syn && options.includes(syn)) {
                    parent[lastKey] = syn;
                    repaired.push({ path: pathStr, from: oldVal, to: syn });
                    fixed = true;
                } else if (defaults[fieldName] && options.includes(defaults[fieldName])) {
                    parent[lastKey] = defaults[fieldName];
                    repaired.push({ path: pathStr, from: oldVal, to: defaults[fieldName] });
                    fixed = true;
                }
            }
        }

        // Scalar where array expected
        if (!fixed && issue.code === 'invalid_type' && issue.expected === 'array' && !Array.isArray(oldVal) && oldVal !== undefined) {
            parent[lastKey] = [oldVal];
            repaired.push({ path: pathStr, from: oldVal, to: [oldVal] });
            fixed = true;
        }

        // Array where scalar expected
        if (!fixed && issue.code === 'invalid_type' && issue.expected !== 'array' && Array.isArray(oldVal) && oldVal.length > 0) {
            const first = oldVal[0];
            parent[lastKey] = first;
            repaired.push({ path: pathStr, from: oldVal, to: first });
            fixed = true;
        }

        // String where object expected
        if (!fixed && issue.code === 'invalid_type' && issue.expected === 'object' && typeof oldVal === 'string') {
            try {
                const parsed = JSON.parse(oldVal);
                if (typeof parsed === 'object' && parsed !== null) {
                    parent[lastKey] = parsed;
                    repaired.push({ path: pathStr, from: oldVal, to: parsed });
                    fixed = true;
                }
            } catch {
                parent[lastKey] = { name: oldVal };
                repaired.push({ path: pathStr, from: oldVal, to: { name: oldVal } });
                fixed = true;
            }
        }

        // Numeric strings → numbers
        if (!fixed && issue.code === 'invalid_type' && issue.expected === 'number' && typeof oldVal === 'string') {
            const n = Number(oldVal);
            if (!isNaN(n)) {
                parent[lastKey] = n;
                repaired.push({ path: pathStr, from: oldVal, to: n });
                fixed = true;
            }
        }

        // "true"/"false" → booleans
        if (!fixed && issue.code === 'invalid_type' && issue.expected === 'boolean' && typeof oldVal === 'string') {
            if (oldVal.toLowerCase() === 'true' || oldVal.toLowerCase() === 'false') {
                const b = oldVal.toLowerCase() === 'true';
                parent[lastKey] = b;
                repaired.push({ path: pathStr, from: oldVal, to: b });
                fixed = true;
            }
        }

        if (!fixed) remaining.push(issue);
    }

    return { value: mutable, unrepairable: remaining, repaired };
}

/** Walk a nested path and return the parent container + last key. */
function getNestedParent(obj: any, path: (string | number)[]): any {
    if (path.length === 0) return undefined;
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[path[i]];
    }
    return current;
}

// ─── Repair Prompt ──────────────────────────────────────────────────────────

/**
 * Prompt text asking the agent to fix a specific set of schema violations.
 *
 * When `previousRaw` is supplied, the raw JSON is included so the repair
 * agent can correct rather than regenerate from scratch.
 *
 * P1 fix: previously clipped `previousRaw` to 4 000 chars, which made
 * repair lossy for large planning outputs.  Now we use a 16 000-char
 * budget with middle-clip so both head and tail of the JSON survive.
 */
export function buildRepairMessage(issues: string, originalRequest: string, previousRaw?: string): string {
    const REPAIR_BUDGET = 16_000;
    const parts = [
        'Your previous response did not match the required JSON schema.',
        '',
        'Problems:',
        issues,
    ];

    if (previousRaw) {
        let clipped: string;
        if (previousRaw.length <= REPAIR_BUDGET) {
            clipped = previousRaw;
        } else {
            // Middle-clip: keep first half and last quarter of budget
            const headLen = Math.floor(REPAIR_BUDGET * 0.6);
            const tailLen = Math.floor(REPAIR_BUDGET * 0.3);
            const omitted = previousRaw.length - headLen - tailLen;
            clipped = previousRaw.slice(0, headLen)
                + `\n... [${omitted} chars omitted] ...\n`
                + previousRaw.slice(previousRaw.length - tailLen);
        }
        parts.push('', 'Your previous (invalid) JSON:', '```', clipped, '```');
    }

    parts.push(
        '',
        'Return the SAME information, corrected, as a single valid JSON object.',
        'Do not add commentary. Do not wrap it in markdown.',
    );
    return parts.join('\n');
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
