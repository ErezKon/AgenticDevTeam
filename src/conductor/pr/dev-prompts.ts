/**
 * Prompt fragments and message builders for dev/reviewer/fixer agents.
 *
 * Eliminates ~150 LOC of duplicated HARD CONSTRAINTS, workspace context,
 * and fix/repair/escalation message construction.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */

// ─── Shared prompt fragments ────────────────────────────────────────────────

/**
 * Workspace context preamble — tells agents where they are and what not to do.
 */
export function workspaceContextBlock(projectSlug: string, branchName: string): string {
    return [
        `\n## Project Slug: ${projectSlug}`,
        `\n## Your Branch: ${branchName}`,
        `\nYou are already on this branch. Do NOT create or switch branches — your workspace is isolated for this branch.`,
        `\n## IMPORTANT: Workspace Context`,
        `Your current working directory IS the project root.`,
        `Do NOT prefix paths with "generated-projects/${projectSlug}/" — all file operations are relative to the project root.`,
    ].join('\n');
}

/**
 * Mechanical constraints shared by repair, fix, escalation, strong-fixer,
 * and conflict-resolution messages.
 */
export const HARD_CONSTRAINTS = [
    ``,
    `HARD CONSTRAINTS (enforced mechanically):`,
    `- Do NOT modify \`scripts\` in any package.json (writes are REFUSED by your tools).`,
    `- Do NOT delete, skip, or weaken tests. Do NOT add trivial tests for non-product code.`,
    `- Do NOT relax tsconfig/eslint strictness or add source paths to .gitignore.`,
    `- Fix the SOURCE CODE, not the build/test configuration.`,
].join('\n');

/**
 * Extended hard constraints for repair messages (includes additional rules about
 * creating missing files and fixing imports).
 */
export const HARD_CONSTRAINTS_REPAIR = [
    ``,
    `HARD CONSTRAINTS — these are enforced mechanically, not on trust:`,
    `- You MUST NOT modify \`scripts\` in any package.json. The \`build\`, \`test\`, \`lint\` and`,
    `  \`typecheck\` commands are frozen. Writes to protected config files are REFUSED by your tools.`,
    `- You MUST NOT delete, rename, skip (\`it.skip\`, \`xit\`, \`--passWithNoTests\`) or weaken any test.`,
    `- You MUST NOT add a test whose subject is not part of the application (a test for a helper that`,
    `  nothing imports does not count and will be rejected).`,
    `- You MUST NOT remove dependencies, remove \`workspaces\`, relax \`tsconfig\` strictness, or add`,
    `  entries to \`.gitignore\`/eslint ignore files.`,
    `- If the build fails because a file is missing, CREATE THE MISSING FILE.`,
    `- If the build fails because an import path is wrong, FIX THE IMPORT.`,
    `Any of the above is detected by a baseline diff; the change is reverted and the PR is blocked.`,
].join('\n');

// ─── Message builders ───────────────────────────────────────────────────────

/**
 * Build a repair message for a dev agent when quality gates fail.
 */
export function buildRepairMessage(
    contextPrompt: string,
    projectSlug: string,
    branchName: string,
    failDetails: string,
): string {
    return [
        contextPrompt,
        workspaceContextBlock(projectSlug, branchName),
        `\n## Failing Quality Gate Steps\n\n${failDetails}`,
        `\n## Instructions`,
        `Fix the SOURCE CODE so that the project's EXISTING build, lint and test commands pass unchanged.`,
        HARD_CONSTRAINTS_REPAIR,
    ].join('\n');
}

/**
 * Build a fix message for addressing review comments.
 */
export function buildFixMessage(
    contextPrompt: string,
    projectSlug: string,
    branchName: string,
    commentsJson: string,
): string {
    return [
        contextPrompt,
        workspaceContextBlock(projectSlug, branchName),
        `\nYou are already on this branch. Do NOT switch branches. Fix the review comments below.`,
        `\n## Review Comments to Fix\n\n${commentsJson}`,
        `\n## Instructions`,
        `Address ALL review comments. For each comment:`,
        `1. Read the file and understand the issue.`,
        `2. Make the fix.`,
        `3. Commit with a message like "fix: address review comment — <description>".`,
        `4. Push when done.`,
        HARD_CONSTRAINTS,
    ].join('\n');
}

/**
 * Build an escalation message for a senior dev taking over.
 */
export function buildEscalationMessage(
    contextPrompt: string,
    projectSlug: string,
    branchName: string,
    criticalCommentsJson: string,
): string {
    return [
        contextPrompt,
        workspaceContextBlock(projectSlug, branchName),
        `\n## Escalation: You are a SENIOR developer taking over from a lower-rank developer.`,
        `\n## Unresolved CRITICAL Comments\n\n${criticalCommentsJson}`,
        `\n## Instructions`,
        `1. Fix ALL CRITICAL review comments listed above.`,
        `2. Review the ENTIRE codebase on this branch for quality issues.`,
        `3. Fix any additional issues you find.`,
        `4. Commit all changes when done.`,
        HARD_CONSTRAINTS,
    ].join('\n');
}

/**
 * Build a strong-fixer message for a senior expert dev.
 */
export function buildStrongFixerMessage(
    contextPrompt: string,
    projectSlug: string,
    branchName: string,
    prNumber: number,
    prTitle: string,
    prBody: string,
    allCommentsJson: string,
    truncatedDiff: string,
    gateMarkdown: string,
    integrityMarkdown: string,
): string {
    return [
        `## STRONG FIXER — PR #${prNumber}: ${prTitle}`,
        `\nYou are a SENIOR EXPERT developer taking over a PR that has exhausted its review iterations.`,
        `Your job: read the task, understand the review feedback, and fix ALL issues to get this PR merged.`,
        `\n## Original Task\n${contextPrompt}`,
        workspaceContextBlock(projectSlug, branchName),
        `\n## PR Description\n${prBody.slice(0, 3000)}`,
        `\n## All Review Comments\n${allCommentsJson}`,
        `\n## Current Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
        gateMarkdown,
        integrityMarkdown,
        `\n## Instructions`,
        `1. Read and understand ALL review comments.`,
        `2. Fix every issue raised by reviewers.`,
        `3. Ensure quality gates will pass (build, lint, test).`,
        `4. Do NOT weaken tests or build configuration.`,
        `5. Commit all changes when done.`,
        HARD_CONSTRAINTS,
    ].join('\n');
}

/**
 * Build a conflict resolution message.
 */
export function buildConflictMessage(
    contextPrompt: string,
    branchName: string,
    baseBranch: string,
    conflictDetails: string,
): string {
    return [
        contextPrompt,
        `\n## Merge Conflict Resolution`,
        `\nYour branch \`${branchName}\` has merge conflicts with \`${baseBranch}\`.`,
        `\n## Conflicted Files\n\n${conflictDetails}`,
        `\n## Instructions`,
        `Resolve ALL conflict markers (<<<<<<< / ======= / >>>>>>>) in the listed files.`,
        `Keep YOUR changes where they represent intended functionality.`,
        `Keep BASE changes for shared config (package.json scripts, tsconfig).`,
        `After resolving, stage all files with git add.`,
    ].join('\n');
}
