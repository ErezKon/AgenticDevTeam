/**
 * Captured terminal output, rendered the way a terminal shows it (Plan 30-03).
 *
 * Test runners write for a TTY. Karma redraws its progress line with
 * `ESC[1A ESC[2K` after every spec and colours most lines; the Angular CLI
 * prints a spinner start line before each result line. Captured raw, the
 * 134-spec Karma run of the claudeopus5 project was 16 kB, almost all of it
 * progress redraws and escape sequences; rendered it is about 1.3 kB, with
 * the failure block and the summary intact.
 *
 * `renderTerminalOutput()` replays cursor movement and line erases, strips the
 * remaining escape sequences, collapses progress runs and drops known noise.
 * `summariseTestOutput()` then keeps the failure blocks and summary lines when
 * the rendered text is still longer than a budget.
 */

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * One terminal token: CSI `ESC [ params intermediates final` (groups 1 and 2), OSC
 * `ESC ] … BEL|ST`, a charset designation `ESC ( B`, any other `ESC x`, CR/LF/BS,
 * or another C0 control character. Text between tokens is printable.
 */
const TOKEN_RE = /\x1b\[([0-?]*)[ -\/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()*+].|\x1b[@-_]|[\r\n\b]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Lines that are noise in every captured Node run. Plan 30-07: also Node's colour warning,
 * printed when a tool sets a non-zero FORCE_COLOR for its children while NO_COLOR is set
 * (the shell tool sets NO_COLOR=1 and FORCE_COLOR=0), and the hint line after any Node warning.
 */
const NOISE_RES: RegExp[] = [
    /^Node\.js version v\d+\.\d+\.\d+ detected\.$/,
    /^Odd numbered Node\.js versions will not enter LTS status/,
    /^\(node:\d+\) Warning: The '.+' env is ignored due to the 'FORCE_COLOR' env being set\.$/,
    /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/,
];

/** Progress lines that redraw in place on a TTY; a run of consecutive ones keeps only the last. */
const PROGRESS_RES: RegExp[] = [
    /\bExecuted \d+ of \d+\b/,                   // Karma progress reporter
    /^\s*\d{1,3}% (?:building|sealing|emitting)\b/, // webpack progress
];

/** ora (Angular CLI) without a TTY prints `- <text>` when a spinner starts and a `✔`/`✖` line when it stops. */
const SPINNER_START_RE = /^- \S/;
const SPINNER_STOP_RE = /^[✔✖⚠ℹ] /;

/**
 * What a terminal would show for `raw`: `\r`, `\b`, cursor up/down/left/right/column
 * (`ESC[nA/B/C/D/G`) and line erases (`ESC[K`, `ESC[1K`, `ESC[2K`) are applied, every
 * other escape sequence (colours, modes, OSC) is dropped. Then consecutive progress lines
 * collapse into the last one, the Node odd-version warning and spinner start lines are
 * dropped, blank runs shrink to one blank line and trailing whitespace goes.
 */
export function renderTerminalOutput(raw: string): string {
    const lines: string[] = [''];
    let row = 0;
    let col = 0;
    const write = (text: string): void => {
        const line = lines[row].padEnd(col);
        lines[row] = line.slice(0, col) + text + line.slice(col + text.length);
        col += text.length;
    };
    const moveTo = (target: number): void => {
        row = Math.max(0, target);
        while (lines.length <= row) lines.push('');
    };
    const csi = (params: string, final: string): void => {
        const n = parseInt(params, 10);
        const count = n > 0 ? n : 1;
        if (final === 'A') moveTo(row - count);
        else if (final === 'B') moveTo(row + count);
        else if (final === 'C') col += count;
        else if (final === 'D') col = Math.max(0, col - count);
        else if (final === 'G') col = count - 1;
        else if (final === 'K') {
            const line = lines[row];
            lines[row] = n === 2 ? ''
                : n === 1 ? ' '.repeat(Math.min(col + 1, line.length)) + line.slice(col + 1)
                : line.slice(0, col);
        }
    };

    let last = 0;
    for (const m of raw.matchAll(TOKEN_RE)) {
        const at = m.index ?? 0;
        if (at > last) write(raw.slice(last, at));
        last = at + m[0].length;
        if (m[0] === '\n') { moveTo(row + 1); col = 0; }
        else if (m[0] === '\r') col = 0;
        else if (m[0] === '\b') col = Math.max(0, col - 1);
        else if (m[2]) csi(m[1], m[2]);
    }
    if (last < raw.length) write(raw.slice(last));
    return tidyLines(lines).join('\n');
}

function tidyLines(lines: string[]): string[] {
    const out: string[] = [];
    lines.forEach((raw, i) => {
        const line = raw.trimEnd();
        if (NOISE_RES.some(re => re.test(line))) return;
        if (SPINNER_START_RE.test(line) && SPINNER_STOP_RE.test(lines[i + 1] ?? '')) return;
        const prev = out[out.length - 1];
        if (!line && !prev) return;
        const progress = PROGRESS_RES.find(re => re.test(line));
        if (progress && prev !== undefined && progress.test(prev)) {
            out[out.length - 1] = line;
            return;
        }
        out.push(line);
    });
    while (out.length > 0 && !out[out.length - 1]) out.pop();
    return out;
}

// ─── Summarising ────────────────────────────────────────────────────────────

/**
 * Lines that open a failure block: Karma/Jasmine `FAILED`, Jest `●`, `✗ ✕ ×` marks, thrown errors, tsc,
 * assertion text, and (Plan 30-07) esbuild / Angular application-builder errors (`✘ [ERROR] TS2304: …`).
 */
const FAILURE_RE = /\bFAILED\b|\bFAIL\b|[✗✕×]|●|\bError:|\berror TS\d+|\[ERROR\]|\bExpected\b|AssertionError|npm ERR!/;

/** Summary lines of the common runners (Karma, Jest, Vitest, Mocha, pytest). */
const SUMMARY_RE = /^\s*(?:TOTAL:|Tests?:|Test Suites:|Test Files\b|Snapshots:|Time:|Ran all test suites|\d+ (?:passing|failing|pending)\b|=+ .*\b(?:passed|failed|errors?)\b.* =+$)|\bExecuted \d+ of \d+/;

/** A failure block is its opening line plus at most this many indented or blank lines. */
const BLOCK_LINES = 12;

/** Runners print their verdict last, so the last lines are always kept. */
const TAIL_LINES = 5;

/**
 * `text` within `maxChars`, keeping what a reader of a test run needs: every failure
 * block (`FAILED`, `✗`, `●`, `Error:`, `error TS…`, `Expected …` plus its indented
 * continuation), the summary lines and the last lines. Omitted runs are marked
 * `… [N line(s) omitted]`; when the kept lines are still too long, the middle goes.
 * Expects rendered text (`renderTerminalOutput()`); short text is returned unchanged.
 */
export function summariseTestOutput(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const lines = text.split('\n');
    const keep = new Set<number>();
    lines.forEach((line, i) => {
        if (SUMMARY_RE.test(line)) keep.add(i);
        if (!FAILURE_RE.test(line)) return;
        keep.add(i);
        for (let j = i + 1; j < lines.length && j <= i + BLOCK_LINES; j++) {
            if (lines[j].trim() && !/^\s/.test(lines[j])) break;
            keep.add(j);
        }
    });
    for (let i = Math.max(0, lines.length - TAIL_LINES); i < lines.length; i++) keep.add(i);

    const out: string[] = [];
    let omitted = 0;
    lines.forEach((line, i) => {
        if (!keep.has(i)) {
            omitted++;
            return;
        }
        if (omitted > 0) out.push(`… [${omitted} line(s) omitted]`);
        omitted = 0;
        out.push(line);
    });
    return clipMiddle(out.join('\n'), maxChars);
}

/** Keep the head (the first failures) and the tail (the verdict) of a summary that is still too long. */
function clipMiddle(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const marker = (omitted: number): string => `\n… [${omitted} chars omitted] …\n`;
    const budget = maxChars - marker(text.length).length;
    if (budget <= 0) return text.slice(text.length - maxChars);
    const head = Math.ceil(budget * 0.6);
    return text.slice(0, head) + marker(text.length - budget) + text.slice(text.length - (budget - head));
}
