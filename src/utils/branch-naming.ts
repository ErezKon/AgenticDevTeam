/**
 * Canonical branch-naming and slug helpers.
 *
 * Consolidates the 4+ inline slugify implementations and 7+ hard-coded
 * `'project/'` prefix literals into a single source of truth.
 *
 * Fixes the continue-run slug mismatch bug where git-reconciliation.ts
 * and state-collector.ts used a different truncation/leading-strip policy
 * than the main intake path.
 */

/** Branch prefix for system (project-level) branches. */
export const SYSTEM_BRANCH_PREFIX = 'project/';

/**
 * Slugify a string for use in branch names and identifiers.
 *
 * - Lowercases
 * - Replaces non-alphanumeric runs with a single hyphen
 * - Strips leading and trailing hyphens
 * - Truncates to `maxLen` characters (default 50)
 */
export function slugify(text: string, maxLen: number = 50): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, maxLen);
}

/**
 * Build a system branch name from a system/project name.
 *
 * Example: `systemBranch('My App')` -> `'project/my-app'`
 */
export function systemBranch(systemName: string): string {
    return `${SYSTEM_BRANCH_PREFIX}${slugify(systemName)}`;
}

/**
 * Extract the project slug from a system branch name.
 *
 * Example: `projectSlugFromBranch('project/my-app')` -> `'my-app'`
 */
export function projectSlugFromBranch(branch: string): string {
    return branch.replace(new RegExp(`^${escapeRegex(SYSTEM_BRANCH_PREFIX)}`), '');
}

/**
 * Build a feature branch name.
 *
 * Example: `featureBranch('my-app', 'STORY-1', 'add login')` ->
 *          `'my-app/feature/story-1-add-login'`
 */
export function featureBranch(projectSlug: string, storyKey: string, description: string): string {
    return `${projectSlug}/feature/${slugify(storyKey)}-${slugify(description)}`;
}

/**
 * Check whether a branch name is a system (project-level) branch.
 */
export function isSystemBranch(branchName: string): boolean {
    return branchName.startsWith(SYSTEM_BRANCH_PREFIX);
}

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
