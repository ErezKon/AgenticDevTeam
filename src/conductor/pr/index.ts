/**
 * PR workflow barrel — re-exports all public symbols.
 *
 * Consumers import from this module:
 *   import { executePRWorkflow, ... } from './pr-workflow';
 *   or
 *   import { executePRWorkflow, ... } from './pr';
 */

// Types
export type { PRWorkflowInput, PRWorkflowResult } from './orchestrator';

// Orchestrator
export { executePRWorkflow } from './orchestrator';

// GitHub operations
export {
    setLocalBareRepoPath,
    getOctokit,
    findExistingPR,
    retryFailedPRCreation,
    PrIdentityMismatchError,
    postComment,
} from './pr-github';

// Commit
export { commitWorktree } from './commit';

// Worktree
export {
    createBranchWorktree,
    disposeWorktree,
    salvageWorktree,
    evictStaleSalvageWorktrees,
} from './worktree';

// PR body builders (pure, unit-testable)
export { buildPRTitle, buildPRDescription } from './pr-body';

// Dev prompts (pure, unit-testable)
export {
    workspaceContextBlock,
    HARD_CONSTRAINTS,
    buildRepairMessage,
    buildFixMessage,
    buildEscalationMessage,
    buildStrongFixerMessage,
    buildConflictMessage,
} from './dev-prompts';

// Diff helpers
export { DIFF_EXCLUDE_SPECS, getReviewDiff, getReviewDiffContent } from './diff';

// Agent invocation (pure functions exported for testing)
export { parseDevResult, getModelForRank, resolveBaseRef } from './agent-invoke';

// Gates
export { captureBaseline, runIntegrityGate, archiveDeletedTest } from './gates';
