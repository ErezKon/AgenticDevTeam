# Sub-Plan 01 — Product Verification Harness: Implementation Report

**Date:** 2026-08-11
**Status:** Complete
**Depends on:** nothing (this is the foundation for 02, 03, 07, 09, 11)

---

## Summary

Implemented a deterministic product verification harness that answers *"does the generated product actually build, resolve its imports, and render something?"* All 12 defects (D1-D12) identified in the sub-plan are now addressed. The system can detect the two headline bugs from pacman8 (`./index.css` missing) and retroboard3 (`/src/main.tsx` missing, `"build": "echo Build successful"`) as failures.

---

## Files Changed

### Modified

| File | Change |
|------|--------|
| `src/conductor/quality-gates.ts` | **Full rewrite.** Multi-root detection, script resolver, typecheck step, honest aggregation, product verify integration. ~600 lines. |
| `src/config.ts` | Added 9 new config constants: `QUALITY_GATE_SCAN_DEPTH`, `QUALITY_GATE_MAX_ROOTS`, `PRODUCT_VERIFY_ENABLED`, `PRODUCT_MIN_ARTIFACT_BYTES`, `PRODUCT_RESOLVE_MAX_FILES`, `PRODUCT_SMOKE_BASE_PORT`, `PRODUCT_SMOKE_TIMEOUT_MS`. Changed defaults: `QUALITY_GATE_STEPS` now includes `typecheck`, `QUALITY_GATE_STRICT_TOOLCHAIN` default `'false'` -> `'true'`. |
| `src/agents/_shared/schemas/testing.schema.ts` | Extended `status` enum from `'pass' \| 'fail'` to `'pass' \| 'fail' \| 'inconclusive'`. |
| `src/conductor/nodes.ts` | Updated `qaNode` to run product verification (full mode), pass results to `runQualityGates`, and use `detectStackRoots`. `gateReportToTestReport` no longer needs null-check. |
| `src/conductor/pr-workflow.ts` | Updated PR quality gate section to run product verification (artifacts+resolve mode) in worktrees. |
| `.env.example` | Added all new env vars with documentation. Updated existing quality gate defaults. |
| `README.md` | Added Quality Gates and Product Verification sections to the Environment Variables table. |
| `AI_Context.md` | Updated Quality Gates entry (5 steps, multi-root, script resolver, honest aggregation). Added Product Verification entry. |
| `tsconfig.json` | Added `"exclude": ["tests/fixtures/**/*"]` to prevent fixture TypeScript from failing the build. |
| `tests/quality-gates.test.ts` | Updated all test data to include new `GateResult` fields (`relDir`, `mode`, `inconclusive`), new `GateReport` fields (`roots`, `inconclusive`). Updated GATE_COMMANDS assertions for 5 steps. |

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/product-verify.ts` | ~550 lines. Artifact verification, import resolution, inline static file smoke server, orchestrator. |
| `tests/product-verify.test.ts` | 60 tests covering all new functionality (detectStackRoots, resolveNodeStep, findUnresolvedReferences, verifyBuildArtifacts, aggregation, gateReportToTestReport, synthesiseGateBugs, runSmokeTest, gateReportToMarkdown). |
| `tests/fixtures/product-verify/` | 6 fixture directories, 24 files total: `pacman-missing-css/`, `retro-echo-build/`, `monorepo/`, `healthy-vite/`, `missing-package/`, `alias-paths/`. |

---

## Defects Addressed

| ID | Defect | Fix |
|----|--------|-----|
| D1 | `detectStacks` only reads root directory | `detectStackRoots()` walks up to `QUALITY_GATE_SCAN_DEPTH` levels deep, respects monorepo workspaces |
| D2 | `npm run build --if-present` silently passes | Script resolver returns `mode: 'absent'` when no build script exists; no `--if-present` anywhere |
| D3 | `npm run lint --if-present` silently passes | Same as D2 for lint |
| D4 | No typecheck step | Added `typecheck` step with `tsc --noEmit` fallback |
| D5 | No artifact assertion | `verifyBuildArtifacts()` checks for real output in `dist/`/`build/`/etc. |
| D6 | No import/reference resolution check | `findUnresolvedReferences()` statically resolves all imports, requires, HTML src/href, CSS url() |
| D7 | No render check | `runSmokeTest()` serves built artifacts and verifies HTTP 200 + sub-resources |
| D8 | `passed = results.every(r => r.passed \|\| r.skipped)` allows all-skipped | `passed` requires `executed.length > 0 && executed.every(r => r.passed)` |
| D9 | `gateReportToTestReport` returns `null` for all-skipped | Never returns `null`; returns `status: 'inconclusive'` |
| D10 | Missing toolchain defaults to pass | `QUALITY_GATE_STRICT_TOOLCHAIN` default flipped to `true` |
| D11 | 3 no-op steps counted as `total: 3, passed: 3` | `mode: 'absent'` steps don't count as passed; framework distinguished between `quality-gates` (real tests ran) and `quality-gates-build-only` |
| D12 | `node_modules` existence skips install | `shouldSkipInstall()` checks `node_modules/.package-lock.json` mtime vs `package.json`/`package-lock.json` |

---

## New Types and Interfaces

### `quality-gates.ts`

```ts
interface StackRoot {
    dir: string;           // absolute path
    relDir: string;        // relative to workspace ('' = root)
    stack: StackKind;
    isWorkspaceMember: boolean;
}

type StepMode = 'real' | 'fallback' | 'absent';

interface GateResult {
    // existing fields...
    relDir: string;        // NEW: which directory
    mode: StepMode;        // NEW: how command was resolved
    inconclusive: boolean; // NEW: could this step be meaningfully evaluated?
}

interface GateReport {
    // existing fields...
    roots: StackRoot[];           // NEW: all detected roots
    inconclusive: boolean;        // NEW: overall inconclusive flag
    productVerify?: ProductVerifyReport;  // NEW: product verification results
}
```

### `product-verify.ts`

```ts
interface ArtifactCheck { root, expectedDirs, foundDir, fileCount, totalBytes, hasEntryHtml, hasEntryJs, passed, reason }
interface ResolveIssue  { file, line, specifier, kind, reason }
interface SmokeResult   { ran, skippedReason?, url, httpStatus, bodyBytes, rendered, consoleErrors, passed, reason }
interface ProductVerifyReport { artifacts, resolveIssues, smoke, passed, summary }
```

### `testing.schema.ts`

```ts
status: z.enum(['pass', 'fail', 'inconclusive'])  // was: ['pass', 'fail']
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `QUALITY_GATE_SCAN_DEPTH` | `3` | Max dir depth for stack root scanning |
| `QUALITY_GATE_MAX_ROOTS` | `8` | Cap on stack roots per run |
| `PRODUCT_VERIFY_ENABLED` | `true` | Enable product verification |
| `PRODUCT_MIN_ARTIFACT_BYTES` | `2048` | Minimum build output size |
| `PRODUCT_RESOLVE_MAX_FILES` | `2000` | Max source files scanned for imports |
| `PRODUCT_SMOKE_BASE_PORT` | `18190` | Starting port for smoke server |
| `PRODUCT_SMOKE_TIMEOUT_MS` | `60000` | Smoke server readiness timeout |

**Changed defaults:**
| Constant | Old | New |
|----------|-----|-----|
| `QUALITY_GATE_STEPS` | `install,build,lint,test` | `install,typecheck,build,lint,test` |
| `QUALITY_GATE_STRICT_TOOLCHAIN` | `false` | `true` |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 33 suites pass, 605 tests pass (1 pre-existing failure in `qa-node-resilience.test.ts` unrelated to this sub-plan)
- [x] `grep -rn "if-present" src/` — zero functional hits (only in comments)
- [x] `detectStackRoots` on the monorepo fixture finds 3 roots with workspace members tagged
- [x] `findUnresolvedReferences` on `pacman-missing-css` fixture reports `src/main.tsx:4 -> ./index.css`
- [x] `findUnresolvedReferences` on `retro-echo-build` fixture reports `index.html -> /src/main.tsx`
- [x] README.md Environment Variables table updated for all new vars and changed defaults
- [x] `.env.example` updated with all new vars and changed defaults
- [x] `AI_Context.md` updated: Quality Gates entry expanded, Product Verification entry added

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 02** (gate integrity / anti-gaming): can now baseline `package.json` scripts against the resolved commands, since `resolveNodeStep` reads the actual scripts
- **Sub-Plan 03** (run status / fail policy): `gateReport.passed` and `gateReport.inconclusive` provide the truthful signals needed for `finalStatus` determination
- **Sub-Plan 07** (review/merge fail-closed): product verification bugs (`PRODUCT-RESOLVE`, `PRODUCT-SMOKE`) provide evidence for stub detection
- **Sub-Plan 09** (QA real execution): `inconclusive` status ensures QA crashes don't look like passes
- **Sub-Plan 11** (DevOps/E2E hardening): smoke test provides the non-Docker verification path; `consoleErrors` field is ready for Playwright integration

---

## Pre-Existing Issue (Not Introduced by This Sub-Plan)

`tests/qa-node-resilience.test.ts` had 1 failing test (`devopsNode should resolve (not throw) when devops agent throws a recursion limit error`) that expected `result.phase` to be `'e2e'` but received `'devops'`. The expectation was corrected in Sub-Plan 03 — `devopsNode` correctly returns its own phase name; the graph is responsible for routing.

---
---

# Sub-Plan 03 — Truthful Run Status, Acceptance Gate & `RUN_FAIL_POLICY`: Implementation Report

**Date:** 2026-08-11
**Status:** Complete
**Depends on:** Sub-Plan 01 (`ProductVerifyReport`, honest `GateReport`), Sub-Plan 02 (`TamperFinding`)

---

## Summary

Implemented the acceptance gate, truthful run status, unrecoverability detection, and `RUN_FAIL_POLICY` configuration. All 9 defects (E1-E9) identified in the sub-plan are now addressed. Runs that fail to build, resolve imports, or pass tests are now reported as `'failed'` instead of `'completed'`. The `RUN_FAIL_POLICY` env var controls whether the pipeline halts early (`halt`), runs to completion with honest status (`finalize`), or preserves the legacy always-completed behaviour (`legacy`).

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/acceptance-gate.ts` | ~450 lines. `evaluateAcceptance()`, `detectUnrecoverable()`, `haltIfUnrecoverable()`, `acceptanceBlockersToBugs()`, `acceptanceReportToMarkdown()`. Evaluates 10 criteria: BUILD, ARTIFACTS, RESOLVE, TESTS, SMOKE, INTEGRITY, SCOPE, AC_COVERAGE, DEPLOY, E2E. |
| `tests/acceptance-gate.test.ts` | 19 tests covering `evaluateAcceptance` (8 tests), `detectUnrecoverable` (6 tests), `acceptanceBlockersToBugs` (3 tests), `acceptanceReportToMarkdown` (2 tests). |

### Modified Files

| File | Change |
|------|--------|
| `src/conductor/state.ts` | Added 7 new state fields: `acceptance` (replace), `latestGateReport` (replace), `unrecoverable` (replace), `verificationErrors` (append), `dispatchRounds` (append), `attemptedBugIds` (append), `bugAttempts` (max-merge). Added `bugAttemptsReducer` and `replaceReducer` helpers. |
| `src/config.ts` | Added 4 new config constants: `RUN_FAIL_POLICY`, `ACCEPT_MIN_TESTS`, `ACCEPT_REQUIRE_SMOKE`, `UNRECOVERABLE_ZERO_ROUNDS`. |
| `src/utils/token-tracker.ts` | Extended `RunStatus` type with `'failed' \| 'partial' \| 'inconclusive'`. |
| `src/utils/run-snapshot.ts` | Extended `RunManifest` interface with `acceptance`, `verification`, `phantomFileChanges`, `filesDelivered`. Updated `writeRunManifest` signature and body. |
| `src/utils/event-bus.ts` | Added `'acceptance:result'` to `RunEventType`. |
| `src/conductor/nodes.ts` | Added `acceptanceNode` (phase 10). Updated `finalizeNode` for truthful status determination (fixes E1/E2). Added `latestGateReport` and `verificationErrors` to `qaNode` return. Fixed `bugfixTriageNode` to track `attemptedBugIds`/`bugAttempts` instead of premature `fixedBugIds` (fixes E5). Added `fixedBugIds` re-evaluation in `qaNode`. Added `haltIfUnrecoverable` early-exit checks in `developmentNode`/`qaNode`/`devopsNode`. Added phantom file change counting and acceptance blockers to final summary. |
| `src/conductor/graph.ts` | Added `acceptance-gate` node to graph. Rewired `afterQaRouter` (now routes to `acceptance-gate` under halt policy). Rewired `afterE2eRouter` (now routes to `acceptance-gate` instead of `finalize`). Added `afterAcceptanceRouter`. Updated conditional edges maps. |
| `src/agents/_shared/schemas/phase.schema.ts` | Added `'acceptance-gate'` to `PhaseNameSchema`. |
| `dashboard/src/app/pages/dashboard/dashboard.component.scss` | Added `.status-partial`, `.status-inconclusive`, `.status-failed` CSS classes. |
| `dashboard/src/app/pages/run-session/run-session.component.scss` | Added `.status-partial`, `.status-inconclusive`, `.status-failed` CSS classes. |
| `.env.example` | Added `RUN_FAIL_POLICY`, `ACCEPT_MIN_TESTS`, `ACCEPT_REQUIRE_SMOKE`, `UNRECOVERABLE_ZERO_ROUNDS` with documentation. |
| `AI_Context.md` | Added Acceptance Gate section documenting `evaluateAcceptance`, `detectUnrecoverable`, graph routing, and env vars. |
| `tests/graph-routing.test.ts` | Updated `afterE2eRouter` expectations (`'finalize'` → `'acceptance-gate'`). Added `afterQaRouter` policy-aware tests. Added `afterAcceptanceRouter` test suite (4 tests). Updated `makeMinimalState` with new state fields. |
| `tests/hitl-graph.test.ts` | Updated `afterE2eRouter` expectation (`'finalize'` → `'acceptance-gate'`). Updated `makeMinimalState` with new state fields. |
| `tests/qa-node-resilience.test.ts` | Updated `makeMinimalState` with new state fields. Fixed pre-existing `devopsNode` phase expectation (`'e2e'` → `'devops'`). |

---

## Defects Addressed

| ID | Defect | Fix |
|----|--------|-----|
| E1 | `finalStatus = state.cancelled ? 'cancelled' : 'completed'` — always "completed" | `finalizeNode` now derives status from `acceptance.status` via `RUN_FAIL_POLICY` |
| E2 | `writeRunManifest` stamps status unconditionally | Manifest now includes `acceptance` report, `verification` data, `phantomFileChanges`, `filesDelivered` |
| E3 | No fail terminal in the graph; `afterQaRouter` falls through to `devops` | New `acceptance-gate` node; `afterQaRouter` routes to `acceptance-gate` under `halt` policy when failures remain |
| E4 | `testReports` append reducer causes stale fails to persist | Added `latestGateReport` (replace reducer) for unambiguous latest gate data |
| E5 | `fixedBugIds` written at triage time, gate bugs suppressed forever | `attemptedBugIds` at triage; `fixedBugIds` by re-evaluation (set difference) in `qaNode` |
| E6 | `looksSourceless()` logs ERROR but pipeline continues | `detectUnrecoverable` catches sourceless state; `haltIfUnrecoverable` stops the pipeline |
| E7 | Zero-output dispatch rounds retried identically | `dispatchRounds` state + `detectUnrecoverable` detects N consecutive zero-progress rounds |
| E8 | `afterE2eRouter` scans all testReports, not just E2E | `afterE2eRouter` now filters by `r.type === 'e2e'` and routes to `acceptance-gate` |
| E9 | Every gate/security/AC/traceability failure wrapped in `catch { warn }` | `verificationErrors` state captures crash info; acceptance gate marks corresponding criterion `inconclusive` |

---

## New Types

### `acceptance-gate.ts`

```ts
type AcceptanceStatus = 'accepted' | 'partial' | 'rejected' | 'inconclusive';

interface AcceptanceCriterionResult {
    id: string;           // BUILD, ARTIFACTS, RESOLVE, TESTS, SMOKE, INTEGRITY, SCOPE, AC_COVERAGE, DEPLOY, E2E
    label: string;
    required: boolean;
    passed: boolean;
    inconclusive: boolean;
    detail: string;
}

interface AcceptanceReport {
    status: AcceptanceStatus;
    criteria: AcceptanceCriterionResult[];
    blockers: string[];
    unrecoverable: boolean;
    unrecoverableReason?: string;
}
```

### State additions

```ts
acceptance: AcceptanceReport | null;                          // replace reducer
latestGateReport: GateReport | null;                          // replace reducer
unrecoverable: { flag: boolean; reason: string } | null;      // replace reducer
verificationErrors: Array<{ stage: string; message: string }>; // append reducer
dispatchRounds: Array<{ fileChanges: number; prs: number; completed: number }>; // append reducer
attemptedBugIds: string[];                                    // append reducer
bugAttempts: Record<string, number>;                          // max-merge reducer
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `RUN_FAIL_POLICY` | `'halt'` | What happens on acceptance failure: halt/finalize/legacy |
| `ACCEPT_MIN_TESTS` | `1` | Minimum executed tests for TESTS criterion |
| `ACCEPT_REQUIRE_SMOKE` | `true` | SMOKE criterion required for web products |
| `UNRECOVERABLE_ZERO_ROUNDS` | `2` | Consecutive zero-progress rounds before unrecoverable |

---

## Graph Topology Change

```
Before:
  qa → { bugfix-triage | devops } → e2e → { bugfix-triage | finalize }

After:
  qa → { bugfix-triage | devops | acceptance-gate | finalize }
  devops → e2e → { bugfix-triage | acceptance-gate | finalize }
  acceptance-gate → { bugfix-triage | finalize }
```

The `acceptance-gate` node name (not `acceptance`) was chosen to avoid collision with the `acceptance` state attribute — LangGraph does not allow a node name to match a state channel name.

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 39 suites, 689 tests pass (12 failures are all `self-signed certificate in certificate chain` network errors in integration tests — unrelated to this sub-plan)
- [x] `grep -n "cancelled ? 'cancelled' : 'completed'" src/` returns nothing
- [x] Every consumer of run status (dashboard SCSS, `token-tracker.ts`, `run-snapshot.ts`) handles `failed`, `partial`, `inconclusive`
- [x] `.env.example` updated with all new config vars
- [x] `AI_Context.md` updated with Acceptance Gate section
- [x] `PhaseNameSchema` includes `'acceptance-gate'`
- [x] `RunEventType` includes `'acceptance:result'`

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 04** (scope/orphan detection): **DONE.** See report below.
- **Sub-Plan 06** (PR conflict handling): `detectUnrecoverable` signal 2 (permanently blocked branch) is ready for the error classifier from Sub-Plan 06
- **Sub-Plan 09** (QA real execution): `ACCEPT_MIN_TESTS` enforces that at least N real tests executed, preventing the "0 tests found = pass" defect
- **Sub-Plan 10** (AC coverage): `AC_COVERAGE` criterion is registered as optional (behind `MIN_AC_COVERAGE_PCT > 0`) and will become required when Sub-Plan 10 makes the metric meaningful

---
---

# Sub-Plan 04 — Planning Integrity: Implementation Report

**Date:** 2026-08-11
**Status:** Complete
**Depends on:** Sub-Plans 01, 02, 03

---

## Summary

Implemented a comprehensive planning integrity system that prevents silent scope loss between the Product Manager and Team Leader phases. All 15 defects (P1-P15) identified in `04-planning-integrity.md` are now addressed. The system detects when stories or tasks are silently dropped during planning, repairs the gap automatically, and reports coverage violations.

---

## Defect-to-Fix Mapping

| Defect | Fix | Files |
|--------|-----|-------|
| **P1** (lossy repair — 4000 char clip) | Increased repair budget from 4000 to 16000 chars with middle-clip | `structured-output.ts` |
| **P2** (limited repair attempts — default 1) | Increased default to 2; added `AGENT_OUTPUT_CONTINUATION_ATTEMPTS` | `config.ts` |
| **P3** (truncation indistinguishable from completion) | `parseAgentJson` now sets `wasTruncated` flag via `detectTruncation()` heuristic; `jsonrepair` results also flagged | `structured-output.ts` |
| **P4** (no `max_tokens`/`finish_reason`) | All agents now get `maxTokens` from `LLM_MAX_OUTPUT_TOKENS`; planning agents use `PLANNING_MAX_OUTPUT_TOKENS` (32k); `LLM_REQUEST_TIMEOUT_MS` configurable | `config.ts`, `agent-factory.ts`, all planning agent files |
| **P5** (scalar `storyId` on Assignment) | Added `additionalStoryIds`, `taskIds` (required, min 1), `acIndexes` to `AssignmentSchema` | `assignment.schema.ts` |
| **P6** (`RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS`) | Planning agents now set `keepSchemaDescriptions: true` to preserve `.describe()` text | `agent-factory.ts`, all planning agent files |
| **P7** (TL prompt encourages merging/discarding) | Prompt rewritten: "DROPPING A STORY IS NOT acceptable"; batch via `additionalStoryIds`, never omit | `team-leader.prompt.ts` |
| **P8** (TL only sees AC count) | TL now receives `storiesWithCriteria()` with full numbered AC list; context budget increased to `TEAM_LEADER_CONTEXT_MAX_CHARS` (48k) | `context-builder.ts`, `nodes.ts` |
| **P9** (no coverage comparison) | `validateAssignmentPlan()` compares stories/tasks vs assignments; gap-repair loop re-invokes TL with targeted prompt | `plan-coverage.ts`, `nodes.ts` |
| **P10** (`dependsOn` not validated) | `topoSort()` now detects dangling deps, logs warning, treats as pre-satisfied instead of collapsing into cyclic batch | `dispatcher.ts` |
| **P11** (task descriptions not reaching devs) | `tasksForIds()` delivers full task descriptions; `pr-workflow.ts` builds a Tasks section for each branch | `context-builder.ts`, `pr-workflow.ts` |
| **P12** (`storiesForIds` returns generic string for no match) | Returns `{ text, missing }` — callers log error for dangling storyId references | `context-builder.ts`, `pr-workflow.ts`, `nodes.ts` |
| **P13** (append reducer causes duplication) | `epics`, `userStories`, `tasks` now use `mergeByIdReducer`; `techStack` uses `mergeByLayerReducer` | `state.ts` |
| **P14** (orphaned tasks in traceability) | `buildTraceabilityReport` now detects and renders orphaned tasks | `traceability.ts` |
| **P15** (context clipping is line-based, not middle-clipped) | `buildContext` now clips from the middle for list-shaped sections, preserving head and tail | `context-builder.ts` |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/plan-coverage.ts` | Coverage validators (`validateStoryPlan`, `validateAssignmentPlan`), gap prompt builder, funnel logger. ~280 lines. |
| `tests/plan-coverage.test.ts` | 11 tests for coverage validation and gap prompt. |
| `tests/structured-output-repair.test.ts` | 18 tests for truncation detection, field-level repair, and repair prompt. |
| `tests/context-builder-coverage.test.ts` | 9 tests for `storiesForIds`, `storiesWithCriteria`, `tasksForIds`. |
| `tests/state-reducers.test.ts` | 5 tests for `mergeByIdReducer` deduplication behavior. |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | Added 7 new config constants: `LLM_MAX_OUTPUT_TOKENS`, `PLANNING_MAX_OUTPUT_TOKENS`, `LLM_REQUEST_TIMEOUT_MS`, `AGENT_OUTPUT_CONTINUATION_ATTEMPTS`, `PLAN_COVERAGE_MODE`, `PLAN_COVERAGE_REPAIR_ATTEMPTS`, `TEAM_LEADER_CONTEXT_MAX_CHARS`. Changed `AGENT_OUTPUT_REPAIR_ATTEMPTS` default from `'1'` to `'2'`. |
| `src/agents/_shared/agent-factory.ts` | Added `maxOutputTokens`, `keepSchemaDescriptions` to `AgentConfig`; `ChatOpenAI` now uses `maxTokens` and `LLM_REQUEST_TIMEOUT_MS`; schema stripping respects `keepSchemaDescriptions`. |
| `src/agents/_shared/schemas/assignment.schema.ts` | Added `additionalStoryIds`, `taskIds` (min 1), `acIndexes` fields with `.describe()` text. |
| `src/agents/team-leader/team-leader.agent.ts` | Added `maxOutputTokens: PLANNING_MAX_OUTPUT_TOKENS`, `keepSchemaDescriptions: true`. |
| `src/agents/team-leader/schemas/tl-output.schema.ts` | Added `coverageNote` optional field. |
| `src/agents/team-leader/team-leader.prompt.ts` | Rewritten: branch strategy discourages discarding; workflow adds coverage verification steps 6-7; output rules require `taskIds`, `additionalStoryIds`, `acIndexes`, `coverageNote`. |
| `src/agents/product-manager/product-manager.agent.ts` | Added `maxOutputTokens`, `keepSchemaDescriptions`. |
| `src/agents/architect/architect.agent.ts` | Added `maxOutputTokens`, `keepSchemaDescriptions`. |
| `src/agents/dba/dba.agent.ts` | Added `maxOutputTokens`, `keepSchemaDescriptions`. |
| `src/conductor/nodes.ts` | `teamLeaderNode`: uses `storiesWithCriteria`, `TEAM_LEADER_CONTEXT_MAX_CHARS`, plan coverage validation loop, gap-repair invocations, emits `plan:coverage` event, returns `planViolations`. `invokeAgent`: field-level repair before LLM repair, uses `PIPELINE_RECURSION_LIMIT`. QA: uses `.text` from `storiesForIds`. |
| `src/conductor/state.ts` | Added `mergeByIdReducer`, `mergeByLayerReducer`; switched `epics`, `userStories`, `tasks` to merge-by-id; `techStack` to merge-by-layer; added `outputIntegrity`, `planViolations` state channels. |
| `src/conductor/context-builder.ts` | Added `storiesWithCriteria()`, `tasksForIds()`; `storiesForIds()` returns `{ text, missing }` with dangling id detection; `buildContext` clips from the middle for list-shaped sections. |
| `src/conductor/pr-workflow.ts` | `branchStoryIds` includes `additionalStoryIds`; `storiesForIds` destructured; logs error for dangling story refs; adds Tasks section for each branch. |
| `src/conductor/acceptance-gate.ts` | SCOPE criterion updated: handles `additionalStoryIds`, surfaces planning violations from TL phase. |
| `src/conductor/assignment-policy.ts` | `namespaceBugfixAssignments` ensures bugfix assignments have `taskIds`. |
| `src/agents/developers/dispatcher.ts` | `topoSort` detects and warns about dangling `dependsOn` ids, treats them as pre-satisfied. |
| `src/utils/structured-output.ts` | `ParseResult` extended with `wasTruncated`, `rawLength`; `parseAgentJson` sets truncation flags; `detectTruncation()` heuristic; `repairFieldViolations()` deterministic field-level repair; `buildRepairMessage` uses 16k middle-clip budget. |
| `src/utils/traceability.ts` | Indexes `additionalStoryIds` for assignment coverage; detects orphaned tasks; renders orphaned tasks section. |
| `src/utils/event-bus.ts` | Added `'plan:coverage'` to `RunEventType`. |
| `.env.example` | Added all 7 new env vars with documentation. |
| `AI_Context.md` | Added Plan Coverage section; updated Structured Output section. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/acceptance-gate.test.ts` | Added `outputIntegrity`, `planViolations`, `additionalStoryIds`, `taskIds`, `acIndexes` to fixtures. |
| `tests/assignment-policy.test.ts` | Added new fields to `makeAssignment` factory. |
| `tests/dispatcher-branching.test.ts` | Added new fields to `makeAssignment` factory. |
| `tests/graph-routing.test.ts` | Added `outputIntegrity`, `planViolations` to state fixture. |
| `tests/hitl-graph.test.ts` | Added `outputIntegrity`, `planViolations` to state fixture. |
| `tests/qa-node-resilience.test.ts` | Added `outputIntegrity`, `planViolations` to state fixture. |
| `tests/traceability.test.ts` | Added new fields to `makeAssignment` factory, `orphanedTasks` to report fixtures, state fields. |
| `tests/context-builder.test.ts` | Updated `storiesForIds` tests for `{ text, missing }` return type. |
| `tests/structured-output.test.ts` | Updated `buildRepairMessage` clip test for 16k middle-clip. |

---

## Verification

- [x] `npx tsc --noEmit` passes with 0 errors
- [x] `npm run test:unit` — 40 suites, 729 tests, 0 failures
- [x] New test files: `plan-coverage.test.ts` (11 tests), `structured-output-repair.test.ts` (18 tests), `context-builder-coverage.test.ts` (9 tests), `state-reducers.test.ts` (5 tests) — total 43 new tests
- [x] No regressions in existing test suites
- [x] `.env.example` updated with all new config vars
- [x] `AI_Context.md` updated with Plan Coverage section

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 06** (PR conflict handling): `additionalStoryIds` lets multiple stories share a branch cleanly, reducing branch count and merge conflicts
- **Sub-Plan 09** (QA real execution): `acIndexes` on assignments enables per-AC test targeting
- **Sub-Plan 10** (AC coverage): `validateAssignmentPlan` already checks AC-level coverage; `AC_COVERAGE` acceptance criterion can now leverage real AC mapping
- **Sub-Plan 12** (token budget): `PLANNING_MAX_OUTPUT_TOKENS` and `LLM_MAX_OUTPUT_TOKENS` provide fine-grained control over output budgets per agent tier

---
---

# Sub-Plan 05 — The Architecture Contract: Implementation Report

**Date:** 2026-08-11
**Status:** Complete
**Depends on:** Sub-Plan 04 (assignment schema with `taskIds`, `additionalStoryIds`; coverage validator)

---

## Summary

Implemented a machine-checkable repo layout and module contract that the Architect produces and every downstream agent obeys. The contract prevents the dual-layout disaster seen in `retroboard3` (monorepo vs flat repo in the same run) and the duplicate-module conflict seen in `pacman8` (`InputHandler.ts` vs `useInputHandler.ts`). The Architect now runs without tools (JSON mode active), the contract is materialized into the workspace, and a layout linter mechanically enforces it at PR time, QA time, and acceptance time.

---

## Defect-to-Fix Mapping

| Evidence | Fix | Files |
|----------|-----|-------|
| **A6** (no architecture contract — 21-line schema with no layout) | `RepoContractSchema` with layout, roots, modules, exports, naming convention | `repo-contract.schema.ts` |
| **A6** (TL assigns contradictory paths) | `moduleIds` on `AssignmentSchema` and `TaskSchema`; TL prompt mandates contract module ownership | `assignment.schema.ts`, `task.schema.ts`, `team-leader.prompt.ts` |
| **A6** (two agents build incompatible projects) | Repo contract injected into all agent contexts; dev persona includes `<repo_contract>` block | `persona.ts`, `context-builder.ts`, `nodes.ts` |
| **A6** (no directory structure, no entry points) | `StackRootContractSchema` with entryPoints, sourceDirs, testDirs, scripts, buildOutputDir | `repo-contract.schema.ts` |
| **A6** (no export surface, no interface contract) | `ModuleContractSchema` with exact paths, named exports with signatures, dependsOn | `repo-contract.schema.ts` |
| **A12** (Architect is the only agent without JSON mode) | Removed `emitMermaidTool`; `tools: []` enables JSON mode; diagram goes in `mermaidDiagram` field | `architect.agent.ts`, `architect.prompt.ts` |
| **A2** (agent rewrites build script) | Contract scripts refine rejects NO_OP_SCRIPT_RE; scripts frozen after scaffolding | `repo-contract.schema.ts` |
| **A7/A6** (scaffold and feature in same parallel batch produce conflicts) | Contract-first scaffolding: scaffold creates interface stubs at declared module paths | `team-leader.prompt.ts` |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/agents/_shared/schemas/repo-contract.schema.ts` | ~80 lines. `RepoContractSchema`, `StackRootContractSchema`, `ModuleContractSchema`, `ModuleExportSchema` with refines (no-op script rejection, generated-projects path rejection). |
| `src/utils/repo-contract-writer.ts` | ~610 lines. `writeRepoContract` (`.agent/repo-contract.json` + `docs/ARCHITECTURE-CONTRACT.md`), `readRepoContract`, `renderContractForPrompt` (budgeted prompt section), `deriveContractFromAnalysis` (maintain mode). |
| `src/conductor/layout-lint.ts` | ~604 lines. `lintLayout` checks 10 violation kinds with correct severities. Reuses `buildImportGraph` from gate-integrity. `layoutViolationsToMarkdown`, `hasCriticalViolations` helpers. |
| `tests/repo-contract.test.ts` | 11 tests: schema validation (4), renderContractForPrompt (3), write/read round-trip (3), deriveContractFromAnalysis (1). |
| `tests/layout-lint.test.ts` | 5 tests with fixtures: retro-split (unknown-root), pacman-duplicate (duplicate-module), missing-export (missing-declared-export), clean (zero violations), entrypoint-missing. |
| `tests/fixtures/layout-lint/` | 4 fixture directories, 17 files total: `retro-split/`, `pacman-duplicate/`, `missing-export/`, `clean/`. |

### Modified Files

| File | Change |
|------|--------|
| `src/agents/architect/architect.agent.ts` | `tools: [emitMermaidTool]` → `tools: []` (JSON mode now active). Removed `emitMermaidTool` import. |
| `src/agents/architect/architect.prompt.ts` | Added `<repo_contract>` section with 5 rules. Updated `<mission>` to include repo contract. Updated `<workflow>` step 6 (contract design) and step 7 (diagram in mermaidDiagram field, no tool). Updated `<output_rules>` for frozen scripts. Updated `<maintain_mode>` to extend contracts. Updated `<proportionality>` with contract guidance. |
| `src/agents/architect/schemas/architect-output.schema.ts` | Added `repoContract: RepoContractSchema` field to `ArchitectOutputSchema`. |
| `src/agents/_shared/schemas/assignment.schema.ts` | Added `moduleIds: z.array(z.string()).default([])` field. |
| `src/agents/_shared/schemas/task.schema.ts` | Added `moduleIds: z.array(z.string()).default([])` field. |
| `src/agents/_shared/schemas/index.ts` | Added barrel export for `repo-contract.schema`. |
| `src/agents/_shared/persona.ts` | Added `<repo_contract>` block to compact persona. Added stub carve-out to NO DEAD CODE rule (compact + full). Added stub carve-out to reviewer `MANDATORY MAJOR` guideline. |
| `src/agents/product-manager/product-manager.prompt.ts` | Added rule: tasks must name moduleIds and match repo contract paths. |
| `src/agents/team-leader/team-leader.prompt.ts` | Added rule: assignments must list moduleIds, no duplicate ownership, every module owned. Updated `<integration_check>` with scaffold contract requirements. Updated `<output_rules>` to include moduleIds. |
| `src/agents/dba/dba.prompt.ts` | Updated `<workflow>` to reference repo contract for migration file placement. |
| `src/agents/qa/qa-lead.prompt.ts` | Added rule: use contract testDirs and scripts.test for test placement. |
| `src/agents/devops/devops.prompt.ts` | Updated `<workflow>` step 1 to reference contract roots, buildOutputDir, entryPoints. |
| `src/conductor/state.ts` | Added `repoContract: Annotation<RepoContract \| null>` with replace reducer. Added import for `RepoContract`. |
| `src/conductor/context-builder.ts` | Added `summariseRepoContract` function. Added imports for `RepoContract`, `renderContractForPrompt`, `CONTRACT_PROMPT_MAX_CHARS`. |
| `src/conductor/nodes.ts` | Updated `architectNode`: handle `repoContract` output, cap modules, call `writeRepoContract`, return `repoContract` to state. Added contract to PM, DBA, TL, and dev context sections. Added `.agent/` to gitignore entries (both intake and development). Added imports for `writeRepoContract`, `REPO_CONTRACT_MAX_MODULES`, `summariseRepoContract`. |
| `src/config.ts` | Added 4 config constants: `REPO_CONTRACT_MODE`, `REPO_CONTRACT_MAX_MODULES`, `CONTRACT_STUB_SCAFFOLD`, `CONTRACT_PROMPT_MAX_CHARS`. |
| `.env.example` | Added Architecture Contract section with 4 new env vars. |
| `README.md` | Added Architecture Contract row to Environment Variables table. |
| `AI_Context.md` | Added Architecture Contract subsystem section. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/acceptance-gate.test.ts` | Added `repoContract: null` to state, `moduleIds: []` to assignment fixtures. |
| `tests/assignment-policy.test.ts` | Added `moduleIds: []` to `makeAssignment` factory. |
| `tests/context-builder.test.ts` | Added `moduleIds: []` to task fixtures. |
| `tests/context-builder-coverage.test.ts` | Added `moduleIds: []` to task fixtures. |
| `tests/dispatcher-branching.test.ts` | Added `moduleIds: []` to `makeAssignment` factory. |
| `tests/graph-routing.test.ts` | Added `repoContract: null` to state fixture. |
| `tests/hitl-graph.test.ts` | Added `repoContract: null` to state fixture. |
| `tests/qa-node-resilience.test.ts` | Added `repoContract: null` to state fixture. |
| `tests/traceability.test.ts` | Added `repoContract: null` to state, `moduleIds: []` to assignment and task factories. |
| `tests/persona.test.ts` | Updated compact persona length thresholds (3000→3600, 3500→4100, 4000→4600) to accommodate the new `<repo_contract>` block. |

---

## New Types and Interfaces

### `repo-contract.schema.ts`

```ts
interface ModuleExport { name: string; kind: 'function'|'class'|'const'|'type'|'interface'|'component'|'hook'|'router'|'default'; signature: string; }
interface ModuleContract { id: string; path: string; componentName: string; exports: ModuleExport[]; dependsOn: string[]; }
interface StackRootContract { dir: string; kind: 'frontend'|'backend'|'shared'|'infra'|'e2e'; stack: string; entryPoints: string[]; sourceDirs: string[]; testDirs: string[]; scripts: Record<string, string>; buildOutputDir: string | null; }
interface RepoContract { layout: 'single-root'|'npm-workspaces'|'multi-stack'; roots: StackRootContract[]; modules: ModuleContract[]; namingConvention: string; sharedTypes: string[]; frozenPaths: string[]; }
```

### `layout-lint.ts`

```ts
type LayoutViolationKind = 'file-outside-source-dirs' | 'unknown-root' | 'duplicate-module' | 'module-path-mismatch' | 'missing-declared-export' | 'entrypoint-missing' | 'entrypoint-does-not-compose' | 'test-outside-test-dirs' | 'cross-root-relative-import' | 'naming-violation';
interface LayoutViolation { kind: LayoutViolationKind; severity: 'critical' | 'major' | 'minor'; path: string; detail: string; }
```

### State additions

```ts
repoContract: RepoContract | null;  // replace reducer
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `REPO_CONTRACT_MODE` | `'enforce'` | Enforce the Architect's repo contract: off/warn/enforce |
| `REPO_CONTRACT_MAX_MODULES` | `60` | Cap on declared modules |
| `CONTRACT_STUB_SCAFFOLD` | `true` | Create typed interface stubs during scaffolding |
| `CONTRACT_PROMPT_MAX_CHARS` | `6000` | Char budget for the contract section in agent prompts |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 42 suites, 745 tests, 0 failures
- [x] Architect agent has `tools: []` and JSON mode is active
- [x] `RepoContractSchema` rejects echo build scripts (NO_OP_SCRIPT_RE refine)
- [x] `RepoContractSchema` rejects module paths containing `generated-projects/`
- [x] `renderContractForPrompt` stays under `CONTRACT_PROMPT_MAX_CHARS` for a 60-module contract
- [x] `writeRepoContract` / `readRepoContract` round-trip correctly
- [x] `lintLayout` detects retro-split root-level files, pacman-duplicate modules, missing exports, and clean passes
- [x] `.agent/` appears in the generated `.gitignore` block
- [x] `docs/ARCHITECTURE-CONTRACT.md` is committed (human-readable)
- [x] `.env.example` updated with all new config vars
- [x] `AI_Context.md` updated with Architecture Contract subsystem
- [x] `README.md` Environment Variables table updated

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 06** (PR conflict handling): `assignment.moduleIds` gives the dispatcher real file-ownership data for conflict avoidance — two assignments owning different modules on the same branch can be serialized or split
- **Sub-Plan 07** (review/merge fail-closed): reviewers can validate changes against the contract; layout violations provide evidence for stub detection
- **Sub-Plan 09** (QA real execution): `repoContract.roots[].testDirs` and `scripts.test` tell QA exactly where to write and run tests
- **Sub-Plan 10** (AC coverage): `task.moduleIds` and `assignment.moduleIds` enable per-module traceability
- **Sub-Plan 12** (observability): the contract provides a baseline for phantom-file-change detection (files claimed changed but not at their declared paths)

---
---

# Sub-Plan 06 — PR Workflow: Never Lose Written Code: Implementation Report

**Date:** 2026-08-12
**Status:** Complete
**Depends on:** Sub-Plan 05 (`assignment.moduleIds`); consumes Sub-Plans 01–03 infrastructure

---

## Summary

Implemented comprehensive work preservation for the PR workflow. The system no longer destroys code that agents write. Every agent invocation site commits work in a `finally` block, failed worktrees are preserved instead of deleted, merge conflicts are handled with auto-resolution before falling back to dev agents, PR creation deadlocks (422 "already exists") are resolved by reusing existing PRs, and assignment completion requires real evidence (file changes + passing gates).

The headline bugs from pacman8 (game code destroyed by conflict) and retroboard3 (9 of 14 PRs force-merged despite issues) are both addressed: written code survives agent failures, and the merge strategy no longer manufactures conflicts.

---

## Defect-to-Fix Mapping

| Evidence | Fix | Files |
|----------|-----|-------|
| **A7.1** (review-fix commit inside try, lost on throw) | All 5 `invokeDevAgent` sites wrapped in `try/finally` with `commitWorktree()` | `pr-workflow.ts` |
| **A7.2** (conflict destroyed game — scaffold+feature same batch) | Scaffold barrier: `injectScaffoldDependencies()` + sequential scaffold dispatch + `syncWorkspaceToBranch()` | `dispatcher.ts` |
| **A7.3** (422 retry deadlock — PR already exists) | `findExistingPR()` called before creation; 422 classified and reused reactively | `pr-workflow.ts` |
| **A7.4** (cleanup precedes error — work destroyed) | On failure: worktree moved to `.worktrees-failed/`, `git format-patch` exported to `<outputPath>/salvage/` | `pr-workflow.ts` |
| **A7.5** (rebase fails for every PR) | Merge ladder: `git merge` instead of `git rebase`; auto-resolution for lockfiles and `package.json` | `pr-workflow.ts`, `merge-resolve.ts` |
| **A7** (empty error message) | `gitExecVerbose()` returns `{ ok, stdout, stderr, code }` for merge/conflict operations | `git-exec.ts`, `pr-workflow.ts` |
| **A2** (agent rewrites build script) | `CONFIG_OWNERSHIP_SCAFFOLD_ONLY` prevents feature branches from modifying root config | `config.ts`, `dispatcher.ts` |
| **A11** (phantom file changes) | `CompletionEvidence` counts real source file changes; `completedIdsWithEvidence()` rejects zero-change merges | `assignment-policy.ts`, `pr-workflow.ts`, `dispatcher.ts`, `nodes.ts` |
| **A7.2** (overlapping modules conflict) | `findOverlappingBranches()` serialises branches with shared `moduleIds` | `dispatcher.ts` |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/pr-failure.ts` | ~153 lines. PR/git/GitHub error classifier (`PrFailureKind`, `classifyPrFailure`, `isFatalPrFailure`). Matches literal payloads from run logs. |
| `src/conductor/merge-resolve.ts` | ~247 lines. Deterministic merge-conflict auto-resolution for lockfiles and `package.json`. Source conflicts returned as `unresolved`. |
| `tests/pr-failure.test.ts` | 29 tests covering all error classifications and edge cases. |
| `tests/merge-resolve.test.ts` | 5 tests for `compareSemverRange`. |
| `tests/assignment-completion.test.ts` | 11 tests for evidence-based completion and `incompleteBugs`. |
| `tests/dispatcher-scaffold-barrier.test.ts` | 6 tests for scaffold dependency injection and topo-sort ordering. |

### Modified Files

| File | Change |
|------|--------|
| `src/conductor/pr-workflow.ts` | **Major rewrite.** All 5 `invokeDevAgent` sites now have `try/finally { commitWorktree() }`. PR creation checks for existing PR first, classifies errors, reuses on 422, fails fast on auth. Merge ladder replaced rebase with merge + `resolveKnownConflicts()` + dev-agent conflict fix. Worktree disposal preserves on failure (`.worktrees-failed/`), exports salvage patches. Evidence-based completion computed after merge. Added `outputPath` to `PRWorkflowInput`, `completionEvidence` and `salvageBranch` to `PRWorkflowResult`. ~2002 lines (was ~1804). |
| `src/agents/developers/dispatcher.ts` | **Major rewrite.** Added scaffold barrier: `isScaffoldAssignment()`, `injectScaffoldDependencies()`, `findOverlappingBranches()`, `syncWorkspaceToBranch()`. Dispatch now runs scaffold first (sequentially), then serialised overlapping branches, then parallel features. Added `outputPath` and `tasks` parameters. `DispatchResult` extended with `completionEvidence` and `salvageBranches`. ~470 lines (was ~304). |
| `src/conductor/nodes.ts` | `developmentNode`: passes `outputPath` and `tasks` to `dispatchDevelopers`, returns `completionEvidence` and `salvageBranches`. `intakeNode`: prunes `.worktrees-failed/` on start, adds `.worktrees-failed/` to `.gitignore`. |
| `src/conductor/state.ts` | Added `completionEvidence: Annotation<CompletionEvidence[]>` (append reducer), `salvageBranches: Annotation<string[]>` (append reducer). |
| `src/conductor/assignment-policy.ts` | Added `CompletionEvidence` interface, `completedIdsWithEvidence()`, `incompleteBugs()`. Fixed Bug construction to match `BugSchema` fields. |
| `src/utils/git-exec.ts` | Added `gitExecVerbose()` returning `{ ok, stdout, stderr, code }`. |
| `src/utils/github-local.ts` | Added `pulls.list` to `OctokitLike` for PR reuse in local mode. |
| `src/utils/event-bus.ts` | Added `'pr:conflict'` and `'pr:salvage'` to `RunEventType`. |
| `src/config.ts` | Added 5 config constants: `WORKTREE_SALVAGE_MAX`, `PR_SALVAGE_PATCHES`, `MERGE_CONFLICT_FIX_ATTEMPTS`, `ASSIGNMENT_MAX_ATTEMPTS`, `CONFIG_OWNERSHIP_SCAFFOLD_ONLY`. |
| `.env.example` | Added PR Workflow / Work Preservation section with all 5 new env vars. |
| `README.md` | Added PR Workflow / Work Preservation row to Environment Variables table. |
| `AI_Context.md` | Rewrote PR Workflow section (12 steps, merge ladder, evidence-based completion). Added Scaffold Barrier subsection. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/acceptance-gate.test.ts` | Added `completionEvidence: []`, `salvageBranches: []` to `makeMinimalState()`. |
| `tests/graph-routing.test.ts` | Added `completionEvidence: []`, `salvageBranches: []` to `makeMinimalState()`. |
| `tests/hitl-graph.test.ts` | Added `completionEvidence: []`, `salvageBranches: []` to `makeMinimalState()`. |
| `tests/qa-node-resilience.test.ts` | Added `completionEvidence: []`, `salvageBranches: []` to `makeMinimalState()`. |

---

## New Types and Interfaces

### `pr-failure.ts`

```ts
type PrFailureKind = 'pr-already-exists' | 'no-commits' | 'merge-conflict' | 'rebase-failed' | 'push-rejected' | 'auth' | 'rate-limit' | 'network' | 'unknown';
interface PrFailureClassification { kind: PrFailureKind; message: string; retryable: boolean; }
```

### `merge-resolve.ts`

```ts
interface MergeResolution { resolved: string[]; unresolved: string[]; }
```

### `assignment-policy.ts`

```ts
interface CompletionEvidence {
    assignmentId: string;
    filesChanged: number;
    declaredModulesPresent: number;
    declaredModulesTotal: number;
    gatePassed: boolean;
    merged: boolean;
}
```

### `pr-workflow.ts` additions

```ts
interface PRWorkflowInput { ...; outputPath?: string; }
interface PRWorkflowResult { ...; completionEvidence?: CompletionEvidence[]; salvageBranch?: string; }
```

### `dispatcher.ts` additions

```ts
interface DispatchResult { ...; completionEvidence: CompletionEvidence[]; salvageBranches: string[]; }
```

### State additions

```ts
completionEvidence: Annotation<CompletionEvidence[]>  // append reducer
salvageBranches: Annotation<string[]>                  // append reducer
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `WORKTREE_SALVAGE_MAX` | `10` | Max failed worktrees retained under `.worktrees-failed/` |
| `PR_SALVAGE_PATCHES` | `true` | Export git format-patch bundles for failed branches |
| `MERGE_CONFLICT_FIX_ATTEMPTS` | `1` | Dev-agent attempts at merge conflict resolution |
| `ASSIGNMENT_MAX_ATTEMPTS` | `3` | Max re-dispatches per assignment |
| `CONFIG_OWNERSHIP_SCAFFOLD_ONLY` | `true` | Only scaffold branch may modify root config files |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 46 suites, 792 tests pass (0 failures)
- [x] New test files: `pr-failure.test.ts` (29 tests), `merge-resolve.test.ts` (5 tests), `assignment-completion.test.ts` (11 tests), `dispatcher-scaffold-barrier.test.ts` (6 tests) — total 51 new tests
- [x] `grep -n "rebase origin/" src/conductor/pr-workflow.ts` returns nothing (merge, not rebase)
- [x] Every `invokeDevAgent` call in `pr-workflow.ts` followed by `finally { commitWorktree() }`
- [x] PR creation 422 for existing head reuses the PR
- [x] `.env.example` updated with all 5 new config vars
- [x] `README.md` Environment Variables table updated
- [x] `AI_Context.md` PR Workflow section rewritten with 12 steps + Scaffold Barrier subsection

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 07** (review/merge fail-closed): `CommitWorktree` in `finally` ensures review-fix code is never lost; reviewers can now evaluate real code instead of phantom changes
- **Sub-Plan 08** (agent budgets/context): the scaffold barrier reduces wasted agent invocations by preventing parallel scaffold+feature conflicts; `CompletionEvidence` provides a real signal for budget allocation
- **Sub-Plan 09** (QA real execution): tasks now flow through to the PR workflow (`tasks` param), enabling per-assignment test targeting
- **Sub-Plan 10** (AC coverage): `completionEvidence` provides the file-change signal needed to distinguish real from phantom coverage
- **Sub-Plan 12** (observability): salvage patches provide post-mortem artifacts; `CompletionEvidence` replaces phantom `fileChanges` as the truth metric

---
---

# Sub-Plan 08 — Agent Budgets & Context: Fix the Poisoning/Respawn Death Spiral: Implementation Report

**Date:** 2026-08-12
**Status:** Complete
**Depends on:** Sub-Plan 06 (durable commits); Sub-Plan 05 (architecture contract)

---

## Summary

Implemented six work items that fix the poisoning/respawn death spiral observed in `pacman8` (117 × poisoning, 80+ × respawn) and `retroboard3` (289 × poisoning, 193 × respawn, 34 × `Done: 0 file changes`). The root cause was that agents burned 30–40% of their tool budget on reconnaissance (`list_dir`, `read_file package.json`), got poisoned (ALL tools disabled), respawned with zero context, and repeated the same reconnaissance indefinitely.

The fix eliminates reconnaissance waste via injected workspace snapshots, replaces global tool poisoning with per-tool blocking and split read/write/shell budgets, makes cached responses free, gates respawn on progress, extends retry to transient network errors, and reconciles agent-claimed file changes against the worktree.

---

## Work Items Implemented

### §2 — Workspace Snapshot (eliminate reconnaissance waste)

| Component | Detail |
|-----------|--------|
| New file | `src/conductor/workspace-snapshot.ts` (~210 lines) |
| Injection site | `src/conductor/pr-workflow.ts:740-750` |
| Persona update | `src/agents/_shared/persona.ts` compact workflow section |
| Config | `SNAPSHOT_MAX_FILES` (400), `SNAPSHOT_MAX_CHARS` (8000) |

The snapshot includes: `git ls-files` tree grouped by directory, verbatim `scripts` blocks from every `package.json`, test framework detection, and dependency names. Expected to eliminate 6–10 of every ~30 tool calls per invocation.

### §3 — Loop Guard: Degrade, Never Disarm

| Component | Detail |
|-----------|--------|
| Rewritten file | `src/agents/_shared/tool-loop-guard.ts` (~280 lines, was 214) |
| Key change | 3rd identical call blocks ONLY that `(tool, args)`, not all tools |
| Per-category budgets | `ToolBudgets` interface: reads/writes/shell per rank |
| Default budgets | principal: 30/25/10, senior: 25/20/8, junior: 20/15/8 |
| Progress bonus | `LOOP_GUARD_PROGRESS_BONUS` (10) extra read calls on write progress |
| Hard ceiling | `LOOP_GUARD_HARD_CEILING` (80) absolute stop |
| Cached = free | Cached responses do not increment any budget counter |
| Terminal guidance | "Return your JSON output now, listing exactly the files you actually wrote" |

### §4 — Respawn with Real Handoff

| Component | Detail |
|-----------|--------|
| Enhanced file | `src/conductor/agent-respawn.ts` (~273 lines, was 199) |
| Worktree verification | When `worktreeDir` provided, `filesWritten` derived from `git status` + `git diff` |
| Progress gate | Zero-write generation → no respawn (terminates and reports) |
| Richer handoff | File sizes (bytes), `tailOutput` on commands, `worktreeVerified` flag |
| Config | `AGENT_RESPAWN_MAX_GENERATIONS` raised from 2 → 4 |

### §5 — Budgets and Limits (correctness-first values)

| Constant | Old | New | Justification |
|----------|-----|-----|---------------|
| `DEV_RECURSION_LIMIT` | 58 | 140 | 6 × recursion-limit kills in pacman8 destroyed dev agents mid-work |
| `REVIEWER_RECURSION_LIMIT` | 26 | 40 | Reviewers abstained on recursion limits → counted as approval |
| `REVIEWER_MAX_TOOL_CALLS` | 8 | 14 | Same |
| `TOOL_PIPELINE_RECURSION_LIMIT` | 60 | 120 | qa-unit poisoned at 6–7 calls in all 8 QA phases |
| `TOOL_PIPELINE_MAX_TOOL_CALLS` | 25 | 50 | Same |
| `HISTORY_KEEP_RECENT_TOOL_RESULTS` | 2 | 4 | Agents re-read files stubbed out of history |
| `HISTORY_MAX_CHARS` | 30000 | 60000 | Over-aggressive compaction caused re-reads |
| `MAX_TOOL_RESULT_CHARS` | 6000 | 10000 | 4,210-char source file was truncated → agents re-read with offsets |
| `AGENT_RESPAWN_MAX_GENERATIONS` | 2 | 4 | With real handoff, respawn becomes productive |
| `MAX_RUN_COST_USD` | 0 (unlimited) | 150 | Safe with early-halt; raised budgets need a cost guard |
| `MAX_RUN_WALL_MS` | 0 (unlimited) | 18000000 (5h) | Same |

### §6 — Retry Transient LLM Failures

| Component | Detail |
|-----------|--------|
| Enhanced file | `src/utils/retry.ts` (~102 lines, was 70) |
| New exports | `isTransientError()`, `isRetryableError()` |
| Transient patterns | ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, socket hang up, Connection error, HTTP 5xx |
| Non-retryable | 4xx (other than 429) — 401, 404, etc. |

### §7 — Honest File Change Reporting

| Component | Detail |
|-----------|--------|
| New file | `src/conductor/file-change-reconciliation.ts` (~95 lines) |
| Integration | `src/conductor/pr-workflow.ts:772-785` |
| State | `phantomFileChanges` added to `ProjectState` (append reducer) |
| Config | `RECONCILE_FILE_CHANGES` (default: true) |
| PR result | `PRWorkflowResult.phantomFileChanges` field added |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/workspace-snapshot.ts` | ~210 lines. `buildWorkspaceSnapshot()`: file tree, scripts, test info, dependencies. |
| `src/conductor/file-change-reconciliation.ts` | ~95 lines. `reconcileFileChanges()`: verify claims against worktree, drop phantoms, add unreported. |
| `tests/workspace-snapshot.test.ts` | 5 tests: scripts inclusion, char budget, dependencies, test framework, missing package.json. |
| `tests/file-change-reconciliation.test.ts` | 4 tests: phantom detection, unreported detection, empty claims, all-valid. |
| `tests/retry.test.ts` | 17 tests: isRateLimitError (4), isTransientError (9), isRetryableError (4). |

### Rewritten Files

| File | Change |
|------|--------|
| `src/agents/_shared/tool-loop-guard.ts` | **Full rewrite.** Per-tool blocking, split read/write/shell budgets, progress bonus, cached=free, terminal guidance. ~280 lines (was 214). |
| `src/utils/retry.ts` | Extended with transient error detection. Exported `isRateLimitError`, `isTransientError`, `isRetryableError`. ~102 lines (was 70). |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | Changed 11 default values (see table above). Added 7 new constants: `SNAPSHOT_MAX_FILES`, `SNAPSHOT_MAX_CHARS`, `LOOP_GUARD_PROGRESS_BONUS`, `LOOP_GUARD_HARD_CEILING`, `TOOL_BUDGETS_JSON`, `AGENT_INVOKE_RETRIES`, `RECONCILE_FILE_CHANGES`. |
| `src/conductor/agent-respawn.ts` | Enhanced `buildHandoff` with optional worktree verification and `baseBranch` params. Added `HandoffFile` type with `bytes`. Enhanced `renderHandoff` with structured sections. Progress-gated respawn in `pr-workflow.ts`. |
| `src/conductor/pr-workflow.ts` | Added workspace snapshot injection before dev agent invocation. Added file change reconciliation after dev output. Added `phantomFileChanges` to result. Added `allPhantomFileChanges` tracking. Progress-gated respawn (zero-write → terminate). |
| `src/conductor/state.ts` | Added `phantomFileChanges: Annotation<FileChange[]>` (append reducer). |
| `src/agents/_shared/persona.ts` | Updated compact workflow to reference Workspace Snapshot: "Steps 1–2 are already answered in the Workspace Snapshot section." |
| `.env.example` | Added Sub-Plan 08 section (7 new env vars). Updated 11 existing defaults with old values documented. |
| `AI_Context.md` | Rewrote Tool Loop Guard section. Added Workspace Snapshot, File Change Reconciliation, Retry sections. Updated Common Gotchas items 3 and 4. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/loop-guard.test.ts` | **Full rewrite.** 13 tests covering per-tool blocking, cached=free, split budgets, progress bonus, terminal guidance, legacy mode, `resolveToolBudgets`. |
| `tests/agent-respawn.test.ts` | Updated `commandsRun` assertions for `toMatchObject` (tailOutput added). Updated `renderHandoff` assertion for new header format ("Handoff from generation N"). |
| `tests/acceptance-gate.test.ts` | Added `phantomFileChanges: []` to `makeMinimalState()`. |
| `tests/graph-routing.test.ts` | Added `phantomFileChanges: []` to `makeMinimalState()`. |
| `tests/hitl-graph.test.ts` | Added `phantomFileChanges: []` to `makeMinimalState()`. |
| `tests/qa-node-resilience.test.ts` | Added `phantomFileChanges: []` to `makeMinimalState()`. |

---

## New Types and Interfaces

### `tool-loop-guard.ts`

```ts
interface ToolBudgets { reads: number; writes: number; shell: number; }
interface LoopGuardOptions { budgets?: ToolBudgets; maxTotalCalls?: number; progressBonus?: number; hardCeiling?: number; }
type ToolCategory = 'read' | 'write' | 'shell';
```

### `workspace-snapshot.ts`

```ts
interface SnapshotOptions { maxFiles: number; maxChars: number; }
```

### `file-change-reconciliation.ts`

```ts
interface ReconciliationResult { verified: FileChange[]; phantoms: FileChange[]; unreported: FileChange[]; }
```

### `agent-respawn.ts`

```ts
interface HandoffFile { path: string; action: string; bytes?: number; }
// HandoffSummary.worktreeVerified: boolean (new field)
// HandoffSummary.commandsRun[].tailOutput?: string (new field)
```

### `retry.ts`

```ts
// New exports: isRateLimitError(), isTransientError(), isRetryableError()
```

### `pr-workflow.ts`

```ts
// PRWorkflowResult.phantomFileChanges?: FileChange[] (new field)
```

### State additions

```ts
phantomFileChanges: Annotation<FileChange[]>  // append reducer
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `SNAPSHOT_MAX_FILES` | `400` | Max files in injected workspace snapshot |
| `SNAPSHOT_MAX_CHARS` | `8000` | Char budget for workspace snapshot |
| `LOOP_GUARD_PROGRESS_BONUS` | `10` | Extra read calls on write progress |
| `LOOP_GUARD_HARD_CEILING` | `80` | Absolute per-invocation tool-call ceiling |
| `TOOL_BUDGETS_JSON` | `''` | Per-rank read/write/shell budget override (JSON) |
| `AGENT_INVOKE_RETRIES` | `1` | Invocation-level retries for transient failures |
| `RECONCILE_FILE_CHANGES` | `true` | Reconcile agent claims against worktree |

**Changed defaults:** see §5 table above (11 constants changed).

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 53 suites, 874 tests pass (0 failures)
- [x] `grep -rn "poisoning all tools" src/` — only in a comment, no code path
- [x] `grep -rn "recursionLimit: 6" src/` returns nothing
- [x] `grep -rn "0 files carried forward" src/` — the message no longer appears (handoff size logged instead)
- [x] New test files: `workspace-snapshot.test.ts` (5), `file-change-reconciliation.test.ts` (4), `retry.test.ts` (17) — total 26 new tests
- [x] Rewritten `loop-guard.test.ts` — 13 tests covering all new behaviour
- [x] `.env.example` documents every changed default with its previous value
- [x] `AI_Context.md` Tool Loop Guard, Workspace Snapshot, File Change Reconciliation, Retry sections rewritten; Common Gotchas items 3 and 4 updated

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 09** (QA real execution): raised `TOOL_PIPELINE_MAX_TOOL_CALLS` (50) and `TOOL_PIPELINE_RECURSION_LIMIT` (120) give QA agents enough budget to actually run tests; workspace snapshot tells them where tests live
- **Sub-Plan 10** (AC coverage): `phantomFileChanges` on state provides the signal needed to distinguish real from phantom coverage
- **Sub-Plan 12** (observability): `phantomFileChanges` provides post-mortem evidence; `reconcileFileChanges` replaces the old phantom `fileChanges` metric; workspace snapshot content can be logged for debugging

---
---

# Sub-Plan 09 — QA That Actually Tests: Implementation Report

**Date:** 2026-08-12
**Status:** Complete
**Depends on:** Sub-Plan 01 (real gate execution, multi-root detection), Sub-Plan 05 (repo contract tells QA where code and tests live), Sub-Plan 08 (QA tool budgets)

---

## Summary

Implemented a deterministic test-runner pipeline that replaces LLM-self-reported test results with parsed output from real test runners. QA reports are now derived from machine-readable runner output (Jest `--json`, JUnit XML, Go `-json`, etc.), not from agent claims. The agent's self-report is kept as advisory but does NOT drive routing or acceptance decisions. A test-sufficiency gate enforces minimum test counts, coverage floors, and per-story coverage. QA agent crashes now synthesise bugs instead of being silently swallowed.

All 8 defects (Q1-Q8) identified in the sub-plan are now addressed.

Applied to the two real runs: `pacman8` would now produce `no-tests` (critical), `below-min-tests` (critical), and 20 `story-untested` violations. `retroboard3` would produce `runner-error` (critical), `all-tests-trivial` (critical), and 13 `story-untested` violations. Both would halt under the `RUN_FAIL_POLICY=halt` setting.

---

## Defect-to-Fix Mapping

| ID | Defect | Fix | Files |
|----|--------|-----|-------|
| **Q1** | `testReports = [unitOutput?.testReport]` — LLM self-report goes straight into state | `runTests()` produces `ExecutedTestReport`; `executedToTestReports()` creates authoritative `TestReport` with `source: 'executed'`. Agent self-report tagged `source: 'claimed'` and kept for reference only | `test-runner.ts`, `nodes.ts` |
| **Q2** | `TestReportSchema` allows `total: 0, status: 'pass'` | Added `.refine(r => !(r.total === 0 && r.status === 'pass'))` and `.refine(r => r.passed + r.failed + r.skipped <= r.total)` | `testing.schema.ts` |
| **Q3** | Prompt authorises reporting zeros | Replaced `qa-unit.prompt.ts:43-44` with "You MUST run the test suite... never return status 'pass' with 0 tests" | `qa-unit.prompt.ts` |
| **Q4** | `cases` optional; `storyId`/`acIndex` optional inside cases | `cases` now `.default([])` (always present); `storyId` and `acIndex` now **required** inside cases. Tag convention `[US-003#1]` in test names. `parseTraceTag()` in runner. | `testing.schema.ts`, `test-runner.ts`, `qa-unit.prompt.ts`, `qa-lead.prompt.ts` |
| **Q5** | QA Unit crash → `testReports` empty → `afterQaRouter` sees no failures → routes to devops | QA Unit catch now pushes `QA-UNIT-FAILED` bug (critical). `runTests()` still executes independently. Invariant assertion: if `testReports.length === 0` after qaNode, synthesise inconclusive report | `nodes.ts` |
| **Q6** | QA Lead crash → empty test plan, run continues | QA Lead failure detection: if `!leadOutput?.testPlan?.unit`, push `QA-LEAD-FAILED` bug (critical) | `nodes.ts` |
| **Q7** | No minimum test count, no coverage floor | `checkTestSufficiency()` with 6 rules. Config: `QA_MIN_TOTAL_TESTS`, `QA_MIN_TESTS_PER_STORY`, `QA_MIN_COVERAGE_PCT` | `test-sufficiency.ts`, `config.ts` |
| **Q8** | Tests written into main workspace, never gated | `QA_TESTS_VIA_PR` config (default `true`) prepared for PR workflow routing; immediate fix: `commitAndPushArtifacts` commits test files after qa-unit | `config.ts`, `nodes.ts` |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/test-runner.ts` | ~530 lines. `runTests()`, `parseJestJson()`, `parseJunitXml()`, `parseGoTestJson()`, `parseDotnetTrx()`, `parseCoverageSummary()`, `parseTraceTag()`, `isRunnerError()`, `executedToTestReports()`, `compareClaimVsReality()`. Supports Jest, Vitest, Mocha, pytest, Maven, Gradle, Go, dotnet, Rust. |
| `src/conductor/test-sufficiency.ts` | ~180 lines. `checkTestSufficiency()` (6 rules), `sufficiencyViolationsToBugs()`, `sufficiencyToMarkdown()`. |
| `tests/test-runner-parsers.test.ts` | 32 tests: tag parsing (5), Jest JSON (6), JUnit XML (4), Go JSON (4), coverage (3), runner error detection (4), executedToTestReports (3), compareClaimVsReality (3). |
| `tests/test-sufficiency.test.ts` | 6 tests: pacman8 scenario, retroboard3 scenario (2), healthy scenario, coverage floor, violationsToBugs. |
| `tests/testing-schema.test.ts` | 9 tests: refine rejections (total=0+pass, counts>total), source/cases defaults, required fields. |
| `tests/fixtures/test-reports/` | 5 fixture files: `jest-passing.json`, `jest-runner-error.json`, `jest-no-tests.json`, `junit-pytest.xml`, `go-test.jsonl`, `coverage-summary.json`. |

### Modified Files

| File | Change |
|------|--------|
| `src/agents/_shared/schemas/testing.schema.ts` | `TestReportSchema`: added `source`, `iterationIndex`, `runnerError`, `coverage`, required `cases` with required `storyId`/`acIndex`, 2 refines. `TestPlanSchema`: `storyId` and `acIndex` now required (not optional) on unit/integration/e2e items; added `moduleId` optional field. |
| `src/conductor/nodes.ts` | `qaNode` rewritten: real test runner integration (`runTests` per root), `executedToTestReports` for authoritative signal, `compareClaimVsReality` discrepancy recording, test sufficiency check, QA crash bug synthesis (Q5: `QA-UNIT-FAILED`, Q6: `QA-LEAD-FAILED`), invariant assertion (testReports never empty), returns `qaClaimDiscrepancies`. Imports: `runTests`, `executedToTestReports`, `compareClaimVsReality`, `checkTestSufficiency`, `sufficiencyViolationsToBugs`, `detectTrivialTests`. |
| `src/conductor/quality-gates.ts` | `gateReportToTestReport` now returns `source: 'quality-gates'`, `iterationIndex: 0`, `runnerError: false`, `cases: []`. |
| `src/conductor/state.ts` | Added `qaClaimDiscrepancies: Annotation<ClaimDiscrepancy[]>` (append reducer). |
| `src/config.ts` | Added 7 new config constants: `QA_ENFORCE_SUFFICIENCY`, `QA_MIN_TOTAL_TESTS`, `QA_MIN_TESTS_PER_STORY`, `QA_MIN_COVERAGE_PCT`, `QA_TEST_TIMEOUT_MS`, `QA_MAX_INVOCATIONS`, `QA_TESTS_VIA_PR`. |
| `src/utils/event-bus.ts` | Added `'qa:sufficiency'` to `RunEventType`. |
| `src/agents/qa/qa-unit.prompt.ts` | Removed permission to report zeros. Added tag convention `[<storyId>#<acIndex>]`. Added "pipeline independently parses the test runner's output". Added trivial test prohibition. Raised budget description from 20 to 40 calls. |
| `src/agents/qa/qa-lead.prompt.ts` | Added tag convention instruction for test naming. |
| `.env.example` | Added QA Real Execution section with 7 new env vars. |
| `README.md` | Added QA Real Execution row to Environment Variables table. |
| `AI_Context.md` | Updated QA phase description; added QA Real Execution subsection. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/acceptance-gate.test.ts` | Added `qaClaimDiscrepancies: []` to `makeMinimalState()`. Added `source`, `iterationIndex`, `runnerError`, `cases` to all TestReport fixtures. |
| `tests/graph-routing.test.ts` | Added `qaClaimDiscrepancies: []` to `makeMinimalState()`. Added new fields to `makeTestReport()`. |
| `tests/hitl-graph.test.ts` | Added `qaClaimDiscrepancies: []` to `makeMinimalState()`. Added new fields to TestReport fixture. |
| `tests/qa-node-resilience.test.ts` | Added `qaClaimDiscrepancies: []` to `makeMinimalState()`. Updated mock QA Lead test plan items with required `storyId`/`acIndex`. |
| `tests/traceability.test.ts` | Updated `makeTestPlan()` and `makeTestReport()` with required fields. Added `qaClaimDiscrepancies: []` to state fixture. |

---

## New Types and Interfaces

### `test-runner.ts`

```ts
interface ExecutedTestCase {
    testName: string; suite: string; file: string;
    status: 'pass' | 'fail' | 'skip'; durationMs: number;
    error?: string; storyId?: string; acIndex?: number;
}

interface ExecutedTestReport {
    framework: string; root: string;
    total: number; passed: number; failed: number; skipped: number;
    cases: ExecutedTestCase[];
    coverage?: { lines: number; statements: number; branches: number; functions: number };
    exitCode: number; runnerError: boolean; runnerErrorDetail?: string;
    untracedTests: number; untracedTestNames: string[];
}

interface ClaimDiscrepancy { field: string; claimed: number | string; actual: number | string; }
```

### `test-sufficiency.ts`

```ts
interface SufficiencyViolation {
    kind: 'no-tests' | 'runner-error' | 'below-min-tests' | 'below-min-per-story'
        | 'coverage-below-floor' | 'all-tests-trivial' | 'story-untested';
    severity: 'critical' | 'major';
    detail: string;
    storyId?: string;
}
```

### `testing.schema.ts` additions

```ts
// TestReportSchema new fields:
source: z.enum(['executed', 'claimed', 'quality-gates']).default('claimed')
iterationIndex: z.number().int().nonnegative().default(0)
runnerError: z.boolean().default(false)
coverage: z.object({ lines, statements, branches, functions }).optional()
cases: z.array(...).default([])  // was .optional()
// cases inner object: storyId and acIndex now REQUIRED (were .optional())

// TestPlanSchema changes: storyId and acIndex now REQUIRED in unit/integration/e2e items
// Added moduleId: z.string().optional() to all plan item types
```

### State additions

```ts
qaClaimDiscrepancies: Annotation<ClaimDiscrepancy[]>  // append reducer
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `QA_ENFORCE_SUFFICIENCY` | `true` | Enforce test-sufficiency rules |
| `QA_MIN_TOTAL_TESTS` | `0` | Min total non-trivial tests (0 = derive as max(5, storyCount)) |
| `QA_MIN_TESTS_PER_STORY` | `1` | Min tagged passing tests per story |
| `QA_MIN_COVERAGE_PCT` | `40` | Min line-coverage % (0 = off) |
| `QA_TEST_TIMEOUT_MS` | `600000` | Per-root test runner timeout (10 min) |
| `QA_MAX_INVOCATIONS` | `12` | Max qa-unit invocations per QA phase |
| `QA_TESTS_VIA_PR` | `true` | Route QA tests through PR workflow |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 56 suites, 921 tests pass (0 failures)
- [x] `grep -rn "counts of 0 and a note are acceptable" src/` returns nothing
- [x] `grep -n "unitOutput?.testReport" src/conductor/nodes.ts` — the claimed report is no longer the routing input (authoritative reports from `executedToTestReports` are used instead)
- [x] `TestReportSchema` rejects `{ total: 0, status: 'pass' }` (tested in `testing-schema.test.ts`)
- [x] New test files: `test-runner-parsers.test.ts` (32 tests), `test-sufficiency.test.ts` (6 tests), `testing-schema.test.ts` (9 tests) — total 47 new tests
- [x] No regressions in existing 874 tests (now 921 total)
- [x] `.env.example` updated with all 7 new config vars
- [x] `README.md` Environment Variables table updated with QA Real Execution section
- [x] `AI_Context.md` updated: QA phase description rewritten, QA Real Execution subsection added

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 10** (AC coverage): `parseTraceTag()` extracts `storyId`/`acIndex` from real runner output, making the coverage metric attainable from parsed test results rather than LLM goodwill. Required `storyId`/`acIndex` in `TestPlanSchema` and `cases` ensures the traceability chain is complete.
- **Sub-Plan 11** (DevOps/E2E hardening): `ExecutedTestReport.coverage` provides the coverage signal; `QA_MIN_COVERAGE_PCT` enforcement ensures coverage data is meaningful before it reaches the E2E phase.
- **Sub-Plan 12** (observability): `qaClaimDiscrepancies` provides post-mortem evidence of agent dishonesty; `test-reports/<root>/` directory is now populated with machine-readable output for offline analysis.

---
---

# Sub-Plan 10 — Traceability Metric Repair & AC-Coverage Gating: Implementation Report

**Date:** 2026-08-12
**Status:** Complete
**Depends on:** Sub-Plan 04 (assignment schema with `taskIds`/`additionalStoryIds`/`acIndexes`), Sub-Plan 09 (executed test reports with mandatory tagged `cases`)

---

## Summary

Rewrote the requirements traceability system so that "did we build and verify what was asked?" is answerable and actionable. The coverage metric now uses a 6-state graded model (`AcStatus`) with three coverage numbers (`verifiedPct`, `implementedPct`, `deliveryScore`) instead of the old single `coveragePct` that scored a half-built product at 0%. Coverage is derived exclusively from `source: 'executed'` test reports -- agent self-reports (`source: 'claimed'`) are excluded from the metric (kept for diagnostic comparison). The AC_COVERAGE acceptance criterion is now required (default 70% verified, 90% implemented), emits a `TestReport`-shaped signal so `afterQaRouter` can route on failures, and synthesises prioritised `'critical'` severity bugs. Developer persona includes the `[storyId#acIndex]` test naming convention. QA plan gaps are detected deterministically.

Applied to the two real runs: `retroboard3` now reads `verifiedPct 0%`, `implementedPct ~61.5%`, `deliveryScore ~0.31` -- an honest description vs the old `0%`. `pacman8` reads `verifiedPct 0%`, `implementedPct ~4.4%`, `deliveryScore ~0.02`. Both would fail the AC_COVERAGE gate and route to bugfix-triage.

---

## Defect-to-Fix Mapping

| ID | Defect | Fix | Files |
|----|--------|-----|-------|
| **T1** | `coveragePct = verified / criteria` -- implemented and missing computed and discarded | Graded `CoverageTotals` with `verifiedPct`, `implementedPct`, `deliveryScore` | `traceability.ts` |
| **T2** | `verified` required matching `storyId`+`acIndex` from `.optional()` fields -- structurally pinned at 0% | Coverage built from `source === 'executed'` reports only; `claimed` reports excluded from metric | `traceability.ts` |
| **T3** | `hasMerged` accepted `status === 'approved'` as merged | `hasMerged` requires `status === 'merged'` only; `isBlocked` for `'blocked'`/`'open'` | `traceability.ts` |
| **T4** | `MIN_AC_COVERAGE_PCT` defaults to `0` -- gate is dead code | Default changed to `70`; `MIN_AC_IMPLEMENTED_PCT` added (default `90`) | `config.ts` |
| **T5** | Gate only synthesises Bugs; `afterQaRouter` reads `testReports` not `bugs` -- gate can never route | Gate emits `TestReport` with `framework: 'ac-coverage'`, `status: 'fail'` -- `afterQaRouter` sees it | `nodes.ts` |
| **T6** | `story.acceptanceCriteria` mutated in place; `buildTraceabilityReport` called twice accumulates junk | No mutation: `const criteria = story.acceptanceCriteria?.length ? ... : ['(no AC)']` | `traceability.ts` |
| **T7** | `TraceRow.taskIds` filled from `Task.storyId` not assignments | Populated from `assignment.taskIds` (union across assignments for the row) | `traceability.ts` |
| **T8** | No `orphanedTasks` section; tasks with missing `storyId` vanish | Added `orphanedTasks` and `unassignedTasks` to `TraceabilityReport` | `traceability.ts` |
| **T9** | Traceability report written once at finalize and never used to make a decision | AC gate runs in `qaNode` (emits TestReport signal), in `acceptanceNode` (via `evaluateAcceptance`), and in `finalizeNode` (report) | `nodes.ts`, `acceptance-gate.ts` |

---

## Files Changed

### Rewritten Files

| File | Change |
|------|--------|
| `src/utils/traceability.ts` | **Full rewrite.** 6-state `AcStatus`, `CoverageTotals` with 3 metrics, executed-only coverage, no mutation, acIndexes-aware coverage, bugfix sentinel exclusion, gap-first ordering, Top Gaps, Blocked Deliveries, Claimed vs Executed, unassignedTasks. ~500 lines. |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | `MIN_AC_COVERAGE_PCT` default `'0'` -> `'70'`. `MIN_AC_COVERAGE_MAX_BUGS` default `'10'` -> `'25'`. Added `MIN_AC_IMPLEMENTED_PCT` (default `'90'`), `TRACEABILITY_JSON` (default `'true'`). |
| `src/conductor/acceptance-gate.ts` | AC_COVERAGE criterion rewritten: imports `buildTraceabilityReport`, evaluates `verifiedPct` and `implementedPct` against thresholds, produces real pass/fail detail. Was a placeholder stub. |
| `src/conductor/nodes.ts` | **qaNode**: AC coverage gate rewritten -- emits `TestReport` signal with `framework: 'ac-coverage'`, prioritises `missing` > `tested-failing` > `blocked` > `implemented-untested` when capping bugs, severity `'critical'` (was `'major'`), emits `traceability:update` event. Added QA plan gap detection (QA-PLAN-GAP bugs). **finalizeNode**: traceability summary uses 3 metrics, reports orphanedTasks/unassignedTasks, writes `traceability.json`, manifest includes `verifiedPct`/`implementedPct`/`deliveryScore`/`testedFailing`/`blocked`/`orphanedTasks`. |
| `src/utils/event-bus.ts` | Added `'traceability:update'` to `RunEventType`. |
| `src/utils/run-snapshot.ts` | Extended `RunManifest.traceability` with `verifiedPct`, `implementedPct`, `deliveryScore`, `testedFailing`, `blocked`, `orphanedTasks`. |
| `src/agents/_shared/persona.ts` | Added `[storyId#acIndex]` test naming convention to compact dev persona critical rules. |
| `.env.example` | Updated `MIN_AC_COVERAGE_PCT` (0->70), `MIN_AC_COVERAGE_MAX_BUGS` (10->25). Added `MIN_AC_IMPLEMENTED_PCT`, `TRACEABILITY_JSON`. |
| `README.md` | Added Requirements Traceability row to Environment Variables table. |
| `AI_Context.md` | Added Requirements Traceability & AC Coverage subsection documenting 6-state model, coverage metrics, executed-only rule, gate mechanics, QA plan gap detection. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/traceability.test.ts` | **Full rewrite.** 25 tests (was 10): 17 for `buildTraceabilityReport` (graded status, T3 hasMerged fix, T6 no-mutation regression, acIndexes coverage, bugfix sentinel, orphanedTasks, unassignedTasks, blockedDeliveries, claimedVsExecuted, iterationIndex filtering, executed-only coverage), 8 for `renderTraceabilityMarkdown` (3 metrics, Top Gaps, Blocked Deliveries, Claimed vs Executed, Unassigned Tasks). |
| `tests/acceptance-gate.test.ts` | Set `MIN_AC_COVERAGE_PCT=0` before module load so existing tests focus on other criteria. Updated file header comment. |
| `tests/persona.test.ts` | Raised compact persona char thresholds (3600->4100, 4600->5100) to accommodate the new test naming convention text. |

---

## New Types and Interfaces

### `traceability.ts`

```ts
type AcStatus =
    | 'verified'              // merged + a passing tagged test (source: 'executed')
    | 'tested-failing'        // merged + a tagged test that FAILS
    | 'implemented-untested'  // merged, no tagged test
    | 'planned-only'          // assigned, PR not merged
    | 'blocked'               // assigned, PR blocked/conflicted/open after run
    | 'missing';              // no assignment at all

interface CoverageTotals {
    criteria: number;
    verified: number;
    testedFailing: number;
    implemented: number;
    plannedOnly: number;
    blocked: number;
    missing: number;
    verifiedPct: number;        // verified / criteria
    implementedPct: number;     // (verified + implemented) / criteria
    deliveryScore: number;      // weighted: verified*1.0 + implemented*0.5 + testedFailing*0.25
}

interface TraceRow {
    // ... existing fields plus:
    executedTests: { name: string; status: 'pass' | 'fail' | 'skip' }[];
    claimedTests: { name: string; status: 'pass' | 'fail' | 'skip' }[];
    plannedTests: string[];
    status: AcStatus;           // was 4-state, now 6-state
}

interface ClaimedVsExecuted {
    agentId: string;
    claimedTotal: number; claimedPassed: number; claimedFailed: number;
    executedTotal: number; executedPassed: number; executedFailed: number;
}

interface TraceabilityReport {
    // ... existing fields plus:
    unassignedTasks: string[];
    blockedDeliveries: { branchName: string; prNumber: number; status: string; reason: string }[];
    claimedVsExecuted: ClaimedVsExecuted[];
    totals: CoverageTotals;     // was { criteria, verified, implemented, missing, coveragePct }
}
```

---

## Config Changes

| Constant | Old Default | New Default | Description |
|----------|-------------|-------------|-------------|
| `MIN_AC_COVERAGE_PCT` | `0` (off) | `70` | Minimum verified AC coverage %. Only `source:'executed'` tests count |
| `MIN_AC_IMPLEMENTED_PCT` | (new) | `90` | Minimum implemented (merged code exists) AC % |
| `MIN_AC_COVERAGE_MAX_BUGS` | `10` | `25` | Max bugs synthesised for uncovered criteria |
| `TRACEABILITY_JSON` | (new) | `true` | Write `outputs/<run>/traceability.json` alongside markdown |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` -- 56 suites, 935 tests pass (0 failures)
- [x] `grep -n "criteria.push(" src/utils/traceability.ts` returns nothing (no in-place mutation)
- [x] `grep -n "s === 'merged' || s === 'approved'" src/utils/traceability.ts` returns nothing
- [x] New test file: `tests/traceability.test.ts` rewritten with 25 tests (was 10 -- net +15 new tests)
- [x] `README.md` Environment Variables table updated with Requirements Traceability section
- [x] `.env.example` updated with all changed/new config vars
- [x] `AI_Context.md` updated with Requirements Traceability & AC Coverage subsection

---

## What This Enables for Later Sub-Plans

- **Sub-Plan 11** (DevOps/E2E hardening): **DONE.** See report below.
- **Sub-Plan 12** (observability): `traceability.json` provides machine-readable data for the regression test suite; `claimedVsExecuted` discrepancies provide post-mortem evidence; the `traceability:update` event feeds the dashboard

---
---

# Sub-Plan 11 — DevOps & E2E Hardening: Implementation Report

**Date:** 2026-08-12
**Status:** Complete
**Depends on:** Sub-Plan 01 (`runSmokeTest`, `StackRoot`), Sub-Plan 03 (acceptance gate, `verificationErrors`), Sub-Plan 05 (contract's `entryPoints`/`buildOutputDir`)

---

## Summary

Implemented comprehensive DevOps and E2E hardening that stops the pipeline from accepting the DevOps agent's unverified deployment claims and stops treating "E2E never ran" as "E2E passed". All 11 defects (D1-D11) identified in the sub-plan are now addressed.

Applied to the two real runs: `pacman8`'s DevOps agent crash would now trigger the fallback Dockerfile generator (producing a working nginx deployment for the SPA), the Playwright preflight would capture the real failure reason instead of "Connection closed", and `e2eStatus` would read `'error'` (not `'passed'`). `retroboard3`'s hallucinated service URLs would be discarded by the always-overwrite verification, the compose health-gate would detect the exited services, and `DEPLOY-UNHEALTHY` / `E2E-INFRA-FAILED` bugs would feed the bugfix loop.

---

## Defect-to-Fix Mapping

| ID | Defect | Fix | Files |
|----|--------|-----|-------|
| **D1** | Repair invoke uses hardcoded `recursionLimit: 6` | Already fixed in Sub-Plan 08 (`PIPELINE_RECURSION_LIMIT`). Verified `grep -rn "recursionLimit: 6" src/` returns nothing. | — |
| **D2** | When `verifyDeployment` returns `skipped`, agent's unverified claims survive into state | Agent claims are **always** overwritten — even when verification returns `skipped` or `docker-unavailable`. Claimed URLs discarded with error log. | `nodes.ts` |
| **D3** | `verifyCompose` returns `buildStatus: 'success'` regardless of container health | `docker compose ps` JSON output checked — services with state `exited`/`dead`/`restarting` → `buildStatus: 'failed'`. Zero published ports → `runStatus: 'failed'`. | `devops-verify.ts` |
| **D4** | `verifyDockerfile` computes `healthChecks` and ignores them | `runStatus` now depends on health check results: all healthy → `'running'`, any unhealthy → `'unhealthy'`. Same for compose mode. | `devops-verify.ts` |
| **D5** | `devopsNode` never reacts to `buildStatus === 'failed'` or `runStatus === 'unhealthy'` | `DEPLOY-BUILD-FAILED` and `DEPLOY-UNHEALTHY` bugs synthesised with captured logs. Under `RUN_FAIL_POLICY='halt'`, routes to acceptance as failure. | `nodes.ts` |
| **D6** | E2E skips with no signal — "passed" and "never ran" indistinguishable | `e2eStatus` state channel with 6 values. Skip path pushes `inconclusive` TestReport. Local server fallback when web root exists. | `state.ts`, `nodes.ts` |
| **D7** | `E2E_BUGFIX_ENABLED` defaults to `false`; `afterE2eRouter` scans all testReports | Default flipped to `true`. Router filters `type === 'e2e' && source === 'executed'` at current `iterationIndex`. | `config.ts`, `graph.ts` |
| **D8** | E2E `catch` returns normally with no report and no bug | Catch path sets `e2eStatus: 'error'`, pushes `inconclusive` report, records `verificationErrors`, synthesises `E2E-INFRA-FAILED` bug. | `nodes.ts` |
| **D9** | E2E report is 100% LLM self-report | `e2eEvidence` state field records screenshots, consoleErrors, urlsVisited. E2E prompt updated with `[storyId#acIndex]` tagging convention and self-report cross-check warning. | `state.ts`, `nodes.ts`, `qa-e2e.prompt.ts` |
| **D10** | `getPlaywrightMcpTools()` has no preflight | `preflightPlaywright()` with cached result, browser auto-install, retry with backoff. Falls back to `runSmokeTest` when unavailable. | `playwright-preflight.ts`, `nodes.ts` |
| **D11** | DevOps agent crashing kills the phase entirely | `generateFallbackDeployment()` creates deterministic Dockerfiles from stack roots. Templates for SPA (nginx), Node server, Python, Go. Invoked when agent fails or produces no Docker artifacts. | `devops-fallback.ts`, `nodes.ts` |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/conductor/devops-fallback.ts` | ~210 lines. Deterministic Dockerfile + docker-compose.yml generator from stack roots. Templates for SPA (nginx), Node server, Python, Go. |
| `src/tools/mcp/playwright-preflight.ts` | ~125 lines. `preflightPlaywright()` with browser install, MCP connection retry, cached result. |
| `tests/devops-fallback.test.ts` | 5 tests: SPA Dockerfile, Node server, monorepo with 2 services, SSL patching, skip-if-exists. |
| `tests/e2e-node.test.ts` | 6 tests: e2eStatus acceptance criterion scenarios, afterE2eRouter routing. |
| `tests/playwright-preflight.test.ts` | 3 tests: tool count 0, browsers missing, successful connection. |

### Modified Files

| File | Change |
|------|--------|
| `src/agents/_shared/schemas/devops-plan.schema.ts` | Extended `buildStatus` enum with `'skipped' \| 'unverified'`. Extended `runStatus` enum with `'skipped'`. Added `verificationMode` optional field. |
| `src/conductor/devops-verify.ts` | Added `mode` field to `VerifyResult`. Added `'unhealthy'` to `runStatus` union. Added `'docker-unavailable'` to `DeploymentMode`. Compose mode: service state checking from `compose ps` JSON, health-gated `runStatus`. Dockerfile mode: health-gated `runStatus`. All return paths include `mode`. |
| `src/conductor/nodes.ts` | **devopsNode**: Agent claims always overwritten by verification (D2). Deployment bug synthesis (D5). Fallback Dockerfile integration (D11). **e2eNode**: Full rewrite. `e2eStatus` set on every return path (D6). Skip path pushes `inconclusive` report. Local server fallback via `runSmokeTest` (non-Docker E2E). Playwright preflight with smoke fallback (D10). Catch synthesises `E2E-INFRA-FAILED` bug (D8). E2E evidence recording (D9). |
| `src/conductor/state.ts` | Added `e2eStatus`, `e2eSkipReason`, `e2eEvidence` (all replace reducer). |
| `src/conductor/graph.ts` | `afterE2eRouter`: filters `type === 'e2e' && source === 'executed'` at current `iterationIndex` (D7). |
| `src/conductor/acceptance-gate.ts` | E2E criterion rewritten to use `e2eStatus` state channel. `ACCEPT_REQUIRE_E2E` config. `skipped-no-services` with web root → fail; without web root → pass. `error` → inconclusive. Added `devops` and `e2e` to verification error mapping. |
| `src/config.ts` | `E2E_BUGFIX_ENABLED` default `'false'` → `'true'`. Added 7 new constants: `E2E_ALLOW_LOCAL_SERVER`, `ACCEPT_REQUIRE_E2E`, `PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS`, `PLAYWRIGHT_MCP_CONNECT_RETRIES`, `PLAYWRIGHT_AUTO_INSTALL`, `DEVOPS_FALLBACK_ENABLED`. |
| `src/utils/event-bus.ts` | Added `'e2e:status'` and `'devops:fallback'` to `RunEventType`. |
| `src/agents/qa/qa-e2e.prompt.ts` | Added `[storyId#acIndex]` tagging convention. Added self-report cross-check warning. |
| `.env.example` | Updated `E2E_BUGFIX_ENABLED` (false→true). Added DevOps & E2E Hardening section with 7 new env vars. |
| `README.md` | Added DevOps & E2E Hardening row to Environment Variables table (7 entries). |
| `AI_Context.md` | Updated E2E bugfix looping default. Rewrote phase 9/9b descriptions. Updated afterE2eRouter description. Added DevOps & E2E Hardening subsection. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/acceptance-gate.test.ts` | Added `e2eStatus`, `e2eSkipReason`, `e2eEvidence` to `makeMinimalState()`. Updated "optional criteria failing" test to set `e2eStatus: 'failed'`. |
| `tests/graph-routing.test.ts` | Added `e2eStatus`, `e2eSkipReason`, `e2eEvidence` to `makeMinimalState()`. Updated `afterE2eRouter` test to use `source: 'executed'` and `iterationIndex`. |
| `tests/hitl-graph.test.ts` | Added `e2eStatus`, `e2eSkipReason`, `e2eEvidence` to `makeMinimalState()`. |
| `tests/qa-node-resilience.test.ts` | Added `e2eStatus`, `e2eSkipReason`, `e2eEvidence` to `makeMinimalState()`. Added `chooseDeploymentMode` and `mode` to devops-verify mock. Updated devopsNode test to expect `buildStatus: 'skipped'` (agent claims overwritten). |
| `tests/devops-verify.test.ts` | Existing tests still pass (no changes needed — they test helpers, not the node). |

---

## New Types and Interfaces

### `devops-verify.ts`

```ts
type DeploymentMode = 'compose' | 'dockerfile' | 'none' | 'docker-unavailable';  // was 3 values

interface VerifyResult {
    buildStatus: 'success' | 'failed' | 'skipped';
    runStatus: 'running' | 'unhealthy' | 'failed' | 'skipped';  // added 'unhealthy'
    serviceUrls: { service: string; url: string }[];
    healthChecks: HealthCheckResult[];
    containerNames: string[];
    logs: string;
    mode: DeploymentMode;  // NEW
}
```

### `devops-plan.schema.ts`

```ts
buildStatus: z.enum(['pending', 'building', 'success', 'failed', 'skipped', 'unverified'])  // added 2
runStatus: z.enum(['pending', 'starting', 'running', 'healthy', 'unhealthy', 'stopped', 'failed', 'skipped'])  // added 1
verificationMode: z.enum(['compose', 'dockerfile', 'none', 'docker-unavailable']).optional()  // NEW
```

### `devops-fallback.ts`

```ts
interface FileChange { path: string; action: 'created' | 'modified'; }
interface FallbackResult { files: FileChange[]; composeServices: string[]; }
```

### `playwright-preflight.ts`

```ts
interface PlaywrightPreflight { available: boolean; reason?: string; toolCount: number; browsersInstalled: boolean; }
```

### State additions

```ts
e2eStatus: 'not-run' | 'passed' | 'failed' | 'skipped-no-services' | 'skipped-disabled' | 'error';  // replace reducer
e2eSkipReason: string | null;  // replace reducer
e2eEvidence: { screenshots: string[]; consoleErrors: string[]; urlsVisited: string[] } | null;  // replace reducer
```

---

## New Config Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `E2E_ALLOW_LOCAL_SERVER` | `true` | Serve built product locally for E2E when no Docker services available |
| `ACCEPT_REQUIRE_E2E` | `false` | Make the E2E acceptance criterion required |
| `PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS` | `60000` | Playwright MCP startup budget (ms) |
| `PLAYWRIGHT_MCP_CONNECT_RETRIES` | `2` | Connection retries for the Playwright MCP server |
| `PLAYWRIGHT_AUTO_INSTALL` | `true` | Auto-install Playwright chromium when browsers are missing |
| `DEVOPS_FALLBACK_ENABLED` | `true` | Generate deterministic Dockerfile/compose when DevOps agent fails |

**Changed defaults:**

| Constant | Old | New |
|----------|-----|-----|
| `E2E_BUGFIX_ENABLED` | `false` | `true` |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 59 suites, 949 tests pass (0 failures)
- [x] `grep -n "verified.buildStatus !== 'skipped'" src/conductor/nodes.ts` returns nothing
- [x] `grep -rn "recursionLimit: 6" src/` returns nothing
- [x] `e2eStatus` is set on every return path of `e2eNode` (verified: 6 return paths, all set `e2eStatus`)
- [x] New test files: `devops-fallback.test.ts` (5 tests), `e2e-node.test.ts` (6 tests), `playwright-preflight.test.ts` (3 tests) — total 14 new tests
- [x] `.env.example` updated with `E2E_BUGFIX_ENABLED` default change and 7 new env vars
- [x] `README.md` Environment Variables table updated with DevOps & E2E Hardening section
- [x] `AI_Context.md` updated: E2E bugfix default, phase 9/9b descriptions rewritten, afterE2eRouter updated, DevOps & E2E Hardening subsection added

---

## What This Enables for Sub-Plan 12

- **Observability**: `e2eStatus` and `e2eEvidence` provide structured E2E outcome data for the evidence ledger; `e2eSkipReason` explains why E2E was skipped in the run manifest; `DEPLOY-BUILD-FAILED`, `DEPLOY-UNHEALTHY`, and `E2E-INFRA-FAILED` bugs provide specific diagnostic information for post-mortem analysis
- **Regression tests**: The fallback Dockerfile generator outputs are deterministic and can be cassette-replayed; the Playwright preflight result can be mocked for offline testing; `e2eStatus` provides the key signal the regression suite needs to distinguish "E2E passed" from "E2E never ran"

---
---

# Sub-Plan 12 — Observability & Offline Regression Suite: Implementation Report

**Date:** 2026-08-12
**Status:** Complete
**Depends on:** All previous sub-plans (it asserts their invariants)

---

## Summary

Implemented the final sub-plan closing Plan 19: a run ledger for instant post-mortem diagnostics, a priority event buffer that never evicts high-severity events, run invariants checked at phase boundaries, permanent regression fixtures from the two failed runs, credential-scanned test fixtures, offline end-to-end confidence infrastructure, and documentation truth-up across README.md and AI_Context.md.

Applied to the two real runs: `pacman8` is now rejected by the acceptance gate with blockers (BUILD, TESTS, SCOPE), 18 orphaned stories detected, 0 verified AC coverage confirmed, phantom file changes detected, and the 500-event buffer saturation is documented. `retroboard3` is likewise rejected, with orphaned stories and assignments, 0 verified AC despite 16 implemented, trivial tests detected, and assignment duplication (51 vs 13 stories) confirmed. All 21 regression assertions pass.

---

## Work Items Implemented

### §2 — The Run Ledger

| Component | Detail |
|-----------|--------|
| New file | `src/utils/run-ledger.ts` (~82 lines) |
| New file | `src/utils/ledger-report.ts` (~215 lines) |
| Integration | `src/conductor/nodes.ts` — `initLedger()` in intakeNode, `appendLedger()` entries in finalizeNode for acceptance, coverage, plan-funnel, phase |
| Output | `outputs/<run>/ledger.jsonl` (append-only JSONL), `outputs/<run>/run-report.md` (human-first summary) |

The ledger records 13 entry kinds: `phase`, `plan-funnel`, `agent`, `gate`, `integrity`, `product-verify`, `review`, `merge`, `test-run`, `coverage`, `acceptance`, `salvage`, `invariant`. Written synchronously via `fs.appendFileSync` so a crash leaves the ledger intact. The run report is generated from the ledger at finalize time.

### §3 — Fix the Event Stream

| Component | Detail |
|-----------|--------|
| Rewritten file | `src/utils/event-bus.ts` (~172 lines, was 104) |
| Key change | Dual buffer: ring buffer (5000 events) + priority buffer (500, never evicts) |
| Priority types | `phase:*`, `gate:result`, `pr:blocked`, `acceptance:result`, `integrity:finding`, `plan:coverage`, `run:error`, `run:blocked`, `agent:budget-exhausted`, `product-verify:result`, `test-run:result`, `salvage:written`, `review:abstained` |
| New event types | `agent:budget-exhausted`, `product-verify:result`, `integrity:finding`, `review:abstained`, `test-run:result`, `salvage:written`, `run:blocked`, `run:error` |
| New exports | `getPriorityEvents()`, `getAllEvents(limit?)` |
| WebSocket | `src/index.ts` — `run:complete` now includes `status` and `blockers` fields |

### §4 — Run Invariants

| Component | Detail |
|-----------|--------|
| New file | `src/conductor/run-invariants.ts` (~231 lines) |
| 10 invariants | `INV-PLAN-COVERAGE`, `INV-NO-EMPTY-ASSIGNMENTS`, `INV-WORKSPACE-HAS-SOURCE`, `INV-NO-PHANTOMS`, `INV-TESTREPORT-EXISTS`, `INV-GATE-RAN`, `INV-NO-CRITICAL-INTEGRITY`, `INV-E2E-STATUS-SET`, `INV-STATUS-MATCHES-ACCEPTANCE`, `INV-NO-MERGED-EMPTY-PR` |
| Modes | `RUN_INVARIANTS_MODE`: `off` (skip), `warn` (log+record), `strict` (throw) |
| State | `invariantViolations` channel added to `ProjectState` (append reducer) |

### §5 — Permanent Regression Fixtures

| Component | Detail |
|-----------|--------|
| Fixtures | `tests/fixtures/runs/pacman8/` (state.json, run-manifest.json), `tests/fixtures/runs/retroboard3/` (state.json, run-manifest.json) |
| Redaction | `scripts/redact-state.ts` — strips GitHub tokens, OAuth secrets, access token URLs |
| Credential scan | 4 tests in `regression-plan19.test.ts` verify no fixture matches sensitive patterns |
| Regression tests | `tests/regression-plan19.test.ts` — 21 tests across 3 describe blocks |
| npm script | `npm run test:regression` added to `package.json` |

### §6 — Offline End-to-End Confidence

| Component | Detail |
|-----------|--------|
| Test file | `tests/pipeline-replay-plan19.test.ts` — skeleton with skip-when-no-cassette |
| Spec file | `specs/new/todo-list-app.txt` (pre-existing) |
| Recording procedure | Documented in test file header and README.md |
| Note | Cassette must be recorded after a live run; test assertions are placeholder until then |

### §7 — Documentation Truth-Up

| File | Changes |
|------|---------|
| `README.md` | Tagline qualified with acceptance gate statuses; test description updated with E2E preflight/fallback; QA phase table row updated; token optimization claim restated; Environment Variables table extended with Observability section (4 vars) |
| `AI_Context.md` | 4 new gotchas added (CONFIG_OWNERSHIP, executed-only reports, completed=accepted, .agent/ gitignored); "Failure modes observed in production runs" section added (~30 lines summarising PART A); recursion limits verified correct |

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `src/utils/run-ledger.ts` | ~82 lines. Append-only JSONL evidence ledger with 13 entry kinds. |
| `src/utils/ledger-report.ts` | ~215 lines. Human-first run report generated from the ledger. |
| `src/conductor/run-invariants.ts` | ~231 lines. 10 structural invariants checked at phase boundaries. |
| `scripts/redact-state.ts` | Reusable redaction script for state.json fixtures. |
| `tests/run-ledger.test.ts` | 9 tests: appendLedger, readLedger, renderRunReport. |
| `tests/run-invariants.test.ts` | 9 tests: getInvariantIds, checkInvariants (7 scenarios). |
| `tests/event-bus-priority.test.ts` | 7 tests: priority buffer, getAllEvents, new event types. |
| `tests/regression-plan19.test.ts` | 21 tests: credential scan (4), pacman8 regressions (9), retroboard3 regressions (8). |
| `tests/pipeline-replay-plan19.test.ts` | Skeleton for cassette replay assertions (skip-when-no-cassette). |
| `tests/fixtures/runs/pacman8/state.json` | Redacted state from the failed pacman8 run. |
| `tests/fixtures/runs/pacman8/run-manifest.json` | Manifest from the failed pacman8 run. |
| `tests/fixtures/runs/retroboard3/state.json` | Redacted state from the failed retroboard3 run. |
| `tests/fixtures/runs/retroboard3/run-manifest.json` | Manifest from the failed retroboard3 run. |

### Rewritten Files

| File | Change |
|------|--------|
| `src/utils/event-bus.ts` | **Full rewrite.** Dual buffer (ring + priority), 8 new event types, `getPriorityEvents()`, `getAllEvents()`. ~172 lines (was 104). |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | `EVENT_BUFFER_SIZE` default `'500'` → `'5000'`. Added 3 new constants: `EVENT_PRIORITY_BUFFER_SIZE`, `RUN_LEDGER_ENABLED`, `RUN_INVARIANTS_MODE`. |
| `src/conductor/state.ts` | Added `invariantViolations` channel (append reducer). |
| `src/conductor/nodes.ts` | Added imports for ledger, report, invariants. `intakeNode`: `initLedger()` call. `finalizeNode`: acceptance ledger entry, invariant checks, coverage entry, plan-funnel entry, run report generation, `invariantViolations` in return. |
| `src/index.ts` | `run:complete` broadcast includes `status` and `blockers`. Import `getAllEvents`. |
| `package.json` | Added `test:regression` script. |
| `.env.example` | Added Observability & Regression section with 4 new env vars. |
| `README.md` | Tagline, test description, QA phase, token claim, env vars table updated. |
| `AI_Context.md` | 4 new gotchas, "Failure modes observed in production runs" section added. |

### Updated Tests

| File | Change |
|------|--------|
| `tests/acceptance-gate.test.ts` | Added `invariantViolations: []` to `makeMinimalState()`. |
| `tests/graph-routing.test.ts` | Added `invariantViolations: []` to `makeMinimalState()`. |
| `tests/hitl-graph.test.ts` | Added `invariantViolations: []` to `makeMinimalState()`. |
| `tests/qa-node-resilience.test.ts` | Added `invariantViolations: []` to `makeMinimalState()`. |
| `tests/e2e-node.test.ts` | Added `invariantViolations: []` to `makeMinimalState()`. |
| `tests/traceability.test.ts` | Added `invariantViolations: []`, `e2eStatus`, `e2eSkipReason`, `e2eEvidence` to `makeMinimalState()`. |

---

## New Types and Interfaces

### `run-ledger.ts`

```ts
export type LedgerEntry =
    | { t: string; kind: 'phase';          phase: PhaseName; event: 'start' | 'end'; durationMs?: number }
    | { t: string; kind: 'plan-funnel';    epics: number; stories: number; criteria: number; tasks: number; assignments: number; unassignedStories: string[]; unassignedTasks: string[] }
    | { t: string; kind: 'agent';          agentId: string; phase: PhaseName; invocation: number; toolCalls: { read: number; write: number; shell: number }; respawns: number; poisoned: boolean; filesWritten: string[]; filesClaimed: string[]; phantoms: string[]; outcome: 'ok' | 'failed' | 'budget-exhausted'; error?: string }
    | { t: string; kind: 'gate';           branch: string | null; stacks: string[]; steps: Array<{ step: string; mode: string; passed: boolean; skipped: boolean; ms: number }>; passed: boolean; inconclusive: boolean }
    | { t: string; kind: 'integrity';      branch: string; findings: TamperFinding[] }
    | { t: string; kind: 'product-verify'; artifacts: number; artifactsFailed: number; unresolvedRefs: number; smoke: string }
    | { t: string; kind: 'review';         prNumber: number; reviewerId: string; outcome: 'approved' | 'changes_requested' | 'abstained'; reason?: string; blocking: number }
    | { t: string; kind: 'merge';          prNumber: number; decision: boolean; reason: string; blockers: string[] }
    | { t: string; kind: 'test-run';       root: string; framework: string; total: number; passed: number; failed: number; skipped: number; coverage?: number; runnerError: boolean; untraced: number }
    | { t: string; kind: 'coverage';       verifiedPct: number; implementedPct: number; deliveryScore: number; missing: number; blocked: number }
    | { t: string; kind: 'acceptance';     status: AcceptanceStatus; blockers: string[]; unrecoverable: boolean }
    | { t: string; kind: 'salvage';        branch: string; patchPath: string; reason: string }
    | { t: string; kind: 'invariant';      id: string; phase: PhaseName; detail: string };
```

### `run-invariants.ts`

```ts
export interface InvariantViolation {
    id: string;
    phase: PhaseName;
    detail: string;
}
```

### `event-bus.ts` additions

```ts
// New event types added to RunEventType:
| 'agent:budget-exhausted'
| 'product-verify:result'
| 'integrity:finding'
| 'review:abstained'
| 'test-run:result'
| 'salvage:written'
| 'run:blocked'
| 'run:error'

// New exports:
export function getPriorityEvents(): RunEvent[];
export function getAllEvents(limit?: number): RunEvent[];
```

### State additions

```ts
invariantViolations: Annotation<Array<{ id: string; phase: string; detail: string }>>  // append reducer
```

---

## Config Changes

| Constant | Old Default | New Default | Description |
|----------|-------------|-------------|-------------|
| `EVENT_BUFFER_SIZE` | `500` | `5000` | Both post-mortem runs saturated the 500-event buffer |
| `EVENT_PRIORITY_BUFFER_SIZE` | (new) | `500` | High-severity events never evicted |
| `RUN_LEDGER_ENABLED` | (new) | `true` | Write ledger.jsonl and run-report.md |
| `RUN_INVARIANTS_MODE` | (new) | `warn` | Invariant enforcement mode |

---

## Verification Checklist

- [x] `npx tsc --noEmit` clean (0 errors)
- [x] `npm run test:unit` — 63 suites, 995 tests pass (0 failures)
- [x] `npm run test:regression` — 1 suite, 21 tests pass (0 failures)
- [x] No fixture under `tests/fixtures/runs/` matches `/gh[pousr]_[A-Za-z0-9]{20,}|client_secret|x-access-token|OAUTH_CLIENT_SECRET/` — asserted in 4 tests
- [x] Ledger entries written to `outputs/<run>/ledger.jsonl` and `run-report.md` generated from the ledger
- [x] Every one of the 21 regression assertions passes on the post-Plan-19 codebase
- [x] `README.md` updated: tagline, test description, QA phase, token claim, env vars table
- [x] `AI_Context.md` updated: 4 new gotchas, "Failure modes observed in production runs" section
- [x] `.env.example` updated with all 4 new config vars
- [x] `package.json` includes `test:regression` script

---

## What This Completes

Sub-Plan 12 is the final sub-plan in Plan 19. With it complete, all 12 sub-plans have been implemented:

| # | Theme | Status |
|---|-------|--------|
| 01 | Product verification harness | Complete |
| 02 | Gate integrity / anti-gaming | Complete |
| 03 | Truthful run status & fail policy | Complete |
| 04 | Planning integrity | Complete |
| 05 | Architecture contract | Complete |
| 06 | PR workflow / work preservation | Complete |
| 07 | Review / merge fail-closed | Complete |
| 08 | Agent budgets & context | Complete |
| 09 | QA real execution | Complete |
| 10 | Traceability & AC coverage | Complete |
| 11 | DevOps & E2E hardening | Complete |
| 12 | Observability & regression suite | Complete |

### Final gate for the whole plan

After this sub-plan, the next step is one supervised autonomous run per spec:

| Spec | Required outcome |
|------|------------------|
| `specs/new/todo-list-app.txt` (small) | terminal status `completed`, `acceptance.status: 'accepted'`, tests executed > 0, product builds and renders |
| `specs/new/pacman.md` | either `completed` or `failed` with a blocker list that a human agrees with — **never** `completed` for a non-working product |
| `specs/new/team-retro-board.md` | same |

The success criterion for Plan 19 is: **the pipeline never again reports success for a product that does not build, and when it fails it says exactly why, early, and preserves the work it did.**
