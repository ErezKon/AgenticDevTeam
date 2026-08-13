# Sub-Plan 08 — Agent Budgets & Context: Fix the Poisoning/Respawn Death Spiral

**Depends on:** nothing hard. Complements Sub-Plan 06 (durable commits mean a killed agent no longer loses work)
and Sub-Plan 05 (a contract means agents stop exploring to find out where things are).
**Cost stance:** the user chose *correctness first*. Budgets in this sub-plan go **up**. A $91 run that delivers
`echo Build successful` is infinitely more expensive than a $150 run that delivers a working product.

---

## 1. Evidence

### 1a. The numbers

`retroboard3 run.log` efficiency summary (lines 16462-16468):

```
senior-backend:      58 inv, 32.8 calls/inv, avg 3560 in/call, growth 1.88x, 87 respawns
senior-frontend:     23 inv, 27.9 calls/inv,                   growth 1.51x, 24 respawns
principal-backend:   22 inv, 30.1 calls/inv,                   growth 1.37x, 30 respawns
junior-react:        14 inv, 34.0 calls/inv,                   growth 1.41x, 18 respawns
principal-frontend:   5 inv, 32.8 calls/inv,                   growth 1.54x,  8 respawns
```

Whole-log counts: **289 × `poisoning all tools`**, **193 × `Respawning`**, **34 × `Done: 0 file changes`**.
`pacman8`: **117 × poisoning**, **80+ × `Respawning … : 0 files carried forward`**, 6 × `Recursion limit of 58`.

An agent invoked **58 times** delivered `src/utils/math.js`.

### 1b. The mechanism

```
retroboard3 8606  ERROR senior-frontend: tool "list_dir" called 3 times with identical args (total)
                        (10/22 total calls) — poisoning all tools
retroboard3 8607  DEBUG senior-frontend: history 19901 -> 7939 chars (10 results, 0 write args stubbed)
retroboard3 8614  INFO  Wrote artifact: senior-frontend-mission.md (291 chars)
retroboard3 8615  INFO  Done: 0 file changes
```

Three tiers exist (`returning cached result` → `breaking loop` → `poisoning all tools`) and the third **disarms
the agent permanently**. Agents burned their 18/22/26-call budget on `list_dir .`, `list_dir src`,
`read_file jest.config.cjs` — reconnaissance — got poisoned, respawned with `0 files carried forward`, and repeated
the identical reconnaissance.

`pacman8 run.log 3427` shows the downstream artifact:

> `docs/agents/senior-frontend-mission.md:1 — [MINOR] The documentation change contains a placeholder sentence
> "Unable to read required files due to tool loop termination. No changes made."`

Reviewers also die this way, and under the old policy that counted as an approval
(`pacman8 4073`, `retroboard3 6510`).

### 1c. Recursion-limit kills

```
pacman8  239  ERROR Dev agent senior-frontend failed: Recursion limit of 58 reached without hitting a stop condition.
pacman8  247  ERROR Dev agent principal-frontend failed: Recursion limit of 58 reached...
pacman8  471  ERROR Dev agent junior-react failed: Recursion limit of 58 reached...
pacman8 1607  ERROR Fix attempt failed: Recursion limit of 58 reached...
pacman8 5467  ERROR Dev agent junior-react failed: Recursion limit of 58 reached...
pacman8 5866  WARN  Repair attempt 1 for "devops" threw: Recursion limit of 6 reached...
```

The DevOps repair limit of **6** was consumed by the agent's first tool call, which failed the whole DevOps phase
and therefore silently skipped E2E (`pacman8 run.log 5871-5889`).

### 1d. Connection errors kill an entire invocation with no retry

```
pacman8 1410  WARN [llm-throttle] Global LLM cooldown 4175ms (consecutive 429s: 1, in-flight: 2, queued: 0)
pacman8 1411  ERROR Fix attempt for principal-backend's comments failed: Connection error.
pacman8 2696  WARN Quality gate repair attempt failed (non-fatal): Connection error.
pacman8 4919  ERROR Dev agent junior-react failed: Connection error.
pacman8 5960  INFO Requests: 1424, rate-limited: 3, throttled waits: 1356, total cooldown: 12s
```

Only 3 × 429 and 12 s total cooldown — rate limiting was **not** the problem. But each 429 that surfaced as
`Connection error` destroyed a whole dev invocation, because `retryWithBackoff`
(`src/utils/retry.ts:23-31, 55`) only retries recognised rate-limit shapes and a mid-stream socket failure is not
one of them.

### 1e. Current configuration

`src/config.ts`: `DEV_RECURSION_LIMIT=58`, `PIPELINE_RECURSION_LIMIT=15`,
`TOOL_PIPELINE_RECURSION_LIMIT=60`, `TOOL_PIPELINE_MAX_TOOL_CALLS=25`, `REVIEWER_RECURSION_LIMIT=26`,
`REVIEWER_MAX_TOOL_CALLS=8`, `HISTORY_KEEP_RECENT_TOOL_RESULTS=2`, `HISTORY_MAX_CHARS=30000`,
`MAX_TOOL_RESULT_CHARS=6000`, `AGENT_RESPAWN_MAX_GENERATIONS=2`, `AGENT_RESPAWN_TOKEN_THRESHOLD=14000`.
Per-rank `maxToolCalls` (per `AI_Context.md`): principal 26, senior 22, junior 18 — reduced from an earlier
40/35/30 for cost reasons. `MAX_CONCURRENT_DEVS=2`.

---

## 2. Work item 1 — Eliminate reconnaissance waste (the root cause)

Agents burned 30–40 % of their budget discovering the workspace. Give it to them for free.

In `src/conductor/pr-workflow.ts`, before invoking any dev agent, build and inject a **workspace snapshot**:

```ts
// ─── Workspace snapshot ─────────────────────────────────────────────────────
/**
 * Pre-computed answers to the questions agents waste their tool budget on:
 * "what files exist", "what's in package.json", "where are the tests".
 * Injected into the prompt so `list_dir`/`read_file` reconnaissance is unnecessary.
 */
export function buildWorkspaceSnapshot(worktree: string, opts: { maxFiles: number; maxChars: number }): string;
```

Contents:

1. `git ls-files` tree, grouped by directory, capped at `SNAPSHOT_MAX_FILES` (config, default `400`), excluding
   `docs/`, `.conventions/`, `.agent/`, lockfiles.
2. The exact `scripts` block of every `package.json` (and the equivalent for other stacks) — verbatim.
3. Test framework detection: which runner is configured, where tests live, and the exact command to run them.
4. Dependency list (names only, no versions) so agents stop guessing what is available.
5. With Sub-Plan 05: the repo contract section from `renderContractForPrompt`.

Add to the persona `<workflow>`: *"Steps 1–2 are already answered in the `## Workspace Snapshot` section of your
prompt. Do NOT call `list_dir` on the project root or read `package.json` — that information is above. Spend your
tool budget on reading the specific files you will modify, writing code, and running tests."*

Expected effect based on the logs: 6–10 of every ~30 calls per invocation were reconnaissance. This is the cheapest
large win in the sub-plan.

---

## 3. Work item 2 — Loop guard: degrade, never disarm

`src/agents/_shared/tool-loop-guard.ts`.

Current: 3rd identical call **poisons all tools** with a JSON error, and the total ceiling poisons all tools too.
Both leave the agent alive but unable to act — it then writes a placeholder mission report and returns
`0 file changes`.

Changes:

1. **Never poison unrelated tools.** A repeated `list_dir` must not disable `write_file`. Scope the penalty to the
   offending tool: after 3 identical calls, that specific `toolName::args` returns a terminal message
   (`[BLOCKED] You already called list_dir('.') 3 times. The answer is in your prompt's Workspace Snapshot.`) while
   every other tool keeps working. This is the single most important change here.
2. **Separate read and write ceilings.** `maxToolCalls` currently counts everything, so an agent that read 15 files
   has no budget left to write. Introduce `maxReadCalls` and `maxWriteCalls`:

   | Rank | reads | writes | shell |
   |---|---|---|---|
   | principal | 30 | 25 | 10 |
   | senior | 25 | 20 | 8 |
   | junior | 20 | 15 | 8 |

   Writes and shell runs are *productive* work; reads are where loops happen. Exhausting reads must not block
   writes.
3. **Progress-aware extension.** If the agent has produced ≥1 successful `write_file`/`edit_file` in the last N
   calls, grant `LOOP_GUARD_PROGRESS_BONUS` (config, default `10`) additional calls, up to
   `LOOP_GUARD_HARD_CEILING` (default `80`). Agents that are working get to keep working; agents that are looping
   do not.
4. **Terminal guidance instead of silence.** When a budget is genuinely exhausted, inject a final user message:
   *"Your tool budget is exhausted. Return your JSON output now, listing exactly the files you actually wrote.
   Do not claim files you did not write."* This directly targets the phantom-fileChanges problem (index PART A11):
   `jest.config.js` was reported `created` 3× and `modified` 3× and never passed to `write_file` once.
5. Keep the read-only result cache (it is good) but make `[CACHED]` responses **free** — they must not consume
   budget. Verify the current implementation; the log line
   `list_dir called 2 times with identical args (total) (4/25 total calls) — returning cached result` shows the
   counter incrementing on a cache hit.

---

## 4. Work item 3 — Respawn with a real handoff

`AGENT_RESPAWN_ENABLED` exists, but `Respawning … : 0 files carried forward` appears 80+ times in `pacman8` and
in the overwhelming majority of `retroboard3`'s 193 respawns. A respawn that carries nothing forward guarantees the
next generation repeats the same reconnaissance — that is the death spiral.

Build a real handoff document and pass it as the new agent's first user message:

```
## Handoff from generation 1
### Files you already wrote (verified on disk, do not rewrite from scratch)
- src/game/GhostAI.ts (2,410 bytes) — exports chooseTarget, SCATTER_TARGETS
- src/game/__tests__/GhostAI.test.ts (1,180 bytes) — 4 tests, currently 2 failing
### Commands you already ran and their outcome
- `npx jest src/game` → exit 1: "expected Tile{2,3} received Tile{2,4}" in "chases pac-man"
- `npm run build` → exit 0
### What remains, from your assignment
- AC1 "Ghosts switch between chase and scatter according to timers" — not yet implemented
### Notes from your previous generation
<the previous generation's `notes` field, verbatim>
```

Implementation notes:

- Derive "files you already wrote" from the **worktree** (`git status --short` + `git diff --name-only <base>..HEAD`),
  not from the agent's claimed `fileChanges`. Ground truth only.
- Derive "commands you ran" from the shell tool's invocation log — add a per-invocation ring buffer to
  `src/tools/shell/shell-tools.ts` exposing `getRecentCommands(): Array<{ cmd: string; exitCode: number; tailOutput: string }>`.
- Raise `AGENT_RESPAWN_MAX_GENERATIONS` from `2` to `4`, and gate further respawns on **progress**: a generation
  that produced zero writes does not get another respawn (it gets terminated and reported, so Sub-Plan 06's
  evidence check leaves the assignment pending instead of falsely completing it).
- Log the handoff size and the carried file count: `Respawning senior-backend (generation 2): 3 files carried forward, handoff 1,840 chars`.

---

## 5. Work item 4 — Budgets and limits (correctness-first values)

`src/config.ts` changes. Every one of these is justified by a specific observed failure; note the reason in the
JSDoc comment beside it.

| Constant | Old | New | Justification |
|---|---|---|---|
| `DEV_RECURSION_LIMIT` | 58 | `140` | 6 × `Recursion limit of 58` killed dev agents mid-work in pacman alone; with split read/write ceilings the loop guard, not the recursion limit, must be the binding constraint |
| per-rank `maxToolCalls` | 26/22/18 | replaced by read/write/shell splits (§3.2) | reconnaissance consumed the whole budget |
| `LOOP_GUARD_HARD_CEILING` | — | `80` | absolute stop |
| `REVIEWER_RECURSION_LIMIT` | 26 | `40` | reviewers abstained on recursion limits and that counted as approval |
| `REVIEWER_MAX_TOOL_CALLS` | 8 | `14` | same |
| `TOOL_PIPELINE_RECURSION_LIMIT` | 60 | `120` | `qa-unit` was poisoned at 6–7 calls in **all 8** QA phases across both runs |
| `TOOL_PIPELINE_MAX_TOOL_CALLS` | 25 | `50` | same |
| repair-invoke `recursionLimit` | 6 (hardcoded, `nodes.ts:403-415`) | `PIPELINE_RECURSION_LIMIT` | the DevOps repair died on its first tool call and took the phase with it |
| `HISTORY_KEEP_RECENT_TOOL_RESULTS` | 2 | `4` | agents re-read files they had already read because the result had been stubbed out of history |
| `HISTORY_MAX_CHARS` | 30000 | `60000` | with `growth 1.88x` observed, over-aggressive compaction was causing re-reads, which cost *more* tokens than it saved |
| `MAX_TOOL_RESULT_CHARS` | 6000 | `10000` | a 4,210-char source file read was being truncated, so agents re-read with offsets |
| `AGENT_RESPAWN_MAX_GENERATIONS` | 2 | `4` | with a real handoff, respawn becomes productive |
| `AGENT_OUTPUT_REPAIR_ATTEMPTS` | 1 | `2` | one attempt lost 19 of 26 assignments (Sub-Plan 04) |
| `MAX_CONCURRENT_DEVS` | 2 | keep `2` | the gateway is 20 RPM; more concurrency only lengthens queues, and parallel branches are what caused the conflicts |

Add a **cost guard** so this is not a blank cheque — the existing `run-budget.ts` already implements graceful
degradation but all three limits default to `0` (unlimited). Set defaults:

```ts
/** Max estimated USD per run. Degrades review/repair budgets at 90 %, stops new branch workflows at 100 %. */
export const MAX_RUN_COST_USD = parseFloat(process.env.MAX_RUN_COST_USD ?? '150');
/** Max wall-clock ms per run (default 5 h). */
export const MAX_RUN_WALL_MS = parseInt(process.env.MAX_RUN_WALL_MS ?? '18000000', 10);
```

Combined with Sub-Plan 03's early-halt on unrecoverability, this is what makes raised budgets safe: money goes to
runs that can still succeed, and failing runs stop early.

---

## 6. Work item 5 — Retry transient LLM failures at the invocation level

`src/utils/retry.ts` currently retries only rate-limit-shaped errors, so `Connection error` killed whole
invocations (§1d).

1. Extend the retry predicate to include transient network/stream failures: `ECONNRESET`, `ECONNREFUSED`,
   `ETIMEDOUT`, `EPIPE`, `socket hang up`, `Connection error`, `terminated`, `premature close`, HTTP 500/502/503/504.
   Keep 4xx (other than 429) non-retryable.
2. Add an **invocation-level** retry in `invokeDevAgent` / `invokeAgent`: if the agent throws a retryable error
   **and has not yet written any files**, rebuild the agent and retry once (`AGENT_INVOKE_RETRIES`, default `1`).
   If it *has* written files, do not retry — respawn with the handoff instead (§4), so work is never duplicated.
3. Distinguish the two in the logs: `Dev agent junior-react failed (retryable network error) — retrying (1/1)`
   vs `Dev agent junior-react failed permanently: <reason>`.
4. Sanity-check the throttle settings against the documented quota (`.env` comments state 20 RPM for
   `gpt-oss-120b`, `LLM_MIN_REQUEST_INTERVAL_MS=3000`, `LLM_MAX_CONCURRENT_REQUESTS=2`). With 2 concurrent
   requests at a 3,000 ms spacing the effective rate is ~40 RPM, which is over quota — that is where the 429s came
   from. Either set `LLM_MAX_CONCURRENT_REQUESTS=1` or make the spacing global across the semaphore rather than
   per-slot. Read `src/utils/llm-throttle.ts` and fix whichever it is; add a unit test asserting the achieved
   request rate over a simulated window stays under `60000 / LLM_MIN_REQUEST_INTERVAL_MS`.

---

## 7. Work item 6 — Honest self-reporting of file changes

Phantom `fileChanges` (index PART A11: 11 of 20 pacman paths never existed; `jest.config.js` claimed 6 times,
written 0 times) corrupt every downstream metric and mislead reviewers.

1. In `pr-workflow.ts`, after each dev invocation, **reconcile** the agent's claimed `output.fileChanges` against
   the worktree:

   ```ts
   const actual = new Set(gitExec(worktree, 'diff --name-only HEAD').split('\n')
       .concat(gitExec(worktree, 'ls-files --others --exclude-standard').split('\n')).filter(Boolean));
   const phantoms = (output.fileChanges ?? []).filter(fc => !actual.has(fc.path) && !fs.existsSync(path.join(worktree, fc.path)));
   ```

2. Drop phantoms from `allFileChanges`, log `warn` with the list, and record them on state as
   `phantomFileChanges` (append reducer) for the manifest.
3. Add any file that exists on disk but was **not** claimed (`unreported`) with `summary: '(unreported by agent)'`
   — the metric should reflect reality in both directions.
4. Log the reconciliation: `senior-frontend claimed 8 changes; 3 verified, 5 phantom, 1 unreported`.
5. Feed `phantomFileChanges` into the reviewer's automated-findings block (Sub-Plan 07 §6) — an agent that claims
   files it did not write is a `critical` finding.

---

## 8. Config additions summary

```ts
/** Max files listed in the injected workspace snapshot. */
export const SNAPSHOT_MAX_FILES = parseInt(process.env.SNAPSHOT_MAX_FILES ?? '400', 10);
/** Char budget for the injected workspace snapshot. */
export const SNAPSHOT_MAX_CHARS = parseInt(process.env.SNAPSHOT_MAX_CHARS ?? '8000', 10);
/** Extra tool calls granted when an agent is making verified progress (writes). */
export const LOOP_GUARD_PROGRESS_BONUS = parseInt(process.env.LOOP_GUARD_PROGRESS_BONUS ?? '10', 10);
/** Absolute per-invocation tool-call ceiling. */
export const LOOP_GUARD_HARD_CEILING = parseInt(process.env.LOOP_GUARD_HARD_CEILING ?? '80', 10);
/** Per-rank read/write/shell tool-call budgets (JSON override). */
export const TOOL_BUDGETS_JSON = process.env.TOOL_BUDGETS_JSON ?? '';
/** Invocation-level retries for transient LLM/network failures. */
export const AGENT_INVOKE_RETRIES = parseInt(process.env.AGENT_INVOKE_RETRIES ?? '1', 10);
/** Reconcile agent-claimed fileChanges against the worktree and drop phantoms. */
export const RECONCILE_FILE_CHANGES = (process.env.RECONCILE_FILE_CHANGES ?? 'true') === 'true';
```

Plus every changed default in §5. **Every changed default must be reflected in `.env.example` with a one-line
comment explaining the old value and why it changed** — future maintainers will otherwise revert them for cost.

---

## 9. Tests

`tests/tool-loop-guard.test.ts` (extend the existing tests):

- 3 identical `list_dir` calls block `list_dir` **only**; a subsequent `write_file` succeeds.
- A `[CACHED]` response does not increment the budget counter.
- Read budget exhausted ⇒ writes still allowed.
- 3 successful writes ⇒ progress bonus granted; hard ceiling still enforced at 80.
- Budget exhaustion injects the "return your JSON now, do not claim files you did not write" message.

`tests/agent-respawn.test.ts`:

- Handoff lists exactly the files present in the worktree, not the agent's claims.
- A generation with zero writes is not respawned.
- Handoff includes the last shell command and its exit code.

`tests/retry.test.ts` (extend):

- `Connection error`, `ECONNRESET`, `socket hang up`, HTTP 502 are retryable; HTTP 404 and 401 are not.
- `invokeDevAgent` retries once when nothing was written; does not retry when files exist.

`tests/llm-throttle.test.ts`:

- With `LLM_MAX_CONCURRENT_REQUESTS=2` and `LLM_MIN_REQUEST_INTERVAL_MS=3000`, the achieved rate over a simulated
  60 s window does not exceed 20 requests. (This test is expected to **fail before** the fix — that is the point.)

`tests/file-change-reconciliation.test.ts`:

- Claimed `jest.config.js` with no such file ⇒ dropped, recorded as phantom.
- A file written but not claimed ⇒ added as `(unreported by agent)`.

`tests/workspace-snapshot.test.ts`:

- Snapshot includes the verbatim `scripts` block and stays under `SNAPSHOT_MAX_CHARS` for a 400-file tree.

---

## 10. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -rn "poisoning all tools" src/` — the message survives only in the tool-scoped path; no code path
      disables unrelated tools.
- [ ] `grep -rn "recursionLimit: 6" src/` returns nothing.
- [ ] `grep -rn "0 files carried forward" src/` — the message may remain, but a respawn with zero carried files and
      zero writes now terminates instead of looping.
- [ ] `.env.example` documents every changed default with its previous value.
- [ ] `AI_Context.md` "Common Gotchas" items 3 and 4 (recursion limits and per-rank max tool calls) updated with
      the new numbers; the Tool Loop Guard and LLM Throttle subsystem sections rewritten.
- [ ] `README.md` "Context Compaction & Token Optimization" section updated — its claim of a 60–75 % token
      reduction no longer holds, and the honest framing is *"compaction is tuned for correctness first; over-
      compaction caused re-reads that cost more than they saved"*.

## 11. Out of scope

- QA agent behaviour beyond raising its budget → Sub-Plan 09.
- Changing which models are used. Note for the user: both runs used `gpt-oss-120b` for every agent
  (`.env` lines 8–17), so model capability is not the variable to blame for these failures — the
  scaffolding is. Do not switch models as part of this plan.
