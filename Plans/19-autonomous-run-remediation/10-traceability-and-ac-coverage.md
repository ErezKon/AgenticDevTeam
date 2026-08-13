# Sub-Plan 10 — Traceability Metric Repair & AC-Coverage Gating

**Depends on:** Sub-Plan 04 (assignment schema with `taskIds`/`additionalStoryIds`/`acIndexes`),
Sub-Plan 09 (executed test reports with mandatory tagged `cases`). Sub-Plan 03 consumes the output.
**Goal:** make "did we build and verify what was asked?" answerable — and make the answer able to stop a run.

---

## 1. Evidence

Both runs computed the correct answer, printed it, and ignored it.

```
pacman8     5957  AC coverage: 0/45 verified (0%), 2 implemented-untested, 41 missing
pacman8     5972  [Run] INFO Autonomous run complete.
retroboard3 16484  AC coverage: 0/26 verified (0%), 16 implemented-untested, 2 missing
retroboard3 16499  [Run] INFO Autonomous run complete.
```

`outputs/retroboard3-*/traceability.md` is the interesting case: **16 of 26 criteria are `implemented-untested`**
and coverage still reads `0.0%`. So even a genuinely half-built product scores zero — the metric cannot distinguish
"nothing was built" from "built but not tested", which makes it useless as a gate and is presumably why
`MIN_AC_COVERAGE_PCT` was left at `0`.

Every row in both matrices shows `Tests: [none]` or `Tests: 1 [none]`. Not one executed test case carried a
`storyId`.

### Root causes in code

| ID | Defect | Location |
|---|---|---|
| T1 | `coveragePct = verified / criteria` — `implemented` and `missing` are computed and then discarded. A partial build scores 0 | `traceability.ts:236-240` |
| T2 | `verified` requires a merged PR **and** an executed test case carrying matching `storyId` + `acIndex`. All three of `cases`, `cases[].storyId`, `cases[].acIndex` were `.optional()`, so the metric is structurally pinned at 0 % unless the LLM volunteers them | `traceability.ts:184-205`, `testing.schema.ts:53-58` |
| T3 | `hasMerged` accepts `status === 'approved'` as merged — an approved-but-unmerged PR delivered nothing | `traceability.ts:173` |
| T4 | `MIN_AC_COVERAGE_PCT` defaults to `0`, so the whole gate block (`nodes.ts:1343-1377`) is dead code | `config.ts:435-436` |
| T5 | Even when enabled, the gate only synthesises `Bug`s. `afterQaRouter` reads `testReports`, not `bugs`, so the AC gate **can never route** | `nodes.ts:1355-1369`, `graph.ts:59` |
| T6 | `traceability.ts:142-146` mutates `story.acceptanceCriteria` in place, and `buildTraceabilityReport` runs twice per run, so stories with no AC accumulate a synthetic AC into persisted state | `traceability.ts:142-146` |
| T7 | `TraceRow.taskIds` is a phantom — declared, but filled from `Task.storyId` rather than from assignments | `traceability.ts:18, 56-62, 152` |
| T8 | No `orphanedTasks` section; tasks with a missing/bogus `storyId` vanish silently | `traceability.ts:37-40, 56-62` |
| T9 | The report is written once at finalize and never used to make a decision | `nodes.ts:1774-1790` |

---

## 2. Work item 1 — Redefine the metric

Replace the single `coveragePct` with a graded scale plus a weighted score.

```ts
// ─── Coverage model ─────────────────────────────────────────────────────────
// Pre-Plan-19 `coveragePct` was `verified / criteria`, which scored a half-built
// product at 0% and was therefore unusable as a gate (MIN_AC_COVERAGE_PCT stayed 0).

export type AcStatus =
    | 'verified'              // merged + a passing tagged test
    | 'tested-failing'        // merged + a tagged test that FAILS  (new — was invisible)
    | 'implemented-untested'  // merged, no tagged test
    | 'planned-only'          // assigned, PR not merged
    | 'blocked'               // assigned, PR blocked/conflicted    (new — was 'planned-only')
    | 'missing';              // no assignment at all

export interface CoverageTotals {
    criteria: number;
    verified: number;
    testedFailing: number;
    implemented: number;
    plannedOnly: number;
    blocked: number;
    missing: number;
    /** verified / criteria — the strict bar. */
    verifiedPct: number;
    /** (verified + implemented) / criteria — "the code exists". */
    implementedPct: number;
    /** Weighted delivery score: verified 1.0, implemented 0.5, testedFailing 0.25, others 0. */
    deliveryScore: number;
}
```

`retroboard3` then reads `verifiedPct 0%`, `implementedPct 61.5%`, `deliveryScore 0.31` — which is an honest
description of what happened and is gateable. `pacman8` reads `verifiedPct 0%`, `implementedPct 4.4%`,
`deliveryScore 0.02`.

Also fix, in the same pass:

- **T3:** `hasMerged` requires `status === 'merged'` only. Add `isBlocked` for `status === 'blocked'` (introduced by
  Sub-Plan 07) and `status === 'open'` after the run ends.
- **T6:** do not mutate. `const criteria = story.acceptanceCriteria?.length ? story.acceptanceCriteria : ['(no acceptance criteria defined)'];`
- **T7:** populate `TraceRow.taskIds` from `assignment.taskIds` (union across the row's assignments), and keep the
  story→task index for the new `orphanedTasks` section.
- **T8:** add `orphanedTasks: string[]` (tasks whose `storyId` is missing or resolves to no story) and
  `unassignedTasks: string[]` (tasks in no assignment's `taskIds`) to `TraceabilityReport`, and render both in the
  markdown.
- Assignment indexing must consider `storyId` **and** `additionalStoryIds` (Sub-Plan 04), and `acIndexes` — a row
  whose `acIndex` is not in any covering assignment's `acIndexes` is `missing` even if the story has assignments.
  This is a strict improvement: it catches "the story was assigned but only 1 of its 5 criteria was".
- Register the bugfix sentinel story id (`'US-BUGFIX'`, Sub-Plan 04) so bugfix assignments stop being reported as
  orphaned "invented work" — both runs reported exactly that noise
  (`pacman8`: `BUGFIX-1-ASSIGN-008/009/010`; `retroboard3`: `BUGFIX-1-ASSIGN-051`).

---

## 3. Work item 2 — Derive coverage from executed tests, not from LLM claims (T2)

With Sub-Plan 09, `TestReport` has `source: 'executed' | 'claimed' | 'quality-gates'` and executed reports carry
mandatory `cases[]` with `storyId`/`acIndex` parsed from the `[US-003#1]` test-name tag.

Change `buildTraceabilityReport`:

1. Build `testRefs` **only** from `source === 'executed'` reports. `claimed` reports are excluded from the metric
   entirely (keep them for the report's "claimed vs executed" column — the discrepancy is diagnostic).
2. Keep planned refs from `testPlan` but mark them `planned` and never let them produce `verified`.
3. `testStatus` for a row: `pass` if any executed tagged case passed; `fail` if any executed tagged case failed and
   none passed; `none` otherwise. A failing tagged test now yields `tested-failing` rather than being erased into
   `implemented-untested` (which is what happened to every row in both runs).
4. Honour `iterationIndex` (Sub-Plan 03/09): use only the latest iteration's executed reports, so a fixed criterion
   stops being reported as failing.

Add a `Tests` column rendering that distinguishes the sources:

```
| E1 | US-003 | 1 | Eating a dot removes it and increments score | verified | #7 (merged) | 2 exec [pass], 3 planned |
```

---

## 4. Work item 3 — A gate that can actually stop the run (T4, T5, T9)

1. **Turn it on.** `MIN_AC_COVERAGE_PCT` default `0` → `70`, and add `MIN_AC_IMPLEMENTED_PCT` default `90`.
   Document both in `.env.example` with the rationale that the metric is now meaningful.
2. **Make it route.** The current implementation only synthesises `Bug`s, which `afterQaRouter` never reads. Two
   changes:
   - Emit a `TestReport`-shaped signal: `{ type: 'unit', framework: 'ac-coverage', source: 'quality-gates',
     status: coverageOk ? 'pass' : 'fail', total: criteria, passed: verified, failed: criteria - verified,
     iterationIndex }`. `afterQaRouter` then sees the failure with no router change.
   - **And** register it as an acceptance criterion (`AC_COVERAGE`) in Sub-Plan 03's `evaluateAcceptance`, marked
     `required: true` once `MIN_AC_COVERAGE_PCT > 0`.
3. **Feed the bugfix loop with specifics.** The current bug text is generic. Make each synthesised bug name the
   exact gap and, critically, the *action*:

   ```
   id: 'AC-US-003-1'
   title: 'Acceptance criterion not verified: US-003 AC#1'
   severity: 'critical'   (was 'major' — a missing requirement is not a nice-to-have)
   stepsToReproduce: 'Story US-003, AC#1: "Eating a dot removes it and increments score"'
   expectedBehavior: 'A test named "[US-003#1] …" exists, is executed, and passes'
   actualBehavior: 'Status "implemented-untested" — code merged in PR #7 but no tagged test executed'
   suspectedArea: 'src/game/Dots.ts (module MOD-DOTS, assignment ASSIGN-014)'
   ```

   Raise `MIN_AC_COVERAGE_MAX_BUGS` from `10` to `25`, and **prioritise `missing` over `implemented-untested`** when
   capping — a missing criterion needs implementation, which is more valuable than adding a test to existing code.
4. **Call it at the right times.** Today it runs in `qaNode` (behind the dead flag) and in `finalizeNode` (report
   only). Add a call in Sub-Plan 03's `acceptanceNode` so the final decision uses the freshest data, and log the
   funnel there.
5. Remove the `catch { warn }` swallow at `nodes.ts:1375-1377` in favour of recording a `verificationErrors` entry
   (Sub-Plan 03 §7) so a crashed AC gate reads as `inconclusive`, not as pass.

---

## 5. Work item 4 — Report quality

`renderTraceabilityMarkdown` additions:

1. Summary table gains `Tested but failing`, `Blocked`, `Implemented %`, `Delivery score`.
2. **Gap-first ordering.** Put `missing` and `tested-failing` rows at the top; a 61-row table where every row says
   `missing` buries the signal. Add a `## Top Gaps` section listing the 15 highest-priority gaps with their story,
   criterion text, and the assignment/module responsible.
3. New sections: `## Orphaned Tasks`, `## Unassigned Tasks`, `## Blocked Deliveries` (branch, PR, failure reason
   from Sub-Plan 06's `classifyPrFailure`).
4. `## Claimed vs Executed` — for each `claimed` report, the claim and the executed reality
   (`qa-unit claimed 12 passed / 0 failed; runner executed 0 tests`). Both runs would have shown this in bold.
5. Add a machine-readable sibling: `outputs/<run>/traceability.json` with the full `TraceabilityReport`. The
   markdown is for humans; the JSON is for regression tests and the dashboard.

Also surface coverage in the manifest (Sub-Plan 03 already adds an `acceptance` block; add
`traceability: { verifiedPct, implementedPct, deliveryScore, missing, blocked, orphanedTasks }`) and emit
`emitRunEvent('traceability:update', …)` at the end of each QA phase so the dashboard can plot coverage over
iterations.

---

## 6. Work item 5 — Close the loop from criterion to test

The reason coverage was 0 is that nobody was ever *asked* to write a test per criterion. Add explicit
responsibility, in three prompts:

1. **QA Lead** (`qa-lead.prompt.ts`): *"Your test plan MUST contain at least one item per acceptance criterion of
   every user story. Set `storyId` and `acIndex` on every item — they are required fields. State the count in your
   summary: 'N criteria, M plan items'."* Add a deterministic check in `qaNode`: if the plan does not cover every
   criterion, re-invoke once with the uncovered list (same pattern as Sub-Plan 04's gap repair), then record the
   remainder as `QA-PLAN-GAP` bugs.
2. **Developer persona**: *"For each acceptance criterion listed in your assignment, write at least one test whose
   name begins with `[<storyId>#<acIndex>]`. This is how the pipeline proves your work satisfies the requirement.
   An assignment whose criteria have no tagged tests is incomplete."*
3. **Reviewer persona**: already gains `criteriaVerdicts` in Sub-Plan 07 — cross-check it here: if a reviewer
   asserts `met: true` for a criterion that has no executed tagged test, record it as a
   `review-claim-unsupported` finding in the traceability report's `Claimed vs Executed` section. Cheap, and it
   discourages rubber-stamping.

---

## 7. Config additions / changes

```ts
/** Minimum verified AC coverage % for the AC_COVERAGE acceptance criterion. 0 = off. */
export const MIN_AC_COVERAGE_PCT = parseInt(process.env.MIN_AC_COVERAGE_PCT ?? '70', 10);   // was '0'
/** Minimum implemented (merged code exists) AC % — a weaker but mandatory bar. 0 = off. */
export const MIN_AC_IMPLEMENTED_PCT = parseInt(process.env.MIN_AC_IMPLEMENTED_PCT ?? '90', 10);
/** Max bugs synthesised for uncovered criteria. */
export const MIN_AC_COVERAGE_MAX_BUGS = parseInt(process.env.MIN_AC_COVERAGE_MAX_BUGS ?? '25', 10);  // was '10'
/** Write outputs/<run>/traceability.json alongside the markdown. */
export const TRACEABILITY_JSON = (process.env.TRACEABILITY_JSON ?? 'true') === 'true';
```

---

## 8. Tests

`tests/traceability.test.ts` (extend heavily; this module has the highest ratio of consequence to test coverage in
the repo).

Use the two real state files as fixtures — copy them (redacted of tokens) to
`tests/fixtures/states/pacman8-state.json` and `tests/fixtures/states/retroboard3-state.json` if Sub-Plan 03 has
not already done so.

- **pacman fixture** ⇒ `criteria: 45`, `missing: 41`, `verified: 0`, `implementedPct ≈ 4.4`,
  `orphanedStories.length === 18`, and `orphanedAssignments` no longer lists the three `BUGFIX-1-*` ids.
- **retroboard fixture** ⇒ `criteria: 26`, `implemented: 16`, `verifiedPct: 0`, `implementedPct ≈ 61.5`,
  `deliveryScore ≈ 0.31`, `blocked` counts the 4 conflicted PRs.
- A synthetic healthy fixture with executed tagged cases ⇒ `verified` for the tagged criteria,
  `implemented-untested` for the untagged ones.
- A `claimed` report with tagged cases ⇒ **does not** produce `verified` (only `executed` counts).
- An executed report with a failing tagged case ⇒ `tested-failing`, and the row is listed in `Top Gaps`.
- `hasMerged`: `status: 'approved'` ⇒ **not** merged; `'blocked'` ⇒ `blocked`.
- An assignment with `acIndexes: [0]` on a 3-criteria story ⇒ AC#1 and AC#2 are `missing`.
- **No mutation:** a story with `acceptanceCriteria: []` passed through `buildTraceabilityReport` twice still has
  `acceptanceCriteria.length === 0` afterwards (T6 regression test).
- `orphanedTasks` and `unassignedTasks` populated from a fixture with a bogus `Task.storyId`.

`tests/ac-coverage-gate.test.ts`:

- Coverage 0 % with `MIN_AC_COVERAGE_PCT=70` ⇒ a `framework: 'ac-coverage'`, `status: 'fail'` TestReport is emitted
  **and** `afterQaRouter` routes to `bugfix-triage`. (Before this sub-plan, the same input routed to `devops`.)
- Bug prioritisation: with 41 `missing` and 2 `implemented-untested` and a cap of 25, all 25 bugs are `missing`.
- Coverage 75 % ⇒ no failure signal.
- Crashed gate ⇒ `verificationErrors` entry, `inconclusive`, not pass.

---

## 9. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] Running the new `buildTraceabilityReport` on `outputs/retroboard3-*/state.json` yields
      `implementedPct ≈ 61.5%` rather than `0%` — i.e. the metric now describes reality.
- [ ] Running it on `outputs/pacman8-*/state.json` yields 41 missing and 18 orphaned stories, and the
      `AC_COVERAGE` acceptance criterion fails.
- [ ] `grep -n "criteria.push(" src/utils/traceability.ts` returns nothing (no in-place mutation).
- [ ] `grep -n "s === 'merged' || s === 'approved'" src/utils/traceability.ts` returns nothing.
- [ ] `outputs/<run>/traceability.json` is produced.
- [ ] `README.md` and `AI_Context.md` document the new coverage model (three numbers, not one) and the fact that
      only `source: 'executed'` reports count.

## 10. Out of scope

- Producing the executed, tagged test data → Sub-Plan 09 (hard dependency; do not start this sub-plan before it).
- The acceptance gate mechanics → Sub-Plan 03 (this sub-plan only supplies the `AC_COVERAGE` criterion's data).
