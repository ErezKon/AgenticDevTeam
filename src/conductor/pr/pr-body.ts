/**
 * PR title and description builders.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import { getDevAgent } from '../../agents/developers/registry';
import type { Assignment, FileChange } from '../../agents/_shared/base-schemas';

/**
 * Build a concise PR title from assignments and task type.
 */
export function buildPRTitle(assignments: Assignment[], taskType: string, projectSlug: string): string {
    const prefix = taskType === 'bug' ? 'fix' : taskType === 'refactor' ? 'refactor' : 'feat';
    let desc: string;
    if (assignments.length === 1) {
        desc = assignments[0].description.split('.')[0].trim();
    } else {
        // Multiple assignments — summarize
        const storyIds = [...new Set(assignments.map(a => a.storyId))];
        desc = `${assignments[0].description.split('.')[0].trim()} (${storyIds.join(', ')})`;
    }
    // Strip backticks and truncate to 80 chars on word boundary
    desc = desc.replace(/`/g, '');
    if (desc.length > 80) {
        desc = desc.slice(0, 77).replace(/\s+\S*$/, '') + '...';
    }
    return `[${projectSlug}] ${prefix}: ${desc}`;
}

/**
 * Build a structured PR description with task summary, actions, and changes.
 */
export function buildPRDescription(
    assignments: Assignment[],
    fileChanges: FileChange[],
    taskType: string,
    currentState?: string,
    authorAgentId?: string,
): string {
    const sections: string[] = [];

    // Author attribution
    if (authorAgentId) {
        const authorEntry = getDevAgent(authorAgentId);
        const authorLabel = authorEntry ? `${authorEntry.name} (${authorAgentId})` : authorAgentId;
        sections.push(`**Opened by ${authorLabel}**\n`);
    }

    // Task summary
    sections.push('## Task Summary\n');
    for (const a of assignments) {
        sections.push(`- **${a.id}** [${a.priority}/${a.complexity}]: ${a.description}`);
    }

    // Derived actions
    sections.push('\n## Derived Actions\n');
    const storyIds = [...new Set(assignments.map(a => a.storyId))];
    sections.push(`Stories covered: ${storyIds.join(', ')}`);
    sections.push(`Developers involved: ${[...new Set(assignments.map(a => a.devAgentId))].join(', ')}`);

    // Current state (for bug/fix/refactor)
    if (['bug', 'fix', 'refactor'].includes(taskType) && currentState) {
        sections.push('\n## Current State\n');
        sections.push(currentState);
    }

    // Changes made
    sections.push('\n## Changes Made\n');
    if (fileChanges.length > 0) {
        for (const fc of fileChanges) {
            sections.push(`- **${fc.action}** \`${fc.path}\` — ${fc.summary}`);
        }
    } else {
        sections.push('_(changes will be listed after development)_');
    }

    return sections.join('\n');
}
