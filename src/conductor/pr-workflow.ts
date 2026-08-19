/**
 * PR Workflow — backward-compatible re-export shim.
 *
 * The implementation has been decomposed into focused modules under
 * `src/conductor/pr/` (Sub-Plan 25-08). This file re-exports the
 * public API so that existing consumers continue to work unchanged.
 *
 * @see ./pr/index.ts  for the full barrel
 */

// Types
export type { PRWorkflowInput, PRWorkflowResult } from './pr/orchestrator';

// Orchestrator
export { executePRWorkflow } from './pr/orchestrator';

// GitHub operations (consumed by nodes/development.ts, nodes/intake.ts, singleton-rehydration.ts)
export {
    setLocalBareRepoPath,
    getOctokit,
    findExistingPR,
    retryFailedPRCreation,
    PrIdentityMismatchError,
    postComment,
    createOrReusePR,
    createPRViaCurl,
    mergePr,
} from './pr/pr-github';

// Commit (consumed internally + by gate-integrity tests)
export { commitWorktree } from './pr/commit';

// Worktree lifecycle
export {
    createBranchWorktree,
    disposeWorktree,
    salvageWorktree,
    evictStaleSalvageWorktrees,
} from './pr/worktree';

// PR body builders
export { buildPRTitle, buildPRDescription } from './pr/pr-body';

// Dev prompts
export {
    workspaceContextBlock,
    HARD_CONSTRAINTS,
    buildRepairMessage,
    buildFixMessage,
    buildEscalationMessage,
    buildStrongFixerMessage,
    buildConflictMessage,
} from './pr/dev-prompts';

// Diff helpers
export { DIFF_EXCLUDE_SPECS, getReviewDiff, getReviewDiffContent } from './pr/diff';

// Agent invocation
export {
    parseDevResult,
    invokeDevAgent,
    invokeReviewerAgent,
    getModelForRank,
    resolveBaseRef,
} from './pr/agent-invoke';

// Gates
export { captureBaseline, runIntegrityGate, archiveDeletedTest } from './pr/gates';

// Review loop
export { runReviewLoop } from './pr/review-loop';

// Escalation
export { runEscalation } from './pr/escalation';

// Strong fixer
export { runStrongFixer } from './pr/strong-fixer';

// Merge ladder
export { integrateBase } from './pr/merge-ladder';
