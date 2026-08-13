# Sub-Plan 06 — PR Workflow: Never Lose Written Code (Partial Implementation)

**Status:** In progress  
**Date:** 2026-08-11  
**Started by:** Devin session  
**Last completed step:** Core files created, `pr-workflow.ts` partially rewritten  

---

## What has been implemented

### New files created

| File | Purpose | Status |
|------|---------|--------|
| `src/conductor/pr-failure.ts` | PR/git/GitHub error classifier (`PrFailureKind`, `classifyPrFailure`, `isFatalPrFailure`) | complete |
| `src/conductor/merge-resolve.ts` | Deterministic merge-conflict auto-resolution for lockfiles and `package.json` | complete |

### Config additions (`src/config.ts`)

Added under `// ─── PR Workflow / Work Preservation (Sub-Plan 06) ──────────────────────────`:

```ts
export const WORKTREE_SALVAGE_MAX
export const PR_SALVAGE_PATCHES
export const MERGE_CONFLICT_FIX_ATTEMPTS
export const ASSIGNMENT_MAX_ATTEMPTS
export const CONFIG_OWNERSHIP_SCAFFOLD_ONLY
```

### Utility updates

| File | Change | Status |
|------|--------|--------|
| `src/utils/git-exec.ts` | Added `gitExecVerbose()` returning `{ ok, stdout, stderr, code }` for diagnostic git errors | complete |
| `src/utils/github-local.ts` | Added `pulls.list` to `OctokitLike` and `createLocalGitHub` for PR reuse in local mode | complete |
| `src/utils/event-bus.ts` | Added `'pr:conflict'` and `'pr:salvage'` to `RunEventType` | complete |

### State additions (`src/conductor/state.ts`)

- Imported `CompletionEvidence` from `assignment-policy`.
- Added `completionEvidence: Annotation<CompletionEvidence[]>` (append reducer).
- Added `salvageBranches: Annotation<string[]>` (append reducer).

### Assignment-policy update (`src/conductor/assignment-policy.ts`)

- Added `CompletionEvidence` interface.
- Added `completedIdsWithEvidence()` — requires `merged === true` AND `filesChanged > 0` AND `gatePassed === true` AND declared modules present.
- Added `incompleteBugs()` — synthesises `INCOMPLETE-<assignmentId>` bugs for re-dispatch.
- Kept legacy `completedIdsFromPullRequests()` for backwards compatibility (tests still use it).

### `pr-workflow.ts` partial rewrite

- Imports updated for new modules/config.
- Added helpers:
  - `commitWorktree()` — durable commit+push with failure-safe subject line.
  - `salvageWorktree()` — exports `git format-patch` bundle + `README.md` to `<outputPath>/salvage/<slug>/`.
  - `evictStaleSalvageWorktrees()` — caps `.worktrees-failed/` at `WORKTREE_SALVAGE_MAX`.
  - `findExistingPR()` — calls `octokit.pulls.list` before creating PRs to reuse existing open PRs.
- Dev agent invocation (§1) now wrapped in `try/finally` with `commitWorktree()`.
- Gate-repair agent invocation now wrapped in `try/finally` with `commitWorktree()` and re-runs gates in a separate `try`.

---

## What still needs to be done in `pr-workflow.ts`

The file currently has the first two `try/finally` conversions but **four more agent invocation sites still need `finally` blocks**:

| # | Section | Current location | Required change |
|---|---------|------------------|-----------------|
| 3 | Per-reviewer fix (inside the reviewer loop) | lines ~1210 | Wrap `invokeDevAgent` in `try { ... } finally { commitWorktree(...) }` |
| 4 | Combined / no-progress retry fix | lines ~1360 | Same — `finally` commit |
| 5 | Escalation dev | lines ~1460 | Wrap escalation `invokeDevAgent` in `try/finally` with `commitWorktree` |

After that, the rest of `pr-workflow.ts` still needs:

1. **PR creation reuse path** — at the Octokit `pulls.create` catch, classify the error with `classifyPrFailure`, and if `pr-already-exists`, call `findExistingPR` and continue with the existing PR instead of failing.
2. **PR creation `auth` fail-fast** — if `classifyPrFailure` returns `auth` or `isFatalPrFailure`, throw immediately.
3. **Merge ladder rewrite** (`§4` currently rebases then falls through):
   - Replace `git rebase origin/<baseBranch>` with `git merge origin/<baseBranch> --no-edit`.
   - If merge succeeds, push and proceed.
   - If merge fails:
     - Run `resolveKnownConflicts()` for lockfiles / `package.json`.
     - If unresolved files remain, hand them to the owning dev agent for `MERGE_CONFLICT_FIX_ATTEMPTS` attempts.
     - If still unresolved, record `PrFailureKind: 'merge-conflict'`, call `salvageWorktree`, emit `pr:conflict`, set `prStatus = 'open'`, and do **not** delete the worktree.
4. **Worktree disposal rewrite** (`finally` block at end):
   - On `prStatus === 'merged'` → `git worktree remove` as today.
   - On failure → move worktree to `<gitRoot>/.worktrees-failed/<slug>` instead of deleting, then call `evictStaleSalvageWorktrees`.
   - Only delete remote branch on merge success.
5. **Evidence-based completion** — after merge, compute `filesChanged` from `git diff --name-only <baseRef>..HEAD`, count declared modules present, and store `CompletionEvidence` in the returned `PullRequest` or via `executePRWorkflow`.
6. **Output path plumbing** — `executePRWorkflow` input needs an `outputPath` parameter (or derive from `workspacePath`) so `salvageWorktree` knows where to write patches.
7. **Remove stale `gitExec` add/commit/push calls** inside `try` blocks where `commitWorktree()` in `finally` now handles it.

---

## What still needs to be done in `dispatcher.ts`

1. **Scaffold barrier** — partition branches into `scaffoldBranches` and the rest:
   - `scaffoldBranches`: branch name matches `/\/chore\/scaffold$/` **or** every assignment has `taskType === 'chore'`.
   - Run scaffold branches first, sequentially.
   - After each scaffold merge, call `syncWorkspaceToBranch(gitRoot, baseBranch, ...)` before creating feature worktrees.
2. **Inject implicit scaffold dependency** — every non-scaffold assignment should have scaffold assignment ids added to `dependsOn` before `topoSort` runs.
3. **File ownership / conflict pre-check**:
   - Before dispatching a batch, compute intersection of `moduleIds` across branches.
   - On overlap, serialise those branches and log `Serialising branches A and B — both own <path>`.
4. **Shared config ownership** — if `CONFIG_OWNERSHIP_SCAFFOLD_ONLY` is true, feature branches must not modify root `package.json`, `tsconfig*.json`, bundler configs, or lint configs. Enforce via the conductor (`pr-workflow` applies requested deps with `npm pkg set` instead of letting devs write `package.json`).
5. **Plumb `outputPath`** through `dispatchDevelopers` to `executePRWorkflow`.

---

## What still needs to be done in `nodes.ts`

1. `developmentNode` must pass `outputPath` to `dispatchDevelopers`.
2. `developmentNode` should consume `CompletionEvidence` and `incompleteBugs` from `dispatchDevelopers` and append `INCOMPLETE-*` bugs to state.
3. `finalizeNode` should list `salvageBranches` / `.worktrees-failed/` directories in the manifest summary.
4. `intakeNode` (or `developmentNode`) should prune `.worktrees-failed/` before dispatching, alongside existing worktree sweep.

---

## Tests still to write

| Test file | What to verify |
|-----------|----------------|
| `tests/pr-failure.test.ts` | `classifyPrFailure` matches all literal payloads from §1c/§1d; `auth` is fatal; `rate-limit` / `network` are retryable |
| `tests/pr-workflow-durability.test.ts` | Mock `invokeDevAgent` writes a file then throws → file committed; review-fix dev writes file then throws → file committed; failed merge → worktree moved to `.worktrees-failed/`, patch written; successful merge → worktree removed |
| `tests/dispatcher-scaffold-barrier.test.ts` | Scaffold runs alone first; `syncWorkspaceToBranch` invoked before feature worktrees; implicit dependency injected; overlapping `moduleIds` serialise branches |
| `tests/merge-resolve.test.ts` | `package-lock.json` conflict auto-resolved to base + regenerate; `package.json` conflict unions deps, preserves base scripts; genuine source conflict stays unresolved |
| `tests/assignment-completion.test.ts` | Merged PR with 0 real changes → not completed; only docs/metadata changes → not completed; 5 source files + passing gate → completed; assignment with 3 attempts gets no fourth dispatch |
| `tests/github-local.test.ts` (extend) | `pulls.list({ head, state: 'open' })` returns matching PR for reuse path |

---

## Documentation still to update

- `README.md` — add PR Workflow / Work Preservation section documenting scaffold barrier, salvage patches, merge ladder, config ownership, and new env vars.
- `AI_Context.md` — update PR workflow step list (currently 11 steps) to reflect the merge ladder and durable commit changes.
- `.env.example` — add the 5 new env vars (`WORKTREE_SALVAGE_MAX`, `PR_SALVAGE_PATCHES`, `MERGE_CONFLICT_FIX_ATTEMPTS`, `ASSIGNMENT_MAX_ATTEMPTS`, `CONFIG_OWNERSHIP_SCAFFOLD_ONLY`).

---

## Verification checklist (to run when complete)

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run test:unit` green
- [ ] `grep -n "worktree remove" src/conductor/pr-workflow.ts` only on success path
- [ ] `grep -n "rebase origin/" src/conductor/pr-workflow.ts` returns nothing
- [ ] Every `invokeDevAgent` / `invokeAgent` call in `pr-workflow.ts` followed by `finally { commitWorktree(... }`
- [ ] PR-creation 422 for existing head reuses the PR
- [ ] `.env.example` updated
- [ ] `README.md` and `AI_Context.md` updated

---

## Notes for resumption

The safest place to continue is **item 3 in `pr-workflow.ts` (per-reviewer fix `finally` block)**. Once all five agent sites are converted, proceed to the merge ladder and worktree disposal, then the dispatcher changes, then tests, then docs.

The new helper functions (`commitWorktree`, `salvageWorktree`, `evictStaleSalvageWorktrees`, `findExistingPR`) are already in `pr-workflow.ts` and just need to be wired at the remaining sites.

No verification has been run yet because the implementation is incomplete; the next session should run `npx tsc --noEmit` as soon as the `pr-workflow.ts` rewrite is finished to catch type errors early.
