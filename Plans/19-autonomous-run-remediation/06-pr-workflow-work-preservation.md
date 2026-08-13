# Sub-Plan 06 — PR Workflow: Never Lose Written Code

**Depends on:** nothing hard. Consumes `assignment.moduleIds` from Sub-Plan 05 if available (§5 degrades
gracefully without it).
**Goal:** stop destroying code that agents actually wrote. In `pacman8` the entire game was written, twice, and
deleted, twice.

---

## 1. Evidence

### 1a. The `index.css` that broke the delivered build

`pacman8 run.log`:

```
1439  WARN No new commits since the last review (HEAD af3fcad3) — skipping re-review (no-progress 1/2)
1466  [fs-tools] write_file: src/index.css          ← written at 19:19:21
1607  ERROR Fix attempt failed: Recursion limit of 58 reached without hitting a stop condition.
1613  WARN No new commits since the last review (HEAD af3fcad3) — skipping re-review (no-progress 2/2)
1617  WARN Max review iterations reached. Merging PR #1 despite pending reviews.
1624  INFO PR #1 merged to project/pacman8
1626  INFO Cleaned up worktree: pacman8-chore-scaffold
```

`HEAD` is `af3fcad3` both before and after the write — **the file was never committed** — and then the worktree was
deleted. The delivered `src/main.tsx` still contains `import "./index.css"`. This single event is why the product
does not compile.

**Cause:** in `src/conductor/pr-workflow.ts` the review-fix commit is *inside* the `try`:

```
1088-1093   gitExec(worktreeWorkspace, 'add .');  … commit … gitPush(…)      ← per-reviewer fix
1192-1197   gitExec(worktreeWorkspace, 'add .');  … commit … gitPush(…)      ← combined fix
1198        } catch (err: any) {                                             ← swallows; nothing committed
1282-1287   gitExec(worktreeWorkspace, 'add .');  … commit … gitPush(…)      ← escalation
```

If `invokeDevAgent` throws (recursion limit, connection error, loop-guard poisoning), the `add`/`commit`/`push`
lines are never reached. The post-dev commit at `:608-613` *is* outside its try, which is why scaffold work
survived — but every fix, repair and escalation path is unprotected.

### 1b. The conflict that destroyed the whole game

The dispatcher put `chore/scaffold` and `feature/us-001-pacman-movement` in the **same parallel batch, from the
same commit** (`run.log 86-94`, both `HEAD is now at e5a0812`), and both agents wrote the same files:

```
101  write_file: package.json      ← principal-frontend (scaffold)
114  write_file: tsconfig.json     ← principal-frontend
119  write_file: package.json      ← senior-frontend  (feature)
125  write_file: tsconfig.json     ← senior-frontend
227  write_file: .eslintrc.cjs     ← principal-frontend
310  write_file: .eslintrc.cjs     ← senior-frontend
588  write_file: package.json      ← feature again
594  write_file: tsconfig.json     ← feature again
```

Scaffold merged at 19:21:33. Eight minutes later:

```
2162  WARN PR #2 has unresolved CRITICALs after 5 iterations. Escalating developer...
2163  WARN No escalation candidate found — proceeding with merge despite CRITICALs
2164  WARN Max review iterations reached. Merging PR #2 despite pending reviews.
2165  WARN Rebase failed for pacman8/feature/us-001-pacman-movement, attempting merge commit instead
2166  ERROR Cannot resolve conflicts for pacman8/feature/us-001-pacman-movement: Error:      ← empty message
2169  ERROR Merge failed: Pull Request has merge conflicts
2170  INFO Cleaned up worktree: pacman8-feature-us-001-pacman-movement
```

PR #2 contained `src/hooks/useInputHandler.ts`, `src/engine/GameEngine.ts`, `src/InputHandler.ts`,
`src/GameEngine.ts`, `src/types/Direction.ts` and their tests. All gone. `retroboard3` lost PRs **#3, #5, #8, #11**
the same way — and those four were the ones carrying the real `packages/frontend` implementation.

### 1c. The 422 retry deadlock

Rounds 2, 3 and 4 re-created the worktree, ran 7–13 minutes of dev work, wrote real code
(`run.log 5349: write_file: src/hooks/useInputHandler.ts`), then:

```
3212  INFO Creating PR: "[pacman8] feat: Implement InputHandler module (React hook)..."
3215  WARN Octokit PR creation failed (422), falling back to curl
3216  INFO Cleaned up worktree: pacman8-feature-us-001-pacman-movement       ← work destroyed
3641  ERROR PR workflow failed: Error: GitHub API error: Validation Failed
      ([{"resource":"PullRequest","code":"custom","message":"A pull request already exists for
        ErezSCE:pacman8/feature/us-001-pacman-movement."}])
```

Identical at `5194-5199` and `5767-5768`. `retroboard3`: `run.log 14252, 15229, 15622, 15631, 15632, 15796,
15859, 16093, 16236`. Note the ordering — **cleanup at 3216 precedes the error at 3641** — so the failure path
destroys the work before anyone can look at it. `pr-workflow.ts:771-787` never checks for an existing open PR, and
`createPRViaCurl` does not handle 422 either.

### 1d. Other observed failure modes

- `No commits between project/retroboard3 and retroboard3/feature/us-007-reconnect` (`run.log 10613`) — an
  assignment completed with zero commits. There *is* a guard at `pr-workflow.ts:709-736` producing a
  `PR-SKIPPED-*` record, but it did not fire here (the branch had commits from an earlier round).
- `Rebase failed` fires for essentially every PR, including #1 (`pacman8 run.log 1618`) — the rebase strategy is
  wrong for a branch that has already been pushed and reviewed.
- `Cannot resolve conflicts …: Error:` with an **empty** message — `gitExec` swallows stderr, so there is no
  diagnostic at all.

---

## 2. Work item 1 — Commit in `finally`, always

Create one helper in `pr-workflow.ts` and use it at **every** point where an agent may have written files:

```ts
// ─── Durable commit ─────────────────────────────────────────────────────────

/**
 * Stage, commit and push whatever is in the worktree. Safe to call repeatedly.
 * MUST be called from a `finally` block after every agent invocation: an agent that
 * throws (recursion limit, loop-guard poisoning, connection error) has usually already
 * written files, and those writes are otherwise lost when the worktree is removed.
 * Returns the new HEAD sha, or null when there was nothing to commit.
 */
function commitWorktree(
    worktreeWorkspace: string,
    branchName: string,
    projectSlug: string,
    storyId: string,
    type: 'feat' | 'fix' | 'test' | 'refactor' | 'chore',
    subject: string,
    gitContext?: GitContext | null,
): string | null;
```

Apply at:

| Site | Current | Change |
|---|---|---|
| `:601-604` dev-agent `catch` | logs only | add `finally { commitWorktree(..., 'feat', `partial work from ${devId} (agent failed: ${err.message})`) }` around the per-dev try |
| `:695-697` gate-repair `catch` | logs only | wrap the repair invoke in try/finally, commit in `finally` |
| `:1088-1093` per-reviewer fix | inside try | move into `finally` |
| `:1192-1197` combined fix | inside try, `catch` at `:1198` | move into `finally` |
| `:1282-1287` escalation | inside try | move into `finally` |

Commit messages must record the failure so the transcript and `git log` explain what happened, e.g.
`[pacman8]-[US-001]-chore: partial work from senior-frontend (agent failed: Recursion limit of 58 reached)`.

Add a regression test that stubs `invokeDevAgent` to write a file then throw, and asserts the file is committed.

---

## 3. Work item 2 — Never destroy a failing worktree

`pr-workflow.ts:1485-1493` currently removes the worktree in the `finally`.

New behaviour:

```ts
// ─── Worktree disposal ──────────────────────────────────────────────────────
// Successful merge  → remove (as today).
// Anything else     → PRESERVE for salvage, and export a patch to the run outputs.
```

1. On success (`prStatus === 'merged'`): remove as today.
2. Otherwise:
   - `git format-patch <baseRef>..HEAD -o <outputPath>/salvage/<branch-slug>/` — a durable, reviewable artifact
     that survives even if the worktree is later pruned.
   - Write `<outputPath>/salvage/<branch-slug>/README.md` with the branch name, base ref, failure reason,
     `git log --oneline` and `git diff --stat`.
   - **Move** the worktree to `<gitRoot>/.worktrees-failed/<slug>` (`git worktree move`) instead of removing it, so
     a subsequent round can reuse it. Cap retained failed worktrees at `WORKTREE_SALVAGE_MAX` (config, default `10`),
     evicting oldest first, and prune them in `intakeNode` alongside the existing sweep (`nodes.ts:718-720`).
   - Do **not** delete the remote branch on failure (today `git.deleteRef` runs after merge; verify it is not on
     the failure path).
3. Reorder so cleanup **cannot** precede error reporting: the `finally` must run after the error has been logged
   and classified. Concretely, catch errors inside `executePRWorkflow`, classify them (§4), attach the
   classification to the returned `PullRequest`, and only then let the `finally` dispose of the worktree.
4. `finalizeNode` must list salvage directories in the summary and the manifest:
   `Salvaged branches: 1 (pacman8/feature/us-001-pacman-movement → outputs/<run>/salvage/…)`.

This alone converts "the game was written and deleted twice" into "the game is sitting in two patch files".

---

## 4. Work item 3 — Classify and handle git/GitHub failures

New file `src/conductor/pr-failure.ts`:

```ts
export type PrFailureKind =
    | 'pr-already-exists'      // GitHub 422 custom: "A pull request already exists for …"
    | 'no-commits'             // GitHub 422: "No commits between X and Y"
    | 'merge-conflict'
    | 'rebase-failed'
    | 'push-rejected'
    | 'auth'
    | 'rate-limit'
    | 'network'
    | 'unknown';

export function classifyPrFailure(err: unknown): { kind: PrFailureKind; message: string; retryable: boolean };
```

Match on the literal strings observed in the logs (write unit tests using those exact payloads):

- `A pull request already exists for` → `pr-already-exists`
- `No commits between` → `no-commits`
- `Pull Request has merge conflicts` → `merge-conflict`
- `CONFLICT (content)` / `could not apply` / `needs merge` → `rebase-failed`
- `non-fast-forward` / `Updates were rejected` → `push-rejected`
- `Bad credentials` / `401` / `403` → `auth`
- `rate limit` / `429` / `secondary rate limit` → `rate-limit`
- `ECONNRESET` / `ETIMEDOUT` / `Connection error` / `socket hang up` → `network`

### Handling

**`pr-already-exists` (the deadlock):** before creating a PR, always
`octokit.pulls.list({ owner, repo, head: `${owner}:${branchName}`, state: 'open' })` and reuse the existing PR
(`ghPr = existing`). Also handle it reactively: on a 422 whose classification is `pr-already-exists`, list and
reuse rather than falling back to curl. Add the same lookup to `src/utils/github-local.ts` so `GITHUB_MODE=local`
behaves identically — **check its `pulls` API surface first** (it documents `pulls.create/merge/get/createReview`;
you will need to add `pulls.list`).

Reusing the PR also means the review loop continues on the existing PR instead of starting over, which is what
should have happened in rounds 2–4.

**`no-commits`:** keep the existing `PR-SKIPPED-*` path but make it accurate — record
`skippedReason: 'no-commits'` on the `PullRequest` and do **not** mark the assignments complete
(see §6).

**`merge-conflict` / `rebase-failed`:** see §5.

**`rate-limit` / `network`:** retry the *GitHub call* with backoff (reuse `retryWithBackoff` from
`src/utils/retry.ts`; note it currently only retries rate-limit errors — extend its predicate to accept an
explicit `isRetryable` callback rather than widening its default behaviour).

**`auth`:** fail the whole run immediately. Silently continuing with a bad token wastes an entire run.

---

## 5. Work item 4 — Stop manufacturing merge conflicts

Three independent changes; implement all three.

### 5a. Serialise the scaffold

The scaffold branch must merge **before any feature branch worktree is created**. In
`src/agents/developers/dispatcher.ts`:

```ts
// ─── Scaffold barrier ───────────────────────────────────────────────────────
// The scaffold branch creates package.json/tsconfig/bundler config and (with Sub-Plan 05)
// the module interface stubs. Every feature branch must be cut from the MERGED scaffold,
// otherwise both branches invent the same config files and the feature branch is
// permanently conflicted (pacman8 PR #2).
```

1. Partition branches into `scaffoldBranches` (name matches `/\/chore\/scaffold$/`, or every assignment has
   `taskType === 'chore'`) and the rest.
2. Run scaffold branches first, **sequentially**, and `await syncWorkspaceToBranch(gitRoot, baseBranch, …)` after
   each merge so subsequent `git worktree add` cuts from the merged tree.
3. Only then dispatch feature branches. If a scaffold branch fails to merge, mark the run unrecoverable
   (Sub-Plan 03's `detectUnrecoverable` signal 4) — there is no point building features on a missing scaffold.
4. Also fix the underlying cause: `topoSort` put them in one layer because the feature assignments' `dependsOn`
   did not reference the scaffold assignments (or referenced dangling ids — see Sub-Plan 04 P10). Make the
   dispatcher **inject** the dependency: every non-scaffold assignment implicitly depends on all scaffold
   assignment ids, regardless of what the Team Leader wrote. Deterministic beats prompt-dependent.

### 5b. File ownership and conflict pre-check

- With Sub-Plan 05, each assignment declares `moduleIds` → known file paths. Before dispatching a batch, compute
  the intersection of declared paths across the batch's branches. On overlap, serialise those branches instead of
  running them in parallel, and log
  `Serialising branches A and B — both own src/game/types.ts`.
- Independent of Sub-Plan 05, add a **hard rule for shared config files**: only the scaffold branch may create or
  modify root-level config (`package.json`, `tsconfig*.json`, bundler configs, lint configs). Feature branches
  needing a dependency must add it via a dedicated mechanism — the simplest correct one is:
  `pr-workflow` collects requested dependencies from the dev output (add
  `requestedDependencies: Array<{ name: string; version?: string; dev?: boolean; reason: string }>` to
  `dev-output.schema.ts`), and the **conductor** applies them to the right `package.json` on the branch,
  deterministically, with `npm pkg set`. Agents stop touching `package.json` (which also closes the Sub-Plan 02
  attack surface) and the "everyone rewrites package.json 9 times" thrash disappears.

### 5c. Merge strategy that does not lose work

Replace `pr-workflow.ts:1387-1400`:

```
Current: fetch base → rebase → (on failure) rebase --abort → merge base --no-edit → (on failure) give up, leave PR open forever.
```

New ladder, with the branch **kept alive** at every step:

1. `git fetch origin <base>`.
2. If `git merge-base --is-ancestor origin/<base> HEAD` → already up to date, merge.
3. `git merge origin/<base> --no-edit` (merge, not rebase — the branch is already pushed and reviewed; rebasing a
   pushed branch is why `Rebase failed` appears for every PR).
4. On conflict: run **deterministic auto-resolution** for the file classes that actually conflict in practice:
   - `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` → take base, then re-run `npm install` to regenerate.
   - `package.json` → three-way merge of the `dependencies`/`devDependencies` objects (union, prefer the higher
     semver range), keep **base's** `scripts` verbatim (they are frozen per Sub-Plans 02/05).
   - Files where one side is unchanged from the merge base → take the changed side (git usually handles this;
     handle `add/add` conflicts where contents are identical).
   Implement in a new `src/conductor/merge-resolve.ts` with `resolveKnownConflicts(worktree, conflictedPaths)`.
5. Still conflicted → hand the conflict to the **owning dev agent** as a fix task: give it the conflicted file
   list, the conflict markers (capped), the base version and its own version, and ask it to resolve. Budget
   `MERGE_CONFLICT_FIX_ATTEMPTS` (config, default `1`). Commit in `finally`.
6. Still conflicted → **do not silently abandon.** Record `PrFailureKind: 'merge-conflict'`, export the salvage
   patch (§3), emit `emitRunEvent('pr:conflict', …)`, and surface it as a `critical` Bug
   `MERGE-CONFLICT-<branch>` so the bugfix loop and the acceptance gate both see it. Under
   `RUN_FAIL_POLICY='halt'`, a conflicted branch that carried ≥1 unmerged module is unrecoverable.
7. **Fix the empty error message**: `gitExec` swallows stderr. Add a `gitExecVerbose` (or extend `gitExec` with an
   options object) that returns `{ ok, stdout, stderr, code }`, and use it for all merge/rebase operations so
   `Cannot resolve conflicts …: Error:` becomes an actual diagnostic. Check `src/utils/git-exec.ts` for the
   existing signature and keep the old one for callers that rely on the `Error:` string convention.

---

## 6. Work item 5 — Evidence-based assignment completion

`src/conductor/assignment-policy.ts:42-50`:

```ts
export function completedIdsFromPullRequests(prs: PullRequest[]): string[] {
    for (const pr of prs) if (pr.status === 'merged' || pr.status === 'approved') ids.push(...pr.assignmentIds);
}
```

An assignment is marked permanently complete because a PR merged — even when the dev agent threw, even when the
only commit is the conductor's own `chore: final cleanup` (`pr-workflow.ts:611`), even on the force-merge path.
`completedAssignmentIds` is append-reduced (`state.ts:124-127`), so `selectPendingAssignments` excludes it forever.
This is why `pacman8` marked `BUGFIX-1-ASSIGN-010` complete for files that were never written.

Change to require evidence:

```ts
export interface CompletionEvidence {
    assignmentId: string;
    /** Distinct source files (excluding docs/ and pipeline metadata) changed on the merged branch, per `git diff --name-only`. */
    filesChanged: number;
    /** Files the assignment's declared modules require that now exist on the merged tree. */
    declaredModulesPresent: number;
    declaredModulesTotal: number;
    gatePassed: boolean;
    merged: boolean;
}

export function completedIdsWithEvidence(evidence: CompletionEvidence[]): { completed: string[]; incomplete: CompletionEvidence[] };
```

Completion requires: `merged === true` **and** `filesChanged > 0` **and**
`declaredModulesPresent === declaredModulesTotal` (when Sub-Plan 05 is present; otherwise skip that clause) **and**
`gatePassed === true`.

- Compute `filesChanged` from `git diff --name-only <baseRef>..HEAD` in the worktree, filtering `docs/`,
  `.agent/`, `.conventions/` and the artifact files — i.e. count real product changes, not the mission report.
- Assignments that merge without evidence go back to `pending` **and** get a `Bug`
  `INCOMPLETE-<assignmentId>` so triage re-dispatches them with the gap spelled out. Cap re-dispatch per
  assignment at `ASSIGNMENT_MAX_ATTEMPTS` (config, default `3`) to avoid the infinite loop that rounds 3–4 became.
- Record the evidence on state (`completionEvidence`, append reducer) and include a summary in the manifest.
  This directly kills the phantom-fileChanges problem: the manifest can now say
  `Assignments merged without file changes: 3`.

---

## 7. Config additions

```ts
/** Max failed worktrees retained under .worktrees-failed/ for salvage. */
export const WORKTREE_SALVAGE_MAX = parseInt(process.env.WORKTREE_SALVAGE_MAX ?? '10', 10);
/** Export `git format-patch` bundles for every branch that fails to merge. */
export const PR_SALVAGE_PATCHES = (process.env.PR_SALVAGE_PATCHES ?? 'true') === 'true';
/** Dev-agent attempts at resolving a merge conflict before the branch is reported blocked. */
export const MERGE_CONFLICT_FIX_ATTEMPTS = parseInt(process.env.MERGE_CONFLICT_FIX_ATTEMPTS ?? '1', 10);
/** Max times a single assignment may be re-dispatched. */
export const ASSIGNMENT_MAX_ATTEMPTS = parseInt(process.env.ASSIGNMENT_MAX_ATTEMPTS ?? '3', 10);
/** Only the scaffold branch may modify shared root config files. */
export const CONFIG_OWNERSHIP_SCAFFOLD_ONLY = (process.env.CONFIG_OWNERSHIP_SCAFFOLD_ONLY ?? 'true') === 'true';
```

---

## 8. Tests

`tests/pr-failure.test.ts` — classify each of the literal error payloads quoted in §1c and §1d.

`tests/pr-workflow-durability.test.ts` (mock `invokeDevAgent`, use a real temp git repo — there is precedent for
temp-repo tests in `tests/`; check `tests/workspace-sync.test.ts` if present):

- Dev agent writes `a.ts` then throws ⇒ `a.ts` is committed, commit subject mentions the failure.
- Review-fix agent writes `b.ts` then throws ⇒ `b.ts` is committed.
- Failed merge ⇒ worktree moved to `.worktrees-failed/`, patch written to `<outputPath>/salvage/…`, remote branch
  not deleted.
- Successful merge ⇒ worktree removed, no salvage directory.

`tests/dispatcher-scaffold-barrier.test.ts`:

- A plan with one `chore/scaffold` branch and three feature branches ⇒ scaffold runs alone, first, and
  `syncWorkspaceToBranch` is invoked before any feature worktree is created.
- Feature assignments with no `dependsOn` still get the injected scaffold dependency.
- Two branches declaring the same module path are serialised, not batched.

`tests/merge-resolve.test.ts`:

- `package-lock.json` conflict ⇒ auto-resolved to base + regenerate.
- `package.json` conflict with different `dependencies` ⇒ union; `scripts` = base's.
- A genuine source conflict ⇒ **not** auto-resolved; returns the conflicted path.

`tests/assignment-completion.test.ts`:

- Merged PR with 0 real file changes ⇒ **not** completed, produces `INCOMPLETE-*` bug.
- Merged PR whose only change is `docs/agents/x-mission.md` ⇒ not completed.
- Merged PR with 5 source files and a passing gate ⇒ completed.
- An assignment attempted 3 times ⇒ no fourth dispatch; a blocker is recorded instead.

`tests/github-local.test.ts` (extend) — `pulls.list` returns the open PR for a head branch so the reuse path works
offline.

---

## 9. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -n "worktree remove" src/conductor/pr-workflow.ts` shows it only on the success path.
- [ ] `grep -n "rebase origin/" src/conductor/pr-workflow.ts` returns nothing (merge, not rebase).
- [ ] Every `invokeDevAgent` / `invokeAgent` call in `pr-workflow.ts` is followed by a `finally` that calls
      `commitWorktree` — verify by reading each of the 5 sites listed in §2.
- [ ] A PR-creation 422 for an existing head reuses the PR instead of failing the branch.
- [ ] `README.md` "Git Branching & PR Workflow" section documents the scaffold barrier, salvage patches, the merge
      ladder and config-file ownership; `AI_Context.md` PR-workflow step list updated (it currently lists 11 steps;
      the ladder changes steps 10–11).

## 10. Out of scope

- Reviewer fail-open behaviour and the force-merge decision itself → Sub-Plan 07.
- Loop-guard / recursion-limit tuning that causes the agent throws in the first place → Sub-Plan 08.
- Do not change `GITHUB_MODE=live` credentials handling beyond the `auth` fail-fast.
