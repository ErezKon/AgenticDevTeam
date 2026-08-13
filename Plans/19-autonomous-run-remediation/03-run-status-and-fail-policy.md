# Sub-Plan 03 — Truthful Run Status, Acceptance Gate & `RUN_FAIL_POLICY`

**Depends on:** Sub-Plan 01 (`ProductVerifyReport`, honest `GateReport`), Sub-Plan 02 (`TamperFinding`).
**Goal:** the pipeline must be able to say *"this run failed, here is exactly what is missing"* — and, optionally,
stop early instead of burning another hour and $50 on a product that cannot build.

**User decision to implement (both behaviours, selectable):**

```
RUN_FAIL_POLICY = halt      # hard-fail and stop as soon as the acceptance gate is unsatisfiable
                | finalize  # never halt early, but the terminal status is failed/partial and the manifest lists gaps
                | legacy    # current behaviour: always 'completed' (kept for comparison/regression only)
```
Default: `halt`.

---

## 1. Evidence

Both runs printed their own failure and then declared success.

`pacman8 run.log`:

```
5891 [Finalize] INFO
5895 Assignments: 10
5896 File changes: 43
5957 AC coverage: 0/45 verified (0%), 2 implemented-untested, 41 missing
5972 [Run] INFO Autonomous run complete.
```

and the final gate report in the same `state.json` says the build does not compile:

```
build: error during build: Could not resolve "./index.css" from "src/main.tsx"
lint : vite.config.ts 1:30 error Replace `'vite'` with `"vite"`  prettier/prettier
test : No tests found, exiting with code 1 ... 8 files checked ... 0 matches
```

`retroboard3 run.log`:

```
16405 [QA E2E] ERROR E2E testing failed: Failed to connect to stdio server "playwright": MCP error -32000
16417 [Finalize] INFO Finalizing run...
16484 AC coverage: 0/26 verified (0%), 16 implemented-untested, 2 missing
16499 [Run] INFO Autonomous run complete.
```

`outputs/*/run-manifest.json` for both: `"status": "completed"`.

Also from `pacman8`: after PR #2 died in a merge conflict, dispatch rounds 3 and 4 each ran 7–15 minutes of dev
work and produced `Dispatch complete: 0 total file changes, 0 PRs, 0 artifacts, 0 completed assignments`
(`run.log 5200`, `5769`). Roughly 20 minutes and thousands of LLM calls were spent after the run was already
unrecoverable. In `retroboard3` the same pattern wasted 37 minutes (`run.log 13454 → 16237`).

### Root causes in code

| ID | Defect | Location |
|---|---|---|
| E1 | `finalStatus = state.cancelled ? 'cancelled' : 'completed'` — the entire success definition | `nodes.ts:1675` |
| E2 | `writeRunManifest(..., finalStatus, ...)` stamps it unconditionally | `nodes.ts:1918` |
| E3 | No `fail` terminal in the graph; `afterQaRouter` falls through to `devops` once the bugfix budget is spent | `graph.ts:57-64` |
| E4 | `testReports` is append-reduced ⇒ a stale `fail` never clears and a real fix is invisible | `state.ts:140-143` |
| E5 | `fixedBugIds` is written at **triage** time, and `GATE-*` ids are stable ⇒ a permanently failing build gate is triaged once and suppressed forever | `nodes.ts:1448-1453` + `:1403-1405` |
| E6 | `looksSourceless()` fires, logs `ERROR`, pipeline continues | `nodes.ts:1150-1153` |
| E7 | Dispatch rounds that produce nothing are retried identically with no convergence check | `dispatcher.ts:289` |
| E8 | `afterE2eRouter` scans **all** testReports, not just `type === 'e2e'` | `graph.ts:74-83` |
| E9 | Every gate/security/AC/traceability failure is wrapped in `catch { warn }` | `nodes.ts:1308, 1338, 1375, 1788` |

---

## 2. Work item 1 — New file `src/conductor/acceptance-gate.ts`

The single place that answers "is this product acceptable?".

```ts
// ─── Types ───────────────────────────────────────────────────────────────────

export type AcceptanceStatus = 'accepted' | 'partial' | 'rejected' | 'inconclusive';

export interface AcceptanceCriterionResult {
    id: string;              // 'BUILD', 'ARTIFACTS', 'RESOLVE', 'TESTS', 'SMOKE', 'AC_COVERAGE', 'SCOPE', 'INTEGRITY', 'DEPLOY', 'E2E'
    label: string;
    required: boolean;       // required criteria gate 'accepted'
    passed: boolean;
    inconclusive: boolean;
    detail: string;          // one line, quotable in a report
}

export interface AcceptanceReport {
    status: AcceptanceStatus;
    criteria: AcceptanceCriterionResult[];
    /** Ordered, human-readable list of what must be fixed. Goes in the manifest and the final log. */
    blockers: string[];
    /** True when no further pipeline work can plausibly change the outcome (see §3). */
    unrecoverable: boolean;
    unrecoverableReason?: string;
}

export function evaluateAcceptance(state: ProjectStateType): AcceptanceReport;
```

Criteria table (each backed by data that now exists thanks to Sub-Plans 01/02):

| id | Required | Passes when |
|---|---|---|
| `BUILD` | yes | The latest gate report for each stack root has `build` executed with `mode !== 'absent'` and `passed: true` |
| `ARTIFACTS` | yes | Every `ArtifactCheck` in the latest `ProductVerifyReport` passed |
| `RESOLVE` | yes | `resolveIssues.length === 0` |
| `TESTS` | yes | The `test` step ran with a real runner, `failed === 0`, and the executed test count ≥ `ACCEPT_MIN_TESTS` (config, default `1`; Sub-Plan 09 raises this to a per-story figure) |
| `SMOKE` | yes for web products | `smoke.passed`, or `smoke.ran === false` with `skippedReason === 'no web root detected'` |
| `INTEGRITY` | yes | No `critical` `TamperFinding` anywhere in the run |
| `SCOPE` | yes | `orphanedStories.length === 0` and every story has ≥1 assignment with a merged PR (Sub-Plan 04 supplies this) |
| `AC_COVERAGE` | yes | Traceability coverage ≥ `MIN_AC_COVERAGE_PCT` (Sub-Plan 10 makes this metric meaningful and turns it on) |
| `DEPLOY` | no | `devopsPlan.buildStatus === 'success'` **verified**, or legitimately `skipped` |
| `E2E` | no | `e2eStatus === 'passed'` or `'skipped-no-services'` (Sub-Plan 11 adds the field) |

Status derivation:

- `rejected` — any required criterion failed.
- `inconclusive` — no required criterion failed but ≥1 is inconclusive (e.g. gates never executed).
- `partial` — all required passed, ≥1 optional failed.
- `accepted` — everything required passed and no optional failed.

`blockers` must be actionable, one line each, naming files:

```
BUILD: `npm run build` failed in `.`: Could not resolve "./index.css" from "src/main.tsx"
RESOLVE: 1 unresolved reference — src/main.tsx:4 imports './index.css' (missing-file)
TESTS: no test runner executed; 0 tests found in 8 files
SCOPE: 18 of 20 user stories have no merged assignment (US-002 … US-018, US-999)
```

**Selecting "the latest" gate report:** because `testReports` is append-reduced (E4), add a
`iterationIndex: number` field to `TestReport` (schema change — update
`src/agents/_shared/schemas/testing.schema.ts` and every producer), stamped from `state.iteration.bugfix` at
creation. `evaluateAcceptance` and the routers must consider only reports whose `iterationIndex` equals the
current iteration. Alternatively add a `latestGateReport: GateReport | null` field to `ProjectState` with a
**replace** reducer — **prefer this**, it is smaller and unambiguous. Do both only if a consumer needs history.

---

## 3. Work item 2 — Unrecoverability detection (the money-saver)

Add to `acceptance-gate.ts`:

```ts
/**
 * A run is unrecoverable when no remaining pipeline work can plausibly change the outcome.
 * Detecting this early is what prevents the two 20–37 minute zero-output dispatch rounds
 * observed in both post-mortem runs.
 */
export function detectUnrecoverable(state: ProjectStateType): { unrecoverable: boolean; reason?: string };
```

Signals (any one is sufficient):

1. **Zero-progress dispatch.** Two consecutive development phases produced 0 file changes **and** 0 new merged
   PRs. Requires new state: `dispatchRounds: Array<{ fileChanges: number; prs: number; completed: number }>`
   (append reducer), pushed by `developmentNode`.
2. **Permanently blocked branch.** A branch whose PR is `open` with unresolved merge conflicts and whose
   re-dispatch has failed `>= 2` times with `A pull request already exists` or `merge conflicts`. Requires the
   PR-workflow error classification from Sub-Plan 06 — until that lands, match on the error string.
3. **Sourceless workspace after development** — `looksSourceless()` true (fixes E6). This must become a hard stop:
   there is nothing to test, deploy or verify.
4. **Scaffold never landed** — no stack root detected in the synced workspace after the first development phase.
5. **All required acceptance criteria failed twice** with an identical blocker set across two bugfix iterations.

`developmentNode` must call `detectUnrecoverable` right after `syncWorkspaceToBranch` and record the result on
state as `unrecoverable: { flag: boolean; reason: string } | null` (replace reducer).

---

## 4. Work item 3 — Graph wiring and `RUN_FAIL_POLICY`

`src/conductor/graph.ts`.

1. Add a node `acceptance` between `e2e` and `finalize`, and also reachable from `qa`:

   ```
   qa → afterQaRouter → { bugfix-triage | devops | acceptance }
   devops → e2e → afterE2eRouter → { bugfix-triage | acceptance }
   acceptance → afterAcceptanceRouter → { bugfix-triage | finalize }
   ```

   `acceptanceNode` (new, in `nodes.ts`) calls `evaluateAcceptance`, writes `state.acceptance`
   (replace reducer), logs every blocker at `error` level, writes an artifact
   `docs/agents/acceptance-report.md`, and emits `emitRunEvent('acceptance:result', …)`.

2. `afterQaRouter` rewrite:

   ```ts
   export function afterQaRouter(state: ProjectStateType): string {
       if (state.cancelled) return 'finalize';
       if (state.unrecoverable?.flag) return RUN_FAIL_POLICY === 'halt' ? 'finalize' : 'acceptance';
       const current = currentIterationFailures(state);   // NOT the whole append-reduced array (fixes E4)
       if (current.length > 0 && (state.iteration?.bugfix ?? 0) < getEffectiveLimits().maxBugfixIterations) {
           return 'bugfix-triage';
       }
       // Budget spent with failures still present: under 'halt' go straight to finalize as a failure;
       // otherwise continue to devops so the run still produces deployment artifacts.
       if (current.length > 0 && RUN_FAIL_POLICY === 'halt') return 'acceptance';
       return 'devops';
   }
   ```

3. `afterE2eRouter`: filter `r.type === 'e2e'` (fixes E8) and route to `acceptance`, never directly to `finalize`.

4. `afterAcceptanceRouter`:

   ```ts
   if (state.cancelled) return 'finalize';
   const a = state.acceptance;
   if (a && a.status !== 'accepted' && !a.unrecoverable
       && (state.iteration?.bugfix ?? 0) < getEffectiveLimits().maxBugfixIterations) {
       return 'bugfix-triage';   // acceptance blockers now feed the bugfix loop (they never did before)
   }
   return 'finalize';
   ```

   `bugfixTriageNode` must accept acceptance blockers as bug input — convert each blocker into a `Bug` with a
   stable id `ACCEPT-<criterionId>` and severity `critical` for required criteria.

5. `RUN_FAIL_POLICY === 'halt'` additionally short-circuits **inside** `developmentNode`,
   `qaNode` and `devopsNode`: at the top of each, `if (state.unrecoverable?.flag) { log the reason; return { phase: 'finalize' } }`.
   Do it via a small shared helper `haltIfUnrecoverable(state, log): Partial<ProjectStateType> | null` so the
   pattern is identical in every node.

---

## 5. Work item 4 — Finalize tells the truth (fixes E1, E2)

`nodes.ts` `finalizeNode`:

```ts
// ─── Terminal status ────────────────────────────────────────────────────────
// 'completed' used to mean "the graph reached this node". It now means the
// acceptance gate accepted the product. See Plan 19 Sub-Plan 03.
const acceptance = state.acceptance ?? evaluateAcceptance(state);
const finalStatus: RunStatus =
    state.cancelled                      ? 'cancelled'
  : RUN_FAIL_POLICY === 'legacy'         ? 'completed'
  : acceptance.status === 'accepted'     ? 'completed'
  : acceptance.status === 'partial'      ? 'partial'
  : acceptance.status === 'inconclusive' ? 'inconclusive'
  :                                        'failed';
```

- Extend the `RunStatus` union wherever it is declared (grep `setRunStatus`, `writeRunManifest`,
  `'completed'` in `src/utils/token-tracker.ts`, `src/utils/run-snapshot.ts`, `src/index.ts`, the dashboard
  `api.service.ts` and any status badge in `dashboard/`). **Do not leave the dashboard rendering an unknown status.**
- `run-manifest.json` gains:

  ```json
  "acceptance": {
    "status": "failed",
    "blockers": ["BUILD: …", "RESOLVE: …"],
    "criteria": [{ "id": "BUILD", "required": true, "passed": false, "detail": "…" }],
    "unrecoverable": true,
    "unrecoverableReason": "two consecutive dispatch rounds produced no file changes"
  },
  "verification": {
    "gateReport": { "...": "latest GateReport summary" },
    "productVerify": { "artifacts": "...", "unresolvedReferences": 1, "smoke": "fail" },
    "integrityFindings": 3
  }
  ```

- The final log block must print the blockers. Replace the current summary's cheerful ending
  (`Autonomous run complete.` in `src/conductor/run.ts`) with a status-aware line:
  `Run finished: FAILED — 4 blocker(s). See outputs/<run>/run-manifest.json → acceptance.blockers`.
- **Delete the misleading metric.** `File changes: 43` in the finalize summary counts tool invocations, not
  delivered code (see index PART A11). Replace with:
  `Files delivered: <count of distinct paths present on disk under the workspace at finalize time>` and
  `Phantom file changes: <count of distinct fileChanges paths NOT present on disk>`. The second number was 11
  for `pacman8` and would have screamed. Implement the disk check with `git ls-files` on the synced workspace.

---

## 6. Work item 5 — Stop the "fixed before verified" bug (fixes E5)

`nodes.ts` `bugfixTriageNode:1448-1453` currently returns `fixedBugIds: bugIdsBeingFixed` at triage time.

Change to:

1. Return `attemptedBugIds` (new state field, append reducer) at triage time — purely informational.
2. Compute `fixedBugIds` in `qaNode`/`acceptanceNode` by **re-evaluation**: a bug id is fixed when it is not
   present in the current iteration's freshly synthesised bug set. Since gate bugs use stable ids
   (`GATE-node-build`, `PRODUCT-RESOLVE`, `ACCEPT-BUILD`), this is a set difference:
   `fixed = previousOpen \ currentlySynthesised`.
3. Keep an `bugAttempts: Record<string, number>` (custom merge reducer) so triage can escalate a bug that has
   been attempted twice — pass it to a higher-rank developer instead of the same one.

Add a regression test: a `GATE-node-build` bug present in iterations 1, 2 and 3 must be re-triaged each time and
must appear in the final acceptance blockers.

---

## 7. Work item 6 — Stop swallowing verification failures (fixes E9)

For each of `nodes.ts:1308` (quality gate), `:1338` (security gate), `:1375` (AC coverage), `:1788` (traceability):

- Keep the `try/catch` (a crash must not kill the run) **but** record the failure on state as an
  `inconclusive` verification result so the acceptance gate sees it:

  ```ts
  } catch (gateErr: any) {
      qaLog.error(`Quality gate execution error: ${gateErr.message}`);
      verificationErrors.push({ stage: 'quality-gates', message: gateErr.message });
  }
  ```

- Add `verificationErrors: Array<{ stage: string; message: string }>` to `ProjectState` (append reducer).
  `evaluateAcceptance` marks the corresponding criterion `inconclusive: true` when its stage appears there.
  A crashed gate must never read as green.

Same for `qaNode`'s `catch` blocks at `:1228-1232` (QA Lead) and `:1263-1267` (QA Unit): push a
`verificationErrors` entry so a crashed QA is distinguishable from a passing QA.

---

## 8. Config additions

```ts
// ─── Run Acceptance ─────────────────────────────────────────────────────────

/**
 * What happens when the product does not satisfy the acceptance gate.
 *  'halt'     — stop the pipeline as soon as the outcome is unrecoverable; terminal status 'failed'.
 *  'finalize' — always run to finalize, but the terminal status reflects the gate ('failed'|'partial'|'inconclusive').
 *  'legacy'   — pre-Plan-19 behaviour: always 'completed'. For regression comparison only.
 */
export const RUN_FAIL_POLICY =
    (process.env.RUN_FAIL_POLICY ?? 'halt') as 'halt' | 'finalize' | 'legacy';

/** Minimum number of really-executed tests for the TESTS acceptance criterion. */
export const ACCEPT_MIN_TESTS = parseInt(process.env.ACCEPT_MIN_TESTS ?? '1', 10);

/** Treat the SMOKE criterion as required for web products. */
export const ACCEPT_REQUIRE_SMOKE = (process.env.ACCEPT_REQUIRE_SMOKE ?? 'true') === 'true';

/** Consecutive zero-output dispatch rounds that mark a run unrecoverable. */
export const UNRECOVERABLE_ZERO_ROUNDS = parseInt(process.env.UNRECOVERABLE_ZERO_ROUNDS ?? '2', 10);
```

Mirror in `.env.example` + README. In `.env.example` add a prominent comment block explaining the three policies.

---

## 9. Tests

`tests/acceptance-gate.test.ts` — build `ProjectStateType` fixtures (there are existing state fixtures in
`tests/`; reuse the pattern) and assert:

- **The pacman fixture**: gate report with a failing `build` (`Could not resolve "./index.css"`), 1 resolve issue,
  0 tests, 18 orphaned stories ⇒ `status: 'rejected'`, blockers include `BUILD`, `RESOLVE`, `TESTS`, `SCOPE`.
- **The retroboard fixture**: gate green but `ArtifactCheck` failed (`echo` build), 1 resolve issue,
  1 trivial test, 3 critical tamper findings ⇒ `status: 'rejected'`, blockers include `ARTIFACTS`, `INTEGRITY`.
- A fully healthy fixture ⇒ `accepted`.
- A healthy fixture with `devopsPlan.buildStatus: 'failed'` ⇒ `partial`.
- A fixture where the gate crashed (`verificationErrors` has a `quality-gates` entry) ⇒ `inconclusive`,
  **not** `accepted`.

`tests/graph-routing.test.ts` (extend if present):

- `afterQaRouter` with a stale iteration-1 `fail` and a clean iteration-2 report ⇒ `devops`/`acceptance`,
  **not** `bugfix-triage`.
- `afterQaRouter` with `unrecoverable.flag` and `RUN_FAIL_POLICY='halt'` ⇒ `finalize`.
- `afterQaRouter` with `unrecoverable.flag` and `RUN_FAIL_POLICY='finalize'` ⇒ `acceptance`.
- `afterE2eRouter` ignores non-e2e failing reports.
- `afterAcceptanceRouter` routes a `rejected` acceptance back to `bugfix-triage` while budget remains.

`tests/finalize-status.test.ts`:

- Each acceptance status maps to the right terminal status, for each of the three `RUN_FAIL_POLICY` values.
- `legacy` reproduces `completed` for a rejected product (proves the escape hatch works).
- Manifest contains `acceptance.blockers` and the `phantomFileChanges` count.

`tests/unrecoverable.test.ts`:

- Two zero-output `dispatchRounds` ⇒ unrecoverable.
- One zero-output round followed by a productive one ⇒ recoverable.
- `looksSourceless` true ⇒ unrecoverable.

---

## 10. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -n "cancelled ? 'cancelled' : 'completed'" src/` returns nothing.
- [ ] Every consumer of run status (CLI, `src/index.ts` WebSocket payloads, `dashboard/src/app/**`,
      `token-tracker`, `run-snapshot`) handles `failed`, `partial`, `inconclusive`.
- [ ] Feeding the two real `state.json` files from `outputs/` into `evaluateAcceptance` (write a throwaway
      test that loads them and asserts `status === 'rejected'`) — **this is the single best proof the gate works.**
      Keep the test; the two state files are permanent regression fixtures. Copy them (redacted) to
      `tests/fixtures/states/pacman8-state.json` and `retroboard3-state.json`.
- [ ] `README.md` gains a "Run Status & Acceptance Gate" section documenting the four statuses and
      `RUN_FAIL_POLICY`; `AI_Context.md` pipeline diagram and phase table gain the `acceptance` node.

## 11. Out of scope

- Making the AC coverage metric meaningful → Sub-Plan 10 (until then the `AC_COVERAGE` criterion must be
  registered but marked `required: false` behind `MIN_AC_COVERAGE_PCT > 0`, so this sub-plan does not depend on it).
- The `SCOPE` criterion's data (orphaned-story detection at assignment time) → Sub-Plan 04. Until then compute it
  from `buildTraceabilityReport(state).orphanedStories`, which already works.
- `e2eStatus` → Sub-Plan 11. Until then the `E2E` criterion is `inconclusive` when no e2e report exists.
