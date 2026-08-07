import { MAX_TOOL_RESULT_CHARS } from '../../config';

/**
 * Clip a tool result to a character budget, keeping head and tail.
 * The middle is replaced by a marker so the model knows content is missing
 * and can request a specific slice instead of assuming it saw everything.
 *
 * @param result    The raw tool output string.
 * @param label     A short label included in the omission marker (e.g. "read_file src/App.tsx").
 * @param maxChars  Character budget (default: MAX_TOOL_RESULT_CHARS from config).
 * @param headRatio Fraction of the budget allocated to the head (default: 0.6).
 *                  Use a lower value (e.g. 0.2) for shell output where the tail
 *                  (error messages / test failures) matters most.
 */
export function truncateToolResult(
    result: string,
    label: string,
    maxChars: number = MAX_TOOL_RESULT_CHARS,
    headRatio: number = 0.6,
): string {
    if (result.length <= maxChars) return result;
    const headSize = Math.floor(maxChars * headRatio);
    const tailSize = maxChars - headSize;
    const omitted = result.length - headSize - tailSize;
    return [
        result.slice(0, headSize),
        `\n... [${label}: ${omitted} chars omitted of ${result.length} total.`,
        ` Use read_file with offset/limit, or search_code, to see a specific region.] ...\n`,
        result.slice(-tailSize),
    ].join('');
}
