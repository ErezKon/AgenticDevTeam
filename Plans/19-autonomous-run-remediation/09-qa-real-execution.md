# Sub-Plan 09 — QA That Actually Tests

**Depends on:** Sub-Plan 01 (real gate execution, multi-root detection), Sub-Plan 05 (the contract tells QA where
code and tests live), Sub-Plan 08 (QA's tool budget). Works without 05 in degraded form.
**Goal:** replace LLM-self-reported test results with parsed output from a real test runner, and make "QA produced
nothing" impossible to mistake for "QA passed".

---

## 1. Evidence

### 1a. Zero tests executed, in eight QA phases, across two runs

```
pacman8      2209  [QA Lead] INFO Unit tests: 0 passed, 0 failed
pacman8      4672  [QA Lead] INFO Unit tests: 0 passed, 0 failed
pacman8      5253  [QA Lead] INFO Unit tests: 0 passed, 0 failed
pacman8      5817  [QA Lead] INFO Unit tests: 0 passed, 0 failed
retroboard3 10669  [QA Lead] INFO Unit tests: 0 passed, 0 failed
retroboard3 13436  [QA Lead] INFO Unit tests: 0 passed, 0 failed
retroboard3 ~14960 [QA Lead] INFO Unit tests: 0 passed, 0 failed
retroboard3 16278  [QA Lead] INFO Unit tests: 0 passed, 0 failed
```

Meanwhile the QA Lead kept producing elaborate plans it never executed:

```
pacman8      2184  [QA Lead] INFO Test plan: 41 unit, 16 e2e   (+ a 16,985-char mission document)
retroboard3 10627  [QA Lead] INFO Test plan: 25 unit, 13 e2e
retroboard3 13385  [QA Lead] INFO Test plan: 20 unit, 11 e2e
retroboard3 14912  [QA Lead] INFO Test plan: 26 unit, 13 e2e
retroboard3 16250  [QA Lead] INFO Test plan: 21 unit, 13 e2e
```

### 1b. `qa-unit` died to the loop guard every single time

```
pacman8 2186  [QA Lead] INFO QA Unit writing and running tests...
pacman8 2189  [fs-tools] list_dir: .
pacman8 2191  [fs-tools] list_dir: src
pacman8 2193  [fs-tools] read_file: src/App.tsx offset=1 limit=200
pacman8 2196  [loop-guard] WARN qa-unit: tool "list_dir" called 2 times with identical args (4/25) — returning cached result
pacman8 2201  [fs-tools] search_code: "class InputHandler" pattern=*.ts
pacman8 2204  [loop-guard] ERROR qa-unit: tool "list_dir" called 3 times with identical args (6/25) — poisoning all tools
pacman8 2209  [QA Lead] INFO Unit tests: 0 passed, 0 failed
pacman8 2210  [QA Unit] INFO Wrote artifact: qa-unit-mission.md (285 chars)
```

**Six tool calls, zero files written, zero tests run.** It searched for `class InputHandler`, which existed only on
the unmerged PR #2 branch, found nothing, and was disarmed. Identical shape at `retroboard3 16257-16279`, where it
searched `packages/backend/src` for `sessionService` while the merged code lived in root `src/` (the layout
incoherence from Sub-Plan 05).

The QA context blob was the largest in the run — `pacman8 run.log 5921`: `qa: 100,572 chars` — spent on four
invocations that produced 285-character artifacts.

### 1c. QA reported `pass` for a product with no tests and no working build

```
pacman8     2216  WARN QA agent reported status='pass' but quality gates FAILED — keeping both reports (gate report drives bug-fix loop)
retroboard3 10676  WARN QA agent reported status='pass' but quality gates FAILED — keeping both reports
```

`state.json` (pacman, lines 1786-1797, 1822-1833, 1895-1905) contains three reports with
`total: 0, passed: 0, failed: 0, status: "pass"`.

The warning is a **log line**, not a state mutation. And the prompt explicitly authorises the behaviour —
`src/agents/qa/qa-unit.prompt.ts:43-44`:

```
- If you run out of budget, STOP calling tools and return the TestReport with what you
  have (counts of 0 and a note are acceptable) — never return an empty response.
```

### 1d. Root causes in code

| ID | Defect | Location |
|---|---|---|
| Q1 | `testReports = [unitOutput?.testReport].filter(Boolean)` — the LLM's self-report goes straight into state | `nodes.ts:1278` |
| Q2 | `TestReportSchema.status` is `z.enum(['pass','fail'])` with unconstrained counts, so `total: 0, status: 'pass'` is legal | `testing.schema.ts:38-45` |
| Q3 | The prompt authorises reporting zeros | `qa-unit.prompt.ts:43-44` |
| Q4 | `cases` is `.optional()`, and `storyId`/`acIndex` inside it are `.optional()` — so the traceability signal is optional | `testing.schema.ts:53-58` |
| Q5 | `catch (err) { qaLog.error('QA Unit failed') }` leaves `unitOutput = { testReport: null, … }` ⇒ `testReports` empty ⇒ `afterQaRouter` sees no failures ⇒ routes to devops. **QA crashing is indistinguishable from QA passing** | `nodes.ts:1236, 1263-1267` |
| Q6 | QA Lead crash leaves an empty test plan and the run continues | `nodes.ts:1201, 1228-1232` |
| Q7 | No minimum test count, no coverage floor. `TestPlanSchema.coverageTargets` is collected and never compared to anything | `testing.schema.ts:28-32` |
| Q8 | `qa-unit` writes tests into the **main workspace** after the merge, so they are never gated by the PR flow and (in both runs) never committed anywhere useful | `nodes.ts` qaNode |

---

## 2. Work item 1 — Parse real runner output (fixes Q1)

New file `src/conductor/test-runner.ts`. QA's *claim* becomes irrelevant; the runner's *output* is the truth.

```ts
// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutedTestCase {
    testName: string;
    suite: string;
    file: string;
    status: 'pass' | 'fail' | 'skip';
    durationMs: number;
    error?: string;
    /** Parsed from the test name annotation `[US-003#1]`, when present. See §4. */
    storyId?: string;
    acIndex?: number;
}

export interface ExecutedTestReport {
    framework: string;
    root: string;                 // relDir of the stack root
    total: number; passed: number; failed: number; skipped: number;
    cases: ExecutedTestCase[];
    coverage?: { lines: number; statements: number; branches: number; functions: number };
    /** Raw runner exit code. */
    exitCode: number;
    /** True when the runner itself failed to start (config error, missing dep) — NOT the same as failing tests. */
    runnerError: boolean;
    runnerErrorDetail?: string;
}

export function runTests(root: StackRoot, opts: { timeoutMs: number; withCoverage: boolean }): ExecutedTestReport;
```

Implementation: run the root's real test command with a machine-readable reporter, then parse the file. Never parse
stdout prose.

| Stack | Command | Output parsed |
|---|---|---|
| node/jest | `<test script> -- --ci --reporters=default --reporters=jest-junit --coverage --coverageReporters=json-summary` with `JEST_JUNIT_OUTPUT_FILE=<out>/junit.xml` | JUnit XML + `coverage/coverage-summary.json` |
| node/vitest | `<test script> -- --run --reporter=junit --outputFile=<out>/junit.xml --coverage` | same |
| node/mocha | `--reporter xunit --reporter-option output=<out>/junit.xml` | JUnit XML |
| python/pytest | `python -m pytest -q --junitxml=<out>/junit.xml --cov --cov-report=json` | JUnit XML + `coverage.json` |
| maven | `mvn -B test` | `target/surefire-reports/*.xml` |
| gradle | `./gradlew test` | `build/test-results/test/*.xml` |
| go | `go test ./... -json -cover` | line-delimited JSON events |
| dotnet | `dotnet test --logger "trx;LogFileName=<out>/results.trx"` | TRX XML |
| rust | `cargo test -- -Z unstable-options --format json` (fallback: parse the summary line) | JSON events |

Notes:

- Write reports into `<outputPath>/test-reports/<root-slug>/` — **that directory already exists and is empty in
  both runs** (`outputs/*/test-reports/`), which is itself evidence that nothing ever wrote to it.
- Do **not** add `jest-junit` as a dependency of AgenticDevTeam. Install it into the *generated project* on demand
  (`npm install --no-save jest-junit`) and if that fails, fall back to `--json --outputFile=<out>/jest.json`
  (Jest's built-in JSON reporter needs no plugin) — **prefer the built-in `--json`** and only use JUnit for
  non-Jest runners. Simpler and dependency-free.
- If no test files exist for a root, return `total: 0` with `runnerError: false` — and let §5 turn that into a
  failure.
- Distinguish `runnerError` (jest config broken, module not found in setup, `Your test suite must contain at least
  one test`) from real failures. `retroboard3`'s only recorded bug was exactly a `runnerError`:
  `Cannot find module '@testing-library/jest-dom' from 'src/setupTests.ts'`.

### Wire-in

In `qaNode`, replace the trust in `unitOutput.testReport`:

```ts
// The QA agent's self-reported TestReport is advisory only. The authoritative
// report comes from parsing the real runner output. Both are kept; only the
// executed report drives routing, traceability and the acceptance gate.
const executed = roots.map(r => runTests(r, { timeoutMs: QA_TEST_TIMEOUT_MS, withCoverage: true }));
const authoritative = executedToTestReports(executed);          // type: 'unit', framework from the runner
if (unitOutput?.testReport) {
    compareClaimVsReality(unitOutput.testReport, authoritative, qaLog);  // logs discrepancies, records them
}
```

`compareClaimVsReality` must log loudly on divergence and record it on state as
`qaClaimDiscrepancies` (append reducer) — e.g.
`QA claimed 12 passed / 0 failed; the runner executed 0 tests. Using the runner result.`
This is the exact `pacman8` case and the discrepancy belongs in the manifest.

---

## 3. Work item 2 — Schema hardening (fixes Q2, Q4)

`src/agents/_shared/schemas/testing.schema.ts`:

```ts
export const TestReportSchema = z.object({
    type: z.enum(['unit', 'integration', 'e2e']),
    framework: z.string(),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** 'inconclusive' = the runner never executed (no tests, runner error, budget exhausted). */
    status: z.enum(['pass', 'fail', 'inconclusive']),
    /** Provenance. 'executed' reports come from a parsed runner; 'claimed' come from an LLM and are advisory. */
    source: z.enum(['executed', 'claimed', 'quality-gates']),
    /** Bugfix iteration this report belongs to (see Sub-Plan 03 — routers must ignore stale reports). */
    iterationIndex: z.number().int().nonnegative().default(0),
    runnerError: z.boolean().default(false),
    coverage: z.object({ lines: z.number(), statements: z.number(), branches: z.number(), functions: z.number() }).optional(),
    failures: z.array(/* unchanged */),
    agentId: z.string(),
    cases: z.array(z.object({
        testName: z.string(),
        storyId: z.string(),                 // was .optional()
        acIndex: z.number().int(),           // was .optional()
        status: z.enum(['pass', 'fail', 'skip']),
    })),                                      // was .optional()
})
.refine(r => !(r.total === 0 && r.status === 'pass'), {
    message: 'A report with 0 tests cannot have status "pass" — use "inconclusive".',
})
.refine(r => r.passed + r.failed + r.skipped <= r.total, { message: 'Case counts exceed total.' });
```

Migration: grep every producer and consumer of `TestReport` — `quality-gates.ts` (`gateReportToTestReport`),
`nodes.ts` (qaNode, e2eNode), `graph.ts` (`afterQaRouter`, `afterE2eRouter`), `traceability.ts`,
`run-snapshot.ts`, the manifest writer, and any test fixtures. For `source: 'claimed'` reports relax the
`cases` requirement to `.default([])` — you cannot force an LLM to be complete, but you *can* stop counting its
claims. **`source: 'executed'` reports must always carry `cases`** because the runner provides them.

For `TestPlanSchema`, make `storyId` and `acIndex` **required** on every item (they are `.optional()` today), and
add `moduleId: z.string().optional()` so the plan ties to the contract.

---

## 4. Work item 3 — Make tests traceable by construction (fixes Q4 properly)

Relying on an LLM to attach `storyId`/`acIndex` to every case failed in both runs (0 of 71 criteria verified).
Make it mechanical.

**Convention:** every generated test's name must be prefixed with its criterion tag.

```ts
it('[US-003#1] eating a dot removes it and increments the score', () => { … });
it('[US-003#-1] the maze renders without errors', () => { … });   // whole-story
```

- Add to the dev persona, `qa-unit.prompt.ts` and `qa-lead.prompt.ts`:
  *"Every test name MUST begin with `[<storyId>#<acIndex>]` where acIndex is the 0-based index into that story's
  acceptanceCriteria, or -1 for whole-story coverage. This tag is how the pipeline proves the requirement is
  verified. A test without a tag counts as untraced."*
- `test-runner.ts` parses the tag out of the runner's test names into `ExecutedTestCase.storyId`/`acIndex`.
  Regex: `/^\[([A-Za-z]+-\d+)#(-?\d+)\]\s*/`.
- Report untagged executed tests as `untracedTests` (count + first 10 names) — they still count for the
  minimum-test-count gate but not for AC coverage.

This is the change that makes Sub-Plan 10's coverage metric attainable, because it derives from parsed runner output
rather than from LLM goodwill.

---

## 5. Work item 4 — Test sufficiency gates (fixes Q7)

New file `src/conductor/test-sufficiency.ts`:

```ts
export interface SufficiencyViolation {
    kind: 'no-tests' | 'runner-error' | 'below-min-tests' | 'below-min-per-story'
        | 'coverage-below-floor' | 'all-tests-trivial' | 'story-untested';
    severity: 'critical' | 'major';
    detail: string;
}

export function checkTestSufficiency(input: {
    executed: ExecutedTestReport[];
    userStories: UserStory[];
    trivialTestFiles: string[];          // from Sub-Plan 02's detectTrivialTests; [] if absent
}): SufficiencyViolation[];
```

Rules:

| Rule | Threshold (config) | Severity |
|---|---|---|
| At least one root executed tests | — | `critical` |
| No `runnerError` on any root | — | `critical` |
| Total non-trivial executed tests ≥ `QA_MIN_TOTAL_TESTS` | default `max(5, storyCount)` | `critical` |
| Each story has ≥ `QA_MIN_TESTS_PER_STORY` tagged passing tests | default `1` | `major` (`critical` for stories whose assignments merged) |
| Line coverage ≥ `QA_MIN_COVERAGE_PCT` | default `40` — deliberately modest; raise later | `major` |
| Not every test file is trivial | — | `critical` |

Violations become `Bug`s with stable ids `QA-<kind>[-<storyId>]` fed into the bugfix loop, and they populate
Sub-Plan 03's `TESTS` acceptance criterion. `QA_ENFORCE_SUFFICIENCY` (config, default `'true'`) gates the whole
check; set `'false'` only for experiments.

Applied to the two real runs: `pacman8` ⇒ `no-tests` + `below-min-tests` (critical);
`retroboard3` ⇒ `runner-error` + `all-tests-trivial` + 13 × `story-untested`.

---

## 6. Work item 5 — QA crash ≠ QA pass (fixes Q5, Q6)

In `qaNode`:

1. QA Lead failure (`nodes.ts:1228-1232`): keep the catch, but push
   `verificationErrors.push({ stage: 'qa-lead', message })` (state field from Sub-Plan 03; if 03 has not landed,
   add it here) **and** synthesise a `critical` Bug `QA-LEAD-FAILED`. Do not proceed with an empty test plan
   pretending all is well.
2. QA Unit failure (`nodes.ts:1263-1267`): same, plus **still run `runTests`** — the deterministic runner does not
   need the agent. In both real runs, running the project's own `npm test` would have produced the truth
   (`No tests found, exiting with code 1` for pacman) with no LLM at all.
3. Emit an explicit `TestReport` with `source: 'executed'`, `status: 'inconclusive'`, `runnerError: true` when the
   runner could not run. Silence must never be an option: **`testReports` must never be empty after `qaNode`.**
   Add an assertion at the end of `qaNode` that throws in development if it is
   (`if (testReports.length === 0) throw new Error('invariant: qaNode produced no test report')`).

---

## 7. Work item 6 — Give QA a fighting chance

1. **Budget** (Sub-Plan 08 raises `TOOL_PIPELINE_MAX_TOOL_CALLS` 25 → 50 and the recursion limit 60 → 120). If
   Sub-Plan 08 has not landed, raise them here for the QA agents specifically.
2. **Workspace snapshot** (Sub-Plan 08 §2): inject the file tree, the test command and the test directories so
   `qa-unit` stops burning its budget on `list_dir`. If 08 has not landed, implement a minimal version for QA only:
   the `git ls-files` tree plus the verbatim `scripts` block.
3. **Delete the permission to report zeros.** Replace `qa-unit.prompt.ts:43-44` with:

   ```
   - You MUST run the test suite with run_command and report the REAL counts. The pipeline
     independently parses the test runner's output; a report that contradicts the runner is
     recorded as a discrepancy against you.
   - If you cannot run the suite, return status 'inconclusive' with runnerError true and the exact
     error output. Never return status 'pass' with 0 tests.
   ```

4. **Split the QA workload.** One agent writing tests for 20-41 plan items in one invocation is the reason it never
   finished. Change `qaNode` to invoke `qa-unit` **once per story** (or per module with Sub-Plan 05), with only
   that story's acceptance criteria and only the relevant source files in context, bounded by
   `QA_MAX_INVOCATIONS` (config, default `12`) and run with the same concurrency control as the dispatcher. Small
   scoped tasks are what these agents complete successfully — the same reason the dispatcher batches by branch.
5. **Fix Q8 — tests must be gated and committed.** QA-written tests currently land in the main workspace after all
   merges and are never verified by the PR flow. Either:
   - **(preferred)** run the QA test-writing phase on a dedicated branch `<slug>/test/qa-<iteration>` through the
     normal PR workflow, so the tests are gated, reviewed and merged like any other code; or
   - at minimum, commit and push them on the system branch and re-run `runTests` afterwards so the reported result
     reflects the committed tree.

   Choose (1). It reuses `executePRWorkflow` and gets Sub-Plan 06's durability for free.

---

## 8. Config additions

```ts
// ─── QA Sufficiency ─────────────────────────────────────────────────────────

/** Enforce test-sufficiency rules (min counts, coverage floor, per-story coverage). */
export const QA_ENFORCE_SUFFICIENCY = (process.env.QA_ENFORCE_SUFFICIENCY ?? 'true') === 'true';
/** Minimum total non-trivial executed tests. 0 = derive as max(5, storyCount). */
export const QA_MIN_TOTAL_TESTS = parseInt(process.env.QA_MIN_TOTAL_TESTS ?? '0', 10);
/** Minimum tagged passing tests per user story. */
export const QA_MIN_TESTS_PER_STORY = parseInt(process.env.QA_MIN_TESTS_PER_STORY ?? '1', 10);
/** Minimum line-coverage percentage. 0 = off. */
export const QA_MIN_COVERAGE_PCT = parseInt(process.env.QA_MIN_COVERAGE_PCT ?? '40', 10);
/** Timeout (ms) for a single test-runner invocation. */
export const QA_TEST_TIMEOUT_MS = parseInt(process.env.QA_TEST_TIMEOUT_MS ?? '600000', 10);
/** Max qa-unit invocations per QA phase (one per story/module). */
export const QA_MAX_INVOCATIONS = parseInt(process.env.QA_MAX_INVOCATIONS ?? '12', 10);
/** Route QA-authored tests through the PR workflow on a dedicated test branch. */
export const QA_TESTS_VIA_PR = (process.env.QA_TESTS_VIA_PR ?? 'true') === 'true';
```

---

## 9. Tests

`tests/test-runner-parsers.test.ts` — the highest-value tests in this sub-plan. Use **real** runner output
fixtures under `tests/fixtures/test-reports/`:

- Jest `--json` output with 12 passing, 3 failing, 1 skipped ⇒ correct counts, per-case names, error messages.
- Jest output for a **suite-level failure** (`Cannot find module '@testing-library/jest-dom' from 'src/setupTests.ts'`
  — copy the literal text from `retroboard3 state.json:5515`) ⇒ `runnerError: true`, not `failed: 1`.
- Jest output for `No tests found, exiting with code 1` (copy from `pacman8 state.json:1906-1928`) ⇒
  `total: 0`, `runnerError: false`, and `checkTestSufficiency` returns `no-tests` critical.
- JUnit XML (pytest, surefire), TRX (dotnet), `go test -json` ⇒ correct counts.
- `coverage-summary.json` parsed into the `coverage` field.
- Tag parsing: `[US-003#1] eating a dot …` ⇒ `storyId: 'US-003', acIndex: 1`; `[US-003#-1]` ⇒ `acIndex: -1`;
  untagged ⇒ counted in `untracedTests`.

`tests/test-sufficiency.test.ts`:

- pacman fixture (0 tests, 20 stories) ⇒ `no-tests` + `below-min-tests`.
- retroboard fixture (1 trivial test, runner error, 13 stories) ⇒ `runner-error`, `all-tests-trivial`,
  13 × `story-untested`.
- A healthy fixture (25 tagged tests, 62 % coverage, all stories covered) ⇒ zero violations.
- Coverage 35 % with a floor of 40 ⇒ `coverage-below-floor` major.

`tests/testing-schema.test.ts`:

- `{ total: 0, status: 'pass' }` is **rejected** by the refine.
- `source: 'executed'` without `cases` is rejected.
- `source: 'claimed'` without `cases` is accepted.

`tests/qa-node.test.ts` (mock the agents):

- qa-unit throws ⇒ `testReports` still contains an `executed` report and a `QA-*` bug exists.
- Claim/reality divergence ⇒ `qaClaimDiscrepancies` populated and the executed report is the one used for routing.

---

## 10. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -rn "counts of 0 and a note are acceptable" src/` returns nothing.
- [ ] `grep -n "unitOutput?.testReport" src/conductor/nodes.ts` — the claimed report is no longer the routing input.
- [ ] `TestReportSchema` rejects `{ total: 0, status: 'pass' }`.
- [ ] Running `runTests` against `generated-projects/pacman8` produces `total: 0` and
      `checkTestSufficiency` returns a `critical` `no-tests` violation.
- [ ] Running `runTests` against `generated-projects/retroboard3` produces `runnerError: true` (the
      `@testing-library/jest-dom` resolution failure) — or, if deps are installed, 1 test that
      `detectTrivialTests` classifies as trivial ⇒ `all-tests-trivial`.
- [ ] `outputs/<run>/test-reports/` is no longer empty after a QA phase.
- [ ] `README.md` QA phase description and `AI_Context.md` phase table updated: QA reports are parsed from real
      runner output; the schema change is listed as a cascading change per `AI_Context.md` rule 5.

## 11. Out of scope

- The AC coverage metric itself → Sub-Plan 10 (this sub-plan supplies its input).
- E2E / Playwright → Sub-Plan 11.
- Do not add a coverage tool dependency to AgenticDevTeam; use each project's own runner flags.
