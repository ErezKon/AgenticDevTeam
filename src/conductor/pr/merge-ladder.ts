/**
 * Merge ladder — base integration and conflict resolution.
 *
 * Extracted from pr-workflow.ts (Sub-Plan 25-08).
 */
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../../utils/logger';
import { gitExec, gitExecVerbose, gitPush } from '../../utils/git-exec';
import { emitRunEvent } from '../../utils/event-bus';
import { resolveKnownConflicts, listConflictedFiles } from '../merge-resolve';
import { buildDevAgent } from '../../agents/developers/dev-agent.builder';
import { getDevAgent } from '../../agents/developers/registry';
import { resolveConventionFiles } from '../../utils/coding-conventions';
import { MERGE_CONFLICT_FIX_ATTEMPTS } from '../../config';
import { commitWorktree } from './commit';
import { invokeDevAgent, getModelForRank } from './agent-invoke';
import { buildConflictMessage } from './dev-prompts';
import type { Assignment, GitContext, TechDecision } from '../../agents/_shared/base-schemas';
import type { DevRank } from '../../agents/_shared/persona';

const log = getLogger('[PR-Workflow]', 135);

export interface IntegrateBaseResult {
    resolved: boolean;
}

/**
 * Integrate base branch changes into the feature branch.
 * Handles merge conflicts via auto-resolution and dev-agent fallback.
 */
export async function integrateBase(
    worktreeWorkspace: string,
    branchName: string,
    baseBranch: string,
    projectSlug: string,
    primaryStoryId: string,
    assignments: Assignment[],
    contextPrompt: string,
    apiKey: string,
    gitContext: GitContext | null | undefined,
    techStack: TechDecision[] | undefined,
    isMaintainMode: boolean | undefined,
    respawnCtx: { worktreeDir: string; baseRef: string },
): Promise<IntegrateBaseResult> {
    gitExec(worktreeWorkspace, `fetch origin ${baseBranch}`);

    // Check if already up to date
    const isAncestor = gitExecVerbose(worktreeWorkspace, `merge-base --is-ancestor origin/${baseBranch} HEAD`);
    if (isAncestor.ok) {
        return { resolved: true };
    }

    // Need to integrate base changes
    const mergeResult = gitExecVerbose(worktreeWorkspace, `merge origin/${baseBranch} --no-edit`);
    if (mergeResult.ok) {
        gitPush(worktreeWorkspace, branchName, gitContext);
        return { resolved: true };
    }

    // Merge failed — attempt auto-resolution
    log.warn(`Merge conflict on ${branchName}, attempting auto-resolution...`);
    const conflicted = listConflictedFiles(worktreeWorkspace);
    let resolved = false;

    if (conflicted.length > 0) {
        const resolution = resolveKnownConflicts(worktreeWorkspace, conflicted, `origin/${baseBranch}`);
        if (resolution.unresolved.length === 0) {
            // All conflicts auto-resolved
            gitExec(worktreeWorkspace, `commit --no-edit`);
            resolved = true;
            log.info(`All ${resolution.resolved.length} conflict(s) auto-resolved`);
        } else {
            // Some unresolved — give dev agent a chance
            log.warn(`${resolution.unresolved.length} conflict(s) need manual resolution: ${resolution.unresolved.join(', ')}`);
            for (let attempt = 0; attempt < MERGE_CONFLICT_FIX_ATTEMPTS; attempt++) {
                try {
                    const primaryDevId = assignments[0].devAgentId;
                    const primaryEntry = getDevAgent(primaryDevId);
                    if (!primaryEntry) break;

                    const conflictConventions = resolveConventionFiles(primaryEntry.languages, techStack);
                    const buildConflictFn = () => buildDevAgent(apiKey, primaryEntry, worktreeWorkspace, gitContext, baseBranch, conflictConventions, isMaintainMode);
                    const conflictAgent = buildConflictFn();

                    // Read conflict markers (capped)
                    const conflictDetails = resolution.unresolved.map(f => {
                        try {
                            const content = fs.readFileSync(path.join(worktreeWorkspace, f), 'utf-8');
                            return `### ${f}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``;
                        } catch { return `### ${f}\n(cannot read)`; }
                    }).join('\n\n');

                    const conflictMsg = buildConflictMessage(contextPrompt, branchName, baseBranch, conflictDetails);

                    const conflictModel = getModelForRank(primaryEntry.rank as DevRank);
                    try {
                        await invokeDevAgent(conflictAgent, conflictMsg, `conflict-${primaryEntry.id}-${branchName}`, primaryEntry.id, conflictModel, buildConflictFn, respawnCtx);
                    } catch (devConflictErr: any) {
                        log.warn(`Dev conflict resolution attempt ${attempt + 1} failed: ${devConflictErr.message}`);
                    } finally {
                        commitWorktree(worktreeWorkspace, branchName, projectSlug, primaryStoryId, 'fix',
                            `resolve merge conflicts (attempt ${attempt + 1})`, gitContext);
                    }

                    // Check if conflicts are resolved
                    const stillConflicted = listConflictedFiles(worktreeWorkspace);
                    if (stillConflicted.length === 0) {
                        resolved = true;
                        log.info(`Merge conflicts resolved by dev agent (attempt ${attempt + 1})`);
                        break;
                    }
                } catch (conflictErr: any) {
                    log.error(`Conflict resolution attempt ${attempt + 1} failed: ${conflictErr.message}`);
                }
            }
        }
    }

    if (!resolved) {
        log.error(`Cannot resolve conflicts for ${branchName}`);
        emitRunEvent('pr:conflict', { branch: branchName, baseBranch });
        return { resolved: false };
    }

    gitPush(worktreeWorkspace, branchName, gitContext);
    return { resolved: true };
}
