/**
 * Conventions Digest — compact, in-prompt summary of coding conventions.
 *
 * Instead of making agents `read_file` each `.conventions/*.md` at runtime
 * (which lands in ReAct history and gets replayed on every subsequent step),
 * this module extracts the imperative rules and key headings from each
 * source file and produces a short digest that is injected directly into
 * the agent's system prompt.
 *
 * Part of Step 6 of the token-reduction plan.
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
 * Extract imperative rules and key headings from a single convention file.
 *
 * Extracts:
 *  - H2/H3 headings (## / ###)
 *  - Lines (typically bullets) that contain imperative keywords:
 *    MUST, NEVER, ALWAYS, SHOULD NOT, Do not, Don't
 *  - Bullet lines containing bold text (key guidelines)
 *
 * Returns deduplicated lines with the file name as a section header.
 */
function extractFromFile(fileName: string): string[] {
    const filePath = join(CONVENTIONS_SOURCE_DIR, fileName);
    let content: string;
    try {
        content = readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const lines = content.split('\n');
    const extracted: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;

        // Skip table-of-contents links (lines that are just `[text](#anchor)`)
        if (/^\d+\.\s*\[/.test(line.trim())) continue;
        // Skip the title (H1)
        if (line.startsWith('# ') && !line.startsWith('## ')) continue;
        // Skip horizontal rules
        if (/^---+$/.test(line.trim())) continue;
        // Skip code block content
        if (line.trim().startsWith('```')) continue;

        const trimmed = line.trim();

        // H2/H3 headings provide structure
        if (/^#{2,3}\s/.test(trimmed)) {
            // Clean heading: remove numbering like "1.1 " or "## 1. "
            const heading = trimmed.replace(/^#{2,3}\s*(?:\d+\.?\d*\.?\s*)?/, '## ');
            if (!seen.has(heading)) {
                seen.add(heading);
                extracted.push(heading);
            }
            continue;
        }

        // Lines with imperative keywords
        if (IMPERATIVE_RE.test(trimmed)) {
            const norm = trimmed.replace(/^\|?\s*/, '').replace(/\s*\|?\s*$/, '');
            if (!seen.has(norm) && norm.length > 10) {
                seen.add(norm);
                extracted.push(`- ${norm.startsWith('- ') ? norm.slice(2) : norm}`);
            }
        }
    }

    return extracted;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Produce a compact, in-prompt digest of the conventions an agent must follow.
 *
 * Extracts H2/H3 headings and imperative lines (MUST / NEVER / ALWAYS /
 * Do not / Don't), then hard-caps at CONVENTIONS_DIGEST_MAX_CHARS.
 *
 * Results are cached per file-name-set so the computation happens once
 * per process.
 *
 * @param fileNames - Convention file names (e.g. `['React.md', 'Universal.md']`)
 * @returns A compact string of imperative rules, or '' if no files matched.
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
