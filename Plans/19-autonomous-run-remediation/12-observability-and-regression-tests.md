# Sub-Plan 12 — Observability & Offline Regression Suite

**Depends on:** all previous sub-plans (it asserts their invariants). Run it last.
**Goal:** make the next failure diagnosable in minutes instead of a 6,000-line log read, and make these two
failures permanently un-repeatable via offline regression tests.

---

## 1. Evidence — why observability failed the post-mortem

Diagnosing these two runs required reading a 745 KB and a 2.1 MB log line by line. Everything needed to spot the
failures existed *somewhere* but was never surfaced:

| Signal that existed | Where it was buried | What it would have told us |
|---|---|---|
| `Assignments: 7` right after `Stories: 20, Tasks: 26` | `pacman8 run.log 40` / `75` | 19 assignments lost at the Team Leader |
| `Quality gates FAILED: 3 executed, 3 failed` immediately before `PR #3 merged` | `pacman8 3211` / `3638` | the merge gate is a no-op |
| `Dispatch complete: 0 total file changes, 0 PRs, 0 artifacts` twice | `pacman8 5200`, `5769` | the run was unrecoverable 20 minutes before it ended |
| `poisoning all tools` × 289 | `retroboard3` throughout | agents never got to work |
| `write_file: package.json` twice inside a gate-repair attempt | `retroboard3 8742`, `8808` | the gate was being rewritten |
| `AC coverage: 0/45 verified (0%)` | `pacman8 5957`, one line before "complete" | nothing was verified |
| `outputs/*/test-reports/` empty in both runs | filesystem | no test ever ran |
| 11 of 20 `fileChanges` paths absent from disk | `state.json` vs the tree | the success metric is fiction |

The dashboard was no help: `EVENT_BUFFER_SIZE=500` and both manifests report `"eventCount": 500` — the buffer was
**saturated**, so the earliest and most diagnostic events were evicted.

---

## 2. Work item 1 — The run ledger

New file `src/utils/run-ledger.ts`. A single append-only, machine-readable JSONL file that records every decision
with its evidence: `outputs/<run>/ledger.jsonl`.

```ts
// ─── Ledger ─────────────────────────────────────────────────────────────────

export type LedgerEntry =
    | { t: string; kind: 'phase';        phase: PhaseName; event: 'start' | 'end'; durationMs?: number }
    | { t: string; kind: 'plan-funnel';  epics: number; stories: number; criteria: number; tasks: number; assignments: number; unassignedStories: string[]; unassignedTasks: string[] }
    | { t: string; kind: 'agent';        agentId: string; phase: PhaseName; invocation: number; toolCalls: { read: number; write: number; shell: number }; respawns: number; poisoned: boolean; filesWritten: string[]; filesClaimed: string[]; phantoms: string[]; outcome: 'ok' | 'failed' | 'budget-exhausted'; error?: string }
    | { t: string; kind: 'gate';         branch: string | null; stacks: string[]; steps: Array<{ step: string; mode: string; passed: boolean; skipped: boolean; ms: number }>; passed: boolean; inconclusive: boolean }
    | { t: string; kind: 'integrity';    branch: string; findings: TamperFinding[] }
    | { t: string; kind: 'product-verify'; artifacts: number; artifactsFailed: number; unresolvedRefs: number; smoke: string }
    | { t: string; kind: 'review';       prNumber: number; reviewerId: string; outcome: 'approved' | 'changes_requested' | 'abstained'; reason?: string; blocking: number }
    | { t: string; kind: 'merge';        prNumber: number; decision: boolean; reason: string; blockers: string[] }
    | { t: string; kind: 'test-run';     root: string; framework: string; total: number; passed: number; failed: number; skipped: number; coverage?: number; runnerError: boolean; untraced: number }
    | { t: string; kind: 'coverage';     verifiedPct: number; implementedPct: number; deliveryScore: number; missing: number; blocked: number }
    | { t: string; kind: 'acceptance';   status: AcceptanceStatus; blockers: string[]; unrecoverable: boolean }
    | { t: string; kind: 'salvage';      branch: string; patchPath: string; reason: string };

export function appendLedger(outputPath: string, entry: Omit<LedgerEntry, 't'>): void;
```

Write synchronously with `fs.appendFileSync` (a run is not throughput-bound) so a crash still leaves the ledger.
Emit an entry at every site the corresponding sub-plan touches — that is the whole point: the ledger is the union of
the evidence the post-mortem had to reconstruct by hand.

Add `src/utils/ledger-report.ts` producing `outputs/<run>/run-report.md`: a one-page, human-first summary derived
purely from the ledger.

```markdown
# Run Report — Pacman8 — FAILED

## Verdict
REJECTED — 4 blockers:
  1. BUILD: `npm run build` failed: Could not resolve "./index.css" from "src/main.tsx"
  2. RESOLVE: 1 unresolved reference (src/main.tsx:4 → ./index.css)
  3. TESTS: 0 tests executed across 1 stack root
  4. SCOPE: 18 of 20 stories have no merged assignment

## Plan funnel
10 epics → 20 stories (45 AC) → 26 tasks → 7 assignments   ⚠ 18 stories unassigned, 19 tasks unassigned

## Delivery
Branches: 5   Merged: 4   Blocked: 1 (salvaged → outputs/<run>/salvage/pacman8-feature-us-001-…)
Files delivered: 14   Phantom fileChanges: 11 ⚠
Coverage: verified 0% | implemented 4% | delivery score 0.02

## Agent health
poisoned invocations: 117   respawns: 80 (0 files carried: 74) ⚠
agents that produced 0 files: senior-frontend (12/24), junior-react (6/8)

## Verification
quality gates: 11 runs, 11 failed   product verify: artifacts 0/1, unresolved refs 1, smoke fail
integrity findings: 0              tests executed: 0
E2E: skipped-no-services (no Dockerfile; local-server path unavailable)

## Cost
1,421 calls · 5,416,745 tokens · $34.01 · 82 min
Wasted after unrecoverable (dispatch rounds 3-4): ~20 min, ~380 calls, ~$7 ⚠
```

That last line — cost incurred *after* the run was already doomed — is the number that justifies
`RUN_FAIL_POLICY=halt` to anyone who questions it.

---

## 3. Work item 2 — Fix the event stream

1. Raise `EVENT_BUFFER_SIZE` from `500` to `5000`, and **never evict** high-severity events: keep two buffers, a
   ring for routine events and an unbounded (capped at 500) list for `phase:*`, `gate:result`, `pr:blocked`,
   `acceptance:result`, `integrity:*`, `plan:coverage`, `run:error`. Both manifests reporting exactly
   `"eventCount": 500` proves the current buffer silently truncated the run's history.
2. Emit the events the dashboard needs but never received (`emitRunEvent` calls, one per sub-plan's new signal):
   `plan:coverage`, `gate:result` (already exists — extend the payload), `product-verify:result`,
   `integrity:finding`, `pr:blocked`, `pr:conflict`, `review:abstained`, `test-run:result`,
   `traceability:update`, `acceptance:result`, `agent:budget-exhausted`, `agent:respawn`, `salvage:written`.
3. Dashboard (`dashboard/src/app/`): add a **Run Health** panel showing the plan funnel, the blocker list, coverage,
   and the agent-health counters. Keep it minimal — a table and a status badge, matching the existing Angular 19
   standalone-component style. Read `dashboard/src/app/pages/dashboard/` first and follow its patterns; do not
   introduce a charting dependency (a Chart.js dependency already exists for the token report — reuse it only if it
   is already wired into the dashboard bundle).
4. `src/index.ts` WebSocket: include the new statuses (`failed`, `partial`, `inconclusive`) in `run:complete`, and
   add a `run:blocked` message when `RUN_FAIL_POLICY='halt'` triggers an early stop.

---

## 4. Work item 3 — Run invariants (assertions, not hopes)

New file `src/conductor/run-invariants.ts`. Checked at phase boundaries; violations are logged as `error`, recorded
on state, and (in `strict` mode) fail the run.

```ts
export interface InvariantViolation { id: string; phase: PhaseName; detail: string; }
export function checkInvariants(state: ProjectStateType, phase: PhaseName): InvariantViolation[];
```

| id | Invariant | Would have caught |
|---|---|---|
| `INV-PLAN-COVERAGE` | after `team-leader`: every story appears in some assignment | pacman: 18 orphans |
| `INV-NO-EMPTY-ASSIGNMENTS` | after `team-leader`: `assignments.length > 0` | — |
| `INV-WORKSPACE-HAS-SOURCE` | after `development`: `!looksSourceless(gitLsFiles)` **and** ≥1 stack root detected | pacman |
| `INV-NO-PHANTOMS` | after `development`: every `fileChanges[].path` exists on disk or is on an unmerged branch | pacman: 11 phantoms |
| `INV-TESTREPORT-EXISTS` | after `qa`: `testReports` contains ≥1 `source: 'executed'` report | both runs |
| `INV-GATE-RAN` | after `qa`: the latest gate report has ≥1 executed, non-absent step | — |
| `INV-NO-CRITICAL-INTEGRITY` | after `development`: zero unreverted `critical` `TamperFinding`s | retroboard |
| `INV-E2E-STATUS-SET` | after `e2e`: `e2eStatus !== 'not-run'` | both runs |
| `INV-STATUS-MATCHES-ACCEPTANCE` | at `finalize`: terminal status is consistent with `acceptance.status` | both runs |
| `INV-NO-MERGED-EMPTY-PR` | after `development`: no PR with `status: 'merged'` and 0 real file changes | retroboard: 7 PRs with `_(changes will be listed after development)_` |

`RUN_INVARIANTS_MODE` (config: `off` | `warn` | `strict`, default `warn`; `strict` in tests). In `strict`, a
violation throws so unit tests catch regressions immediately.

---

## 5. Work item 4 — Permanent regression fixtures from the two failed runs

This is the most valuable deliverable in this sub-plan: turn the post-mortem into automated tests.

1. Create `tests/fixtures/runs/pacman8/` and `tests/fixtures/runs/retroboard3/` containing:
   - `state.json` — copied from `outputs/*/state.json`, **redacted** (strip any token, `GITHUB_TOKEN`,
     `OAUTH_CLIENT_SECRET`, and the `x-access-token:` URLs; write a small `scripts/redact-state.ts` helper and
     assert in a test that no fixture matches `/gh[pousr]_[A-Za-z0-9]{20,}|client_secret|x-access-token/`).
     **Do this carefully — `.env` in the working tree contains a live OAuth secret and two live PATs.**
   - `run-manifest.json`, `traceability.md` — as-is.
   - `log-excerpts.txt` — the specific line ranges quoted throughout Plan 19, with their original line numbers, so
     tests can assert against real log text without committing 2.8 MB.
   - `tree.txt` — `git ls-files`-style listing of the delivered project, so `findUnresolvedReferences` and
     `lintLayout` tests can run without the projects being present.
2. Create `tests/regression-plan19.test.ts` — one `describe` per sub-plan, each asserting the fixture now produces
   the correct verdict:

   ```
   describe('Plan 19 regression — pacman8', () => {
     it('acceptance gate rejects it',                    …expect(evaluateAcceptance(pacmanState).status).toBe('rejected'));
     it('finds the missing index.css',                   …expect(resolveIssues).toContainEqual({ file: 'src/main.tsx', specifier: './index.css', … }));
     it('reports 18 orphaned stories',                   …);
     it('plan coverage rejects 7 assignments for 20 stories', …);
     it('field repair keeps all 26 assignments',         …);
     it('sufficiency reports no-tests',                  …);
     it('terminal status is failed under halt and finalize, completed only under legacy', …);
     it('detects 11 phantom fileChanges',                …);
   });

   describe('Plan 19 regression — retroboard3', () => {
     it('tamper detection flags the echo build script as critical', …);
     it('trivial-test detection flags __tests__/math.test.js',     …);
     it('merge decision blocks PR #10',                            …);
     it('merge decision blocks PR #14 (no production code)',       …);
     it('layout lint flags the root-src / packages split',         …);
     it('coverage reports implementedPct ~61.5, not 0',            …);
     it('discards the 2 hallucinated serviceUrls',                 …);
     it('e2eStatus is "error", not silence',                       …);
   });
   ```

   Every one of these must **fail** against the pre-Plan-19 code and pass after. If any passes before the
   corresponding sub-plan lands, the test is wrong — fix the test, not the assertion.

3. Add `npm run test:regression` to `package.json` mapping to this file, and include it in `test:unit`.

---

## 6. Work item 5 — Offline end-to-end confidence

1. **Cassette a fixed run.** Per `AI_Context.md`, `LLM_CASSETTE_MODE=record CASSETTE_NAME=… GITHUB_MODE=local`
   records LLM traffic. After Waves 1–3 are complete, record one full greenfield run against a **small** spec
   (write `specs/new/todo-list.md` — 5 stories, single-root React SPA; `pacman.md` at 20 stories is too large for a
   cassette) and commit the cassette. Then `npm run test:replay` becomes a real pipeline regression test.
2. Add `tests/pipeline-replay-plan19.test.ts` asserting, on the replayed run:
   - terminal status `completed`
   - `acceptance.status === 'accepted'`
   - ≥1 executed test report with `total > 0`
   - `verifiedPct >= MIN_AC_COVERAGE_PCT`
   - zero phantom fileChanges, zero critical integrity findings, zero invariant violations
   - the delivered tree builds (the recorded gate results say `passed`)
3. Document the recording procedure in `README.md` under Testing, including the exact env vars, and note that the
   cassette must be re-recorded whenever a prompt changes materially.

---

## 7. Work item 6 — Documentation truth-up

Both `README.md` and `AI_Context.md` currently overstate the system. Fix the specific claims:

| Claim | Location | Reality |
|---|---|---|
| "autonomously designs, builds, tests, and containerizes a complete software product" | `README.md:3` | qualify with the acceptance gate and the fail statuses |
| "reduce LLM input tokens by 60-75%" | `README.md:443` | over-compaction caused re-reads; restate as tuned-for-correctness (Sub-Plan 08) |
| "Test with unit/integration suites and Playwright MCP-driven end-to-end browser tests" | `README.md:46` | E2E has never successfully run; document the preflight and the local-server fallback |
| "QA Unit writes & runs tests" | phase table | now: writes tests on a PR branch; the conductor runs them and parses the output |
| Gotchas 3 & 4 (recursion limits, max tool calls) | `AI_Context.md:612-613` | new numbers from Sub-Plan 08 |
| Missing gotchas | `AI_Context.md` | add: protected config files are refused for repair agents; only `source: 'executed'` test reports count; `completed` now means accepted; `.agent/` is gitignored in generated projects |

Add a new `AI_Context.md` section **"Failure modes observed in production runs"** summarising the index's PART A in
~20 lines, with a pointer to `Plans/19-autonomous-run-remediation/00-INDEX.md`. Future AI sessions must not
re-derive this.

---

## 8. Config additions

```ts
/** Events kept in the ring buffer (was 500 — both post-mortem runs saturated it). */
export const EVENT_BUFFER_SIZE = parseInt(process.env.EVENT_BUFFER_SIZE ?? '5000', 10);
/** High-severity events retained regardless of ring eviction. */
export const EVENT_PRIORITY_BUFFER_SIZE = parseInt(process.env.EVENT_PRIORITY_BUFFER_SIZE ?? '500', 10);
/** Write outputs/<run>/ledger.jsonl and run-report.md. */
export const RUN_LEDGER_ENABLED = (process.env.RUN_LEDGER_ENABLED ?? 'true') === 'true';
/** Run-invariant enforcement: 'off' | 'warn' | 'strict'. */
export const RUN_INVARIANTS_MODE = (process.env.RUN_INVARIANTS_MODE ?? 'warn') as 'off' | 'warn' | 'strict';
```

---

## 9. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green; `npm run test:regression` green.
- [ ] No fixture under `tests/fixtures/runs/` matches
      `/gh[pousr]_[A-Za-z0-9]{20,}|client_secret|x-access-token|OAUTH_CLIENT_SECRET/` — assert this in a test,
      not by eye.
- [ ] `outputs/<run>/ledger.jsonl` and `run-report.md` are produced by a replayed run.
- [ ] Every one of the 16 regression assertions in §5.2 fails on a pre-Plan-19 checkout
      (verify with `git stash`, or by setting the escape-hatch flags: `RUN_FAIL_POLICY=legacy`,
      `REVIEW_MERGE_POLICY=legacy`, `GATE_INTEGRITY_MODE=off`, `PLAN_COVERAGE_MODE=off`,
      `MIN_AC_COVERAGE_PCT=0` — **this is the cheapest proof and the reason those escape hatches exist**).
- [ ] `README.md` and `AI_Context.md` updated per §7, including the new "Failure modes observed in production runs"
      section.
- [ ] `Plans/19-autonomous-run-remediation/00-INDEX.md` gains a short "Status" table at the top recording which
      sub-plans have landed, with dates — future sessions need it.

## 10. Final gate for the whole plan

After this sub-plan, run one supervised autonomous run per spec and require:

| Spec | Required outcome |
|---|---|
| `specs/new/todo-list.md` (new, small) | terminal status `completed`, `acceptance.status: 'accepted'`, tests executed > 0, product builds and renders |
| `specs/new/pacman.md` | either `completed` **or** `failed` with a blocker list that a human agrees with — **never** `completed` for a non-working product |
| `specs/new/team-retro-board.md` | same |

The success criterion for Plan 19 is not "pacman works". It is: **the pipeline never again reports success for a
product that does not build, and when it fails it says exactly why, early, and preserves the work it did.**
