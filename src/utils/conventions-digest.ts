/**
 * Conventions Digest — compact, in-prompt summary of coding conventions.
 *
 * Instead of making agents `read_file` each `.conventions/*.md` at runtime
 * (which lands in ReAct history and gets replayed on every subsequent step),
 * this module extracts the imperative rules from each source file and produces
 * a short digest that is injected directly into the agent's system prompt.
 *
 * Part of Step 6 of the token-reduction plan.
 *
 * Plan 30-07: rule lines only. The digest used to copy every H2/H3 heading,
 * which is a table of contents rather than a rule and filled most of its
 * budget; lines inside code blocks are skipped too (a `// Don't …` comment in an
 * example is not a rule). A file with no rule contributes nothing.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max characters for the assembled digest. */
const CONVENTIONS_DIGEST_MAX_CHARS = 1500;

/** Absolute path to the convention source files. */
const CONVENTIONS_SOURCE_DIR = resolve(
    __dirname, '..', 'Coding Conventions, Best Practices',
);

/** Regex that matches imperative keywords. */
const IMPERATIVE_RE = /\b(MUST|NEVER|ALWAYS|SHOULD NOT)\b|(?:^|\s)(?:Do not|Don't|do not|don't)\b/;

// ─── Cache ──────────────────────────────────────────────────────────────────

const digestCache = new Map<string, string>();

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract the imperative rules of a single convention file: lines (typically
 * bullets or table rows) that contain MUST, NEVER, ALWAYS, SHOULD NOT, Do not
 * or Don't — outside code blocks, headings and table-of-contents links.
 *
 * Returns deduplicated `- rule` lines.
 */
function extractFromFile(fileName: string): string[] {
    const filePath = join(CONVENTIONS_SOURCE_DIR, fileName);
    let content: string;
    try {
        content = readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const extracted: string[] = [];
    const seen = new Set<string>();
    let inCodeBlock = false;

    for (const rawLine of content.split('\n')) {
        const trimmed = rawLine.trim();
        if (trimmed.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock || !IMPERATIVE_RE.test(trimmed)) continue;
        // Headings and table-of-contents links (`1. [text](#anchor)`) are not rules
        if (/^#{1,6}\s/.test(trimmed) || /^\d+\.\s*\[/.test(trimmed)) continue;

        const norm = trimmed.replace(/^\|?\s*/, '').replace(/\s*\|?\s*$/, '');
        if (norm.length <= 10 || seen.has(norm)) continue;
        seen.add(norm);
        extracted.push(`- ${norm.startsWith('- ') ? norm.slice(2) : norm}`);
    }

    return extracted;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Produce a compact, in-prompt digest of the conventions an agent must follow.
 *
 * Extracts the imperative lines (MUST / NEVER / ALWAYS / SHOULD NOT / Do not /
 * Don't) of each file under a `[File.md]` label, then hard-caps at
 * CONVENTIONS_DIGEST_MAX_CHARS.
 *
 * Results are cached per file-name-set so the computation happens once
 * per process.
 *
 * @param fileNames - Convention file names (e.g. `['React.md', 'Universal.md']`)
 * @returns A compact string of imperative rules, or '' if no file has one.
 */
export function buildConventionsDigest(fileNames: string[]): string {
    if (fileNames.length === 0) return '';

    const cacheKey = [...fileNames].sort().join(',');
    if (digestCache.has(cacheKey)) return digestCache.get(cacheKey)!;

    const sections: string[] = [];

    for (const fileName of fileNames) {
        const lines = extractFromFile(fileName);
        if (lines.length > 0) {
            sections.push(`[${fileName}]`);
            sections.push(...lines);
        }
    }

    let digest = sections.join('\n');

    // Hard-cap at CONVENTIONS_DIGEST_MAX_CHARS, truncating at the last complete line
    if (digest.length > CONVENTIONS_DIGEST_MAX_CHARS) {
        const truncated = digest.slice(0, CONVENTIONS_DIGEST_MAX_CHARS);
        const lastNewline = truncated.lastIndexOf('\n');
        digest = lastNewline > 0
            ? truncated.slice(0, lastNewline)
            : truncated;
    }

    digestCache.set(cacheKey, digest);
    return digest;
}
