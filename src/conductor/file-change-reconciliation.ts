/**
 * File change reconciliation — ground truth vs agent claims.
 *
 * Sub-Plan 08 §7: Phantom fileChanges (index PART A11) corrupt every
 * downstream metric and mislead reviewers.  This module reconciles agent-
 * claimed fileChanges against the worktree and drops phantoms.
 */
import * as fs from 'fs';
import * as path from 'path';
import { gitExec } from '../utils/git-exec';
import { getLogger } from '../utils/logger';
import type { FileChange } from '../agents/_shared/base-schemas';

const log = getLogger('[file-reconcile]', 178);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconciliationResult {
    /** Verified file changes (exist on disk). */
    verified: FileChange[];
    /** Phantom file changes (claimed by agent, not on disk). */
    phantoms: FileChange[];
    /** Files on disk not claimed by the agent. */
    unreported: FileChange[];
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Reconcile agent-claimed fileChanges against the worktree.
 *
 * 1. `git diff --name-only HEAD` + `git ls-files --others --exclude-standard`
 *    gives the set of files actually changed on disk.
 * 2. Agent claims that don't match any actual file → phantom (dropped).
 * 3. Actual files not claimed → unreported (added with summary '(unreported by agent)').
 */
export function reconcileFileChanges(
    worktree: string,
    claimed: FileChange[],
    baseBranch?: string,
): ReconciliationResult {
    // Get actual changed files from git
    // Plan 25-04 §11: guard against error strings from gitExec — they
    // look like filenames if not filtered, corrupting the reconciliation.
    const actualPaths = new Set<string>();
    try {
        const diffRef = baseBranch ? `${baseBranch}..HEAD` : 'HEAD';
        const diffOutput = gitExec(worktree, `diff --name-only ${diffRef}`);
        if (diffOutput && !diffOutput.startsWith('Error:')) {
            for (const line of diffOutput.split('\n').filter(Boolean)) {
                actualPaths.add(line);
            }
        }
    } catch { /* new repo with no commits — fall through to ls-files */ }

    try {
        const untrackedOutput = gitExec(worktree, 'ls-files --others --exclude-standard');
        if (untrackedOutput && !untrackedOutput.startsWith('Error:')) {
            for (const line of untrackedOutput.split('\n').filter(Boolean)) {
                actualPaths.add(line);
            }
        }
    } catch { /* ignore */ }

    // Also check via fs.existsSync for robustness
    const verified: FileChange[] = [];
    const phantoms: FileChange[] = [];

    for (const fc of claimed) {
        const onDisk = actualPaths.has(fc.path) || fs.existsSync(path.join(worktree, fc.path));
        if (onDisk) {
            verified.push(fc);
        } else {
            phantoms.push(fc);
        }
    }

    // Find unreported files (on disk but not claimed)
    const claimedPaths = new Set(claimed.map(fc => fc.path));
    const unreported: FileChange[] = [];
    for (const p of actualPaths) {
        if (!claimedPaths.has(p)) {
            unreported.push({
                path: p,
                action: 'created',
                summary: '(unreported by agent)',
                storyId: claimed[0]?.storyId ?? 'UNKNOWN',
                agentId: claimed[0]?.agentId ?? 'UNKNOWN',
            });
        }
    }

    // Log the reconciliation
    if (phantoms.length > 0 || unreported.length > 0) {
        log.warn(
            `Reconciliation: ${verified.length} verified, ${phantoms.length} phantom, ${unreported.length} unreported`,
        );
        if (phantoms.length > 0) {
            log.warn(`Phantom files: ${phantoms.map(f => f.path).join(', ')}`);
        }
    }

    return { verified, phantoms, unreported };
}
