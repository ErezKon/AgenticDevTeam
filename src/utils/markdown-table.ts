/**
 * Shared markdown table and section helpers.
 *
 * Centralises the table-rendering pattern used by 8+ gate/report modules.
 * All cell values are pipe-escaped by default (fixes the rendering bug
 * where only 2 of 13 previous table sites escaped `|` in cell data).
 */

/** Escape pipe characters so they don't break markdown table cells. */
function escPipe(text: string): string {
    return text.replace(/\|/g, '\\|');
}

export type Align = 'left' | 'right' | 'center';

/**
 * Build a markdown table string from headers and rows.
 *
 * Every cell value is `String()`-coerced and pipe-escaped automatically.
 *
 * @param headers  Column header labels (determines column count).
 * @param rows     2-D array of cell values.
 * @param align    Optional per-column alignment (defaults to `'left'`).
 */
export function mdTable(
    headers: string[],
    rows: (string | number)[][],
    align?: Align[],
): string {
    const sep = headers.map((_, i) => {
        const a = align?.[i] ?? 'left';
        if (a === 'right')  return '------:';
        if (a === 'center') return ':------:';
        return '------';
    });
    const headerLine = `| ${headers.join(' | ')} |`;
    const sepLine    = `| ${sep.join(' | ')} |`;
    const dataLines  = rows.map(
        row => `| ${row.map(c => escPipe(String(c))).join(' | ')} |`,
    );
    return [headerLine, sepLine, ...dataLines].join('\n');
}

/**
 * Wrap content under a markdown heading with a blank line separator.
 *
 * @param title  Section heading text (without leading `#`).
 * @param body   Markdown body (e.g. from `mdTable()`).
 * @param level  Heading level (default 2 -> `##`).
 */
export function mdSection(title: string, body: string, level: number = 2): string {
    const hashes = '#'.repeat(level);
    return `${hashes} ${title}\n\n${body}`;
}
