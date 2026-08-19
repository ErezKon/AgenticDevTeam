/**
 * Diff helpers — exclusion specs and review-diff computation.
 *
 * Unifies the 4 copies of DIFF_EXCLUDE_SPECS and the diff-too-large
 * stat fallback logic.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { gitExec } from '../../utils/git-exec';

/** Generated-file exclusion pathspecs for git diff (mirrors git-tools.ts). */
export const DIFF_EXCLUDE_SPECS = [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'composer.lock', 'Gemfile.lock', 'Pipfile.lock', 'poetry.lock',
    'go.sum', 'Cargo.lock',
    '*.min.js', '*.min.css', '*.map', '*.snap',
    'dist/*', 'build/*', '.next/*',
].map(p => `':!${p}'`).join(' ');

/** Max chars for inline diff before switching to stat-based fallback. */
export const MAX_DIFF_CHARS = 25_000;

/**
 * Get a review-ready diff between base and head, falling back to stat
 * summary when the diff is too large.
 */
export function getReviewDiff(
    worktreeDir: string,
    baseRef: string,
    headRef: string,
    maxChars: number = MAX_DIFF_CHARS,
): string {
    const rawDiff = gitExec(worktreeDir, `diff ${baseRef}...${headRef} -- . ${DIFF_EXCLUDE_SPECS}`);

    if (!rawDiff || rawDiff.trim() === '' || rawDiff.startsWith('Error:')) {
        return rawDiff;
    }

    if (rawDiff.length <= maxChars) {
        return rawDiff;
    }

    // Diff too large — provide stat summary and instruct to use per-file tools
    const diffStat = gitExec(worktreeDir, `diff --stat ${baseRef}...${headRef} -- . ${DIFF_EXCLUDE_SPECS}`);
    return [
        `[DIFF TOO LARGE — ${rawDiff.length} chars. Showing file summary instead]\n`,
        diffStat,
        `\nUse the "git_diff_file" tool with a specific file path to review individual files.`,
        `Use the "git_diff_stat" tool to see the full list of changed files.`,
    ].join('\n');
}

/**
 * Get a diff suitable for embedding in a review message (wrapped in fenced block).
 */
export function getReviewDiffContent(
    worktreeDir: string,
    baseRef: string,
    headRef: string,
    maxChars: number = MAX_DIFF_CHARS,
): string {
    const rawDiff = gitExec(worktreeDir, `diff ${baseRef}...${headRef} -- . ${DIFF_EXCLUDE_SPECS}`);

    if (rawDiff.length <= maxChars) {
        return `\`\`\`diff\n${rawDiff}\n\`\`\``;
    }

    const diffStat = gitExec(worktreeDir, `diff --stat ${baseRef}...${headRef} -- . ${DIFF_EXCLUDE_SPECS}`);
    return [
        `[DIFF TOO LARGE — ${rawDiff.length} chars. Showing file summary instead]\n`,
        diffStat,
        `\nUse "git_diff_file" to review individual files.`,
    ].join('\n');
}
