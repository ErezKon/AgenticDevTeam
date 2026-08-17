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

// ─── Content Block Normalisation ────────────────────────────────────────────

/**
 * Content-block types that carry model *thinking*, never the final answer.
 * Concatenating them into the payload corrupts JSON parsing, so they are
 * skipped by `extractTextFromContentBlocks`.
 */
const NON_ANSWER_BLOCK_TYPES = new Set([
    'reasoning', 'thinking', 'redacted_thinking', 'summary_text', 'refusal',
]);

/**
 * Extract text from LangChain content blocks.
 *
 * Handles Anthropic streaming and OpenAI Responses API formats where
 * `AIMessage.content` is an array of content blocks instead of a plain string.
 * - Anthropic streaming: `[{ type: 'text', text: '...' }]`
 * - OpenAI Responses API: `[{ type: 'text', text: '...', annotations: [...] }]`
 * - OpenAI Responses API (raw item shape): `[{ type: 'output_text', text: '...' }]`
 *
 * Reasoning / thinking blocks are skipped — they are commentary, not payload.
 *
 * Returns the concatenated text, or `null` if no text blocks are found
 * (e.g. the content is tool calls, reasoning only, or other non-text data).
 */
export function extractTextFromContentBlocks(content: unknown): string | null {
    if (!Array.isArray(content)) return null;
    const textParts: string[] = [];
    for (const block of content) {
        if (typeof block === 'string') {
            textParts.push(block);
            continue;
        }
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        const type = typeof b.type === 'string' ? b.type : undefined;
        if (type && NON_ANSWER_BLOCK_TYPES.has(type)) continue;
        // Any non-thinking block exposing a string `text` field carries payload:
        // 'text' (Anthropic + LangChain-normalised OpenAI), 'output_text' /
        // 'input_text' (raw Responses API items), and future variants.
        if (typeof b.text === 'string') textParts.push(b.text);
    }
    if (textParts.length === 0) return null;
    const joined = textParts.join('');
    return joined.trim().length > 0 ? joined : null;
}

/**
 * Human-readable census of content-block types, e.g. `"reasoning×2, text×1"`.
 * Used in diagnostics when text extraction comes back empty — the block types
 * are the only clue as to *why* an agent produced no payload.
 */
export function describeContentBlocks(content: unknown): string {
    if (typeof content === 'string') return `string(${content.length} chars)`;
    if (!Array.isArray(content)) return `${typeof content}`;
    if (content.length === 0) return 'empty array';
    const counts = new Map<string, number>();
    for (const block of content) {
        const type = typeof block === 'string'
            ? 'raw-string'
            : (typeof block === 'object' && block !== null && typeof (block as any).type === 'string'
                ? (block as any).type
                : 'unknown');
        counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(', ');
}

/** True when a message is an assistant/AI message (LangChain instance or plain object). */
function isAiMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false;
    if (typeof msg._getType === 'function') return msg._getType() === 'ai';
    if (typeof msg.getType === 'function') return msg.getType() === 'ai';
    return msg.type === 'ai' || msg.role === 'assistant' || Array.isArray(msg.tool_calls);
}

export interface AgentTextExtraction {
    /** The extracted payload text, or `null` when no message carried any. */
    text: string | null;
    /** Where the text came from — `earlier-message` means the final message was empty. */
    source: 'string' | 'content-blocks' | 'earlier-message' | 'none';
    /** Index into `messages` of the message the text came from (-1 when none). */
    messageIndex: number;
    /** Block-type census of the LAST message, for diagnostics. */
    blockTypes: string;
    /** Provider stop reason when it indicates truncation (`length`/`max_tokens`), else null. */
    truncatedByTokenLimit: boolean;
}

/**
 * Locate an agent's final payload text in a LangGraph result's message list.
 *
 * The last message is authoritative, but three real-world shapes make a naive
 * `messages[messages.length - 1].content` read unsafe:
 *  1. Content is an array of blocks (Anthropic streaming, OpenAI Responses API).
 *  2. Content is present but carries only reasoning blocks or an empty string
 *     (reasoning models that spend the whole output budget thinking).
 *  3. A trailing tool/empty message follows the real answer.
 *
 * In cases 2 and 3 we walk backwards to the most recent message that has usable
 * text so the caller can still validate a payload instead of silently treating
 * the run as empty.
 */
export function extractAgentText(messages: unknown): AgentTextExtraction {
    const list = Array.isArray(messages) ? messages : [];
    const lastMsg: any = list.length > 0 ? list[list.length - 1] : undefined;
    const blockTypes = lastMsg ? describeContentBlocks(lastMsg.content) : 'no messages';
    // Anthropic's LangChain adapter puts stop_reason in additional_kwargs,
    // not response_metadata. Check both locations to detect max_tokens truncation.
    const stopReason = String(
        lastMsg?.response_metadata?.finish_reason
        ?? lastMsg?.response_metadata?.stop_reason
        ?? lastMsg?.response_metadata?.status
        ?? lastMsg?.additional_kwargs?.stop_reason
        ?? '',
    ).toLowerCase();
    const truncatedByTokenLimit = stopReason === 'length' || stopReason === 'max_tokens' || stopReason === 'incomplete';

    for (let i = list.length - 1; i >= 0; i--) {
        const msg: any = list[i];
        const content = msg?.content;
        if (content == null) continue;
        const isLast = i === list.length - 1;
        // Only the final message may be of any type; when walking back we accept
        // AI messages only — a ToolMessage body is tool output, never the payload.
        if (!isLast && !isAiMessage(msg)) continue;

        if (typeof content === 'string') {
            if (content.trim().length === 0) continue;
            return {
                text: content,
                source: isLast ? 'string' : 'earlier-message',
                messageIndex: i, blockTypes, truncatedByTokenLimit,
            };
        }

        const extracted = extractTextFromContentBlocks(content);
        if (extracted !== null) {
            return {
                text: extracted,
                source: isLast ? 'content-blocks' : 'earlier-message',
                messageIndex: i, blockTypes, truncatedByTokenLimit,
            };
        }
    }

    return { text: null, source: 'none', messageIndex: -1, blockTypes, truncatedByTokenLimit };
}

/**
 * Normalise AIMessage.content to a plain string.
 *
 * Priority:
 *  1. Already a string → return as-is
 *  2. Array of content blocks → extract text via `extractTextFromContentBlocks`
 *  3. Fallback → `JSON.stringify(content)` (preserves old behaviour for unknown shapes)
 */
export function normaliseContentToString(content: unknown): string {
    if (typeof content === 'string') return content;
    const extracted = extractTextFromContentBlocks(content);
    if (extracted !== null) return extracted;
    return JSON.stringify(content);
}

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

// ─── Truncation Recovery ────────────────────────────────────────────────────

/**
 * When jsonrepair salvages a truncated response, the last element(s) of arrays
 * are often incomplete (missing required fields like `layer`, `suggestedTech`).
 * Rather than rejecting the entire 32K+ token output, trim those incomplete
 * trailing elements so the valid prefix is accepted.
 *
 * Strategy: collect all array paths that have validation errors on their last
 * element(s). Remove those elements from the end of the array, then re-validate.
 * Repeat until validation passes or no more trimmable arrays remain.
 */
export function trimTruncatedArrayTails<T>(
    raw: unknown,
    schema: z.ZodType<T>,
): { value: unknown; trimmed: Array<{ path: string; removedCount: number }>; ok: boolean } {
    const trimmed: Array<{ path: string; removedCount: number }> = [];
    let current = structuredClone(raw) as Record<string, unknown>;

    // Collect array paths where the LAST element has validation errors
    const result = schema.safeParse(current);
    if (result.success) return { value: current, trimmed, ok: true };

    // Group issues by their array parent path + index
    const arrayTailIssues = new Map<string, { maxIndex: number; path: (string | number)[] }>();
    for (const issue of result.error.issues) {
        if (issue.path.length < 2) continue;
        // Find the array-level path: everything up to (but not including) the numeric index
        let arrayPathParts: (string | number)[] = [];
        let elementIndex = -1;
        for (let i = issue.path.length - 1; i >= 0; i--) {
            if (typeof issue.path[i] === 'number') {
                arrayPathParts = issue.path.slice(0, i) as (string | number)[];
                elementIndex = issue.path[i] as number;
                break;
            }
        }
        if (elementIndex < 0) continue;

        const arrayPathStr = arrayPathParts.join('.');
        const existing = arrayTailIssues.get(arrayPathStr);
        if (!existing || elementIndex > existing.maxIndex) {
            arrayTailIssues.set(arrayPathStr, { maxIndex: elementIndex, path: arrayPathParts });
        }
    }

    if (arrayTailIssues.size === 0) return { value: current, trimmed, ok: false };

    // For each affected array, check if the errored element is the LAST element
    // and remove it
    for (const [pathStr, { maxIndex, path: arrayPath }] of arrayTailIssues) {
        let arr = current as any;
        for (const key of arrayPath) {
            if (arr == null || typeof arr !== 'object') { arr = undefined; break; }
            arr = arr[key];
        }
        if (!Array.isArray(arr)) continue;

        // Only trim if the errored index is the very last element
        if (maxIndex < arr.length - 1) continue;

        const removeCount = arr.length - maxIndex;
        arr.splice(maxIndex, removeCount);
        trimmed.push({ path: pathStr, removedCount: removeCount });
    }

    if (trimmed.length === 0) return { value: current, trimmed, ok: false };

    // Re-validate after trimming
    const recheck = schema.safeParse(current);
    return { value: current, trimmed, ok: recheck.success };
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
    } else if (originalRequest) {
        // Nothing usable came back (empty / reasoning-only response), so there is
        // nothing to correct — the model needs the original request again or it
        // will answer from the system prompt alone.
        parts.push('', 'Original request:', originalRequest);
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
