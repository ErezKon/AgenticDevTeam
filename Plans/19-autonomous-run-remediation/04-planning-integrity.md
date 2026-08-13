# Sub-Plan 04 — Planning Integrity: Stop Silent Scope Loss

**Depends on:** nothing (can run in parallel with 01–03).
**Goal:** what the Product Manager plans must survive to the developers. Today 18 of 20 stories evaporated between
the PM and the Team Leader, silently, and the run reported success.

---

## 1. Evidence

`pacman8 run.log` lines 40–75, verbatim:

```
40 | [Product Manager] INFO Stories: 20, Tasks: 26
62 | [InvokeAgent] WARN Agent "tl" output failed schema validation:
63 | - assignments.4.taskType: Invalid option: expected one of "feature"|"bug"|"fix"|"refactor"|"chore"
   |   … (7 such errors) …
69 | - assignments.25.taskType: Invalid option: expected one of "feature"|"bug"|"fix"|"refactor"|"chore"
70 | [InvokeAgent] INFO Repair attempt 1/1 for "tl"...
74 | [InvokeAgent] INFO Agent "tl" repaired on attempt 1
75 | [Team Leader] INFO Assignments: 7
```

An error at index `25` proves the original output had ≥26 assignments. After one "successful" repair: **7**.
Nineteen assignments vanished and the pipeline advanced without comment. Outcome
(`outputs/pacman8-*/traceability.md`):

```
| Total acceptance criteria | 45 |
| Verified                  | 0  |
| Missing (no assignment)   | 41 |
Orphaned Stories: US-002 … US-018, US-999   (18 of 20)
```

`retroboard3` shows the mirror-image failure: 51 assignments but 5 of them
(`ASSIGN-001 … ASSIGN-005`, `BUGFIX-1-ASSIGN-051`) had a `storyId` matching no user story, so
`storiesForIds` returned the literal string `(no matching stories)` and those developers built from a
one-paragraph description with zero acceptance criteria.

### Root causes in code

| ID | Defect | Location |
|---|---|---|
| P1 | The repair prompt clips the previous output to **4,000 chars** and asks for "the SAME information, corrected" — repairing a 20k-char assignment list is lossy by construction | `src/utils/structured-output.ts:142-146, 151` |
| P2 | `AGENT_OUTPUT_REPAIR_ATTEMPTS = 1`, and the repair invoke uses `recursionLimit: 6` | `config.ts:241`, `nodes.ts:403-415` |
| P3 | `jsonrepair` closes a truncated array and returns `{ ok: true }`; `_recordValidated()` still counts it clean. Truncation is indistinguishable from completion | `structured-output.ts:52-80` |
| P4 | No `max_tokens`/`maxTokens` is set anywhere; `finish_reason` is never inspected | `agent-factory.ts:71-90` |
| P5 | `AssignmentSchema.storyId` is a single scalar documented as "Story **or** task ID"; there is no `taskIds`, `storyIds[]` or `acIndexes` | `assignment.schema.ts:5-18` |
| P6 | `RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS=true` strips every `.describe()` before the schema reaches the model — the TL never learns what `storyId` should contain | `config.ts:261`, `agent-factory.ts:100-103,165` |
| P7 | TL prompt: *"TARGET: no more than 8 feature branches… **merge closely-related stories onto one branch**"* — with a scalar `storyId`, "merge" means "discard" | `team-leader.prompt.ts:84-85` |
| P8 | TL sees only an AC **count** (`summariseStories` emits `(3 AC)`), so it cannot size work or notice dropped criteria | `context-builder.ts:137-143`, `nodes.ts:1027` |
| P9 | Nothing compares `assignments.length` to `userStories.length`; `teamLeaderNode` logs the count and returns | `nodes.ts:1042-1074` |
| P10 | `assignment.dependsOn` is never validated; one dangling id makes `topoSort` dump every assignment into a single parallel layer with **no warning** | `dispatcher.ts:44-54` |
| P11 | Task descriptions never reach any developer: `summariseTasks` drops `description`, and `developmentNode`'s context has **no Tasks section** | `context-builder.ts:162-167`, `nodes.ts:1115-1120` |
| P12 | `storiesForIds` returns `(no matching stories)` silently on a bad id | `context-builder.ts:148-157` |
| P13 | `epics`/`userStories`/`tasks` use the **append** reducer, so a HITL "enhance" re-run duplicates the whole set | `state.ts:92-121` |
| P14 | `Task.storyId` is `.optional()` and never validated; there is no `orphanedTasks` report | `task.schema.ts:7`, `traceability.ts:56-62` |
| P15 | `buildContext` clips array-shaped sections from the **tail**, deleting the last N stories/tasks, and returns an over-budget string with no final check | `context-builder.ts:270-289` |

---

## 2. Work item 1 — Detect and prevent truncated LLM output (P3, P4)

### 2a. Set an explicit output ceiling

`src/agents/_shared/agent-factory.ts`, in the `ChatOpenAI` construction:

```ts
const model = new ChatOpenAI({
    model: modelName,
    temperature: cfg.temperature ?? 0.3,
    maxTokens: cfg.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    timeout: cfg.timeout ?? LLM_REQUEST_TIMEOUT_MS,
    ...
});
```

New config: `LLM_MAX_OUTPUT_TOKENS` (default `16000`) and per-agent overrides
`PLANNING_MAX_OUTPUT_TOKENS` (default `32000`) used by architect/PM/DBA/TL, plus
`LLM_REQUEST_TIMEOUT_MS` (default `300000` — the current hardcoded 120 s is too small for a 32k-token
planning generation and, per `retry.ts:23-31,55`, a timeout is not retried and kills the run).

### 2b. Detect truncation

Add to `src/utils/structured-output.ts`:

```ts
export interface ParseResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
    /** True when the raw text was structurally incomplete and had to be repaired by jsonrepair. */
    wasTruncated?: boolean;
    /** Bytes of raw output, for diagnostics. */
    rawLength?: number;
}
```

- Set `wasTruncated: true` on **both** jsonrepair paths (`structured-output.ts:52-80`).
- Additionally detect it structurally: unbalanced braces/brackets in the raw text, or a trailing partial token.
- In `agent-factory.ts`, capture `response_metadata.finish_reason` (LangChain surfaces it on `AIMessage`;
  see `src/utils/token-usage-extractor.ts` for how metadata is already read) and thread a
  `finishReason` through to `invokeAgent`.

### 2c. Make truncation loud and non-fatal-but-blocking

`nodes.ts` `invokeAgent`:

```ts
if (parsed.wasTruncated || finishReason === 'length') {
    invokeLog.error(
        `Agent "${label}" output was TRUNCATED (finish_reason=${finishReason}, rawLength=${parsed.rawLength}). ` +
        `Entering continuation repair — a truncated planning output silently drops scope.`);
    // → continuation strategy, §3
}
```

Record it on state: `outputIntegrity: Array<{ agent: string; phase: PhaseName; issue: 'truncated' | 'repair-lossy' | 'schema-invalid'; detail: string }>`
(append reducer). Sub-Plan 03's `evaluateAcceptance` must mark `SCOPE` inconclusive when a planning agent's
output was truncated.

---

## 3. Work item 2 — Non-lossy repair: continuation instead of regeneration (P1, P2)

Replace the current "clip to 4,000 chars and ask for the same thing again" repair with two strategies.

### 3a. Continuation repair (for truncation)

When output was truncated mid-array:

1. Salvage every **complete** element already parsed (jsonrepair gives you the array; drop the last element if it
   is structurally incomplete).
2. Re-invoke with a continuation prompt that carries **only** the ids already produced, not the full bodies:

   ```
   Your previous response was cut off after producing N items. The following ids are already
   recorded and MUST NOT be repeated: ASSIGN-001 … ASSIGN-010.
   Continue the `assignments` array from item N+1. Return ONLY a JSON object of the form
   { "assignments": [ ...the remaining items... } — do not restate the earlier items.
   ```

3. Merge: `salvaged.concat(continuation)`, de-duplicated by `id`.
4. Loop up to `AGENT_OUTPUT_CONTINUATION_ATTEMPTS` (new config, default `3`), stopping when the required
   coverage is satisfied (see §5) or no new items appear.

### 3b. Field-level repair (for schema violations)

The pacman failure was **not** truncation — it was 7 invalid `taskType` values. Regenerating the whole list to fix
7 enum values is absurd. Implement:

```ts
/**
 * Repair schema violations in place, without re-asking for the whole payload.
 * Returns the repaired value plus the list of items that could not be repaired.
 */
export function repairFieldViolations<T>(
    raw: unknown,
    schema: z.ZodType<T>,
    opts?: { coerce?: boolean },
): { value: unknown; unrepairable: z.ZodIssue[]; repaired: Array<{ path: string; from: unknown; to: unknown }> };
```

Deterministic coercions to implement (each with a unit test):

- **Enum near-miss** → nearest allowed value by case-insensitive / whitespace-trimmed / hyphen-normalised match,
  else the enum's documented default. `taskType: "Feature"` → `"feature"`; `"task"`/`"story"`/`"story-task"` →
  `"feature"`; `"bugfix"` → `"fix"`.
- **Missing required string with a known default** → derive it (e.g. `taskType` defaults to `'feature'`,
  `priority` to `'medium'`, `complexity` to `'moderate'`).
- **Scalar supplied where array expected** → `[value]`.
- **Array supplied where scalar expected** → first element (log it).
- **String supplied where object expected** → attempt `JSON.parse`, else `{ name: value }` if the object has a
  single required string field. This exactly matches the DevOps failure
  (`retroboard3 run.log 16376`: `devops.k8sManifests.6: expected object, received string`).
- Numeric strings → numbers; `"true"`/`"false"` → booleans.

Only escalate to an LLM repair call for issues `repairFieldViolations` cannot fix, and when you do, send **only the
failing items** (by index) plus their errors, and ask for a patch object keyed by index:

```
Return ONLY: { "fixes": { "4": { "taskType": "feature" }, "25": { "taskType": "chore" } } }
```

Then apply the patch locally. This makes repair cost O(violations), not O(payload), and makes data loss impossible.

Also raise the repair invoke's `recursionLimit` from `6` to `PIPELINE_RECURSION_LIMIT` (P2), and raise
`AGENT_OUTPUT_REPAIR_ATTEMPTS` default from `1` to `2`.

**Hard invariant to add:** after any repair, if the repaired collection is **smaller** than what the raw output
contained, log `error`, record `outputIntegrity` `'repair-lossy'`, and treat it as a truncation for continuation
purposes. A repair must never shrink a collection. Add a unit test with exactly the pacman shape
(26 items in → 7 items out must be rejected).

---

## 4. Work item 3 — Assignment schema that can express full coverage (P5, P6)

`src/agents/_shared/schemas/assignment.schema.ts`:

```ts
export const AssignmentSchema = z.object({
    id: z.string(),
    /** Primary user story this assignment delivers. MUST be a US-* id from the plan. */
    storyId: z.string(),
    /** Additional stories delivered by this assignment (when work is legitimately batched). */
    additionalStoryIds: z.array(z.string()).default([]),
    /** Task ids from the Product Manager's plan that this assignment implements. MUST be non-empty. */
    taskIds: z.array(z.string()).min(1),
    /** Indices into the story's acceptanceCriteria that this assignment is responsible for. Empty = all. */
    acIndexes: z.array(z.number().int().nonnegative()).default([]),
    devAgentId: z.string(),
    // … existing fields unchanged …
});
```

Migration work (do all of it — a partial migration will break the run):

- `src/utils/traceability.ts` — index assignments by `storyId` **and** `additionalStoryIds`; populate
  `TraceRow.taskIds` from `assignment.taskIds` (today it is a phantom field filled from `Task.storyId`);
  add an `orphanedTasks` section (P14).
- `src/conductor/pr-workflow.ts:559` — `branchStoryIds` must include `additionalStoryIds`.
- `src/agents/developers/dispatcher.ts:75` — `canonicalBranchName` uses `a.storyId ?? a.id`; keep, but the branch
  key should be the primary story only (batching stays on one branch by design).
- `src/conductor/assignment-policy.ts` — no change expected; verify.
- `src/conductor/nodes.ts` `bugfixTriageNode` — bugfix assignments must carry `taskIds: ['BUGFIX-<bugId>']` and a
  real `storyId` when the bug traces to a story, otherwise the sentinel `'US-BUGFIX'`. Register that sentinel in
  the traceability orphan logic so bugfix assignments stop being reported as "invented work" (both runs reported
  exactly this).

**P6:** `RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS` must not strip descriptions for the planning agents — they carry
the semantics the model needs. Add `cfg.keepSchemaDescriptions?: boolean` to `buildAgent` and set it `true` for
architect, product-manager, dba and team-leader. Keep stripping for dev/reviewer agents (their schemas are small
and re-billed on every step).

---

## 5. Work item 4 — Coverage gate between planning phases (P9)

New file `src/conductor/plan-coverage.ts`:

```ts
export interface CoverageViolation {
    kind: 'story-without-task' | 'task-without-assignment' | 'story-without-assignment'
        | 'ac-without-assignment' | 'dangling-story-ref' | 'dangling-task-ref'
        | 'dangling-dependency' | 'epic-without-story' | 'duplicate-id';
    severity: 'critical' | 'major';
    id: string;
    detail: string;
}

/** Validate epics → stories → tasks. Called at the end of productManagerNode. */
export function validateStoryPlan(state: ProjectStateType): CoverageViolation[];

/** Validate stories/tasks → assignments. Called at the end of teamLeaderNode. */
export function validateAssignmentPlan(state: ProjectStateType): CoverageViolation[];
```

Rules — `critical` unless noted:

- Every `Epic.id` referenced by ≥1 `UserStory.epicId`; every `UserStory.epicId` exists (`major`).
- Every `UserStory.id` covered by ≥1 `Task.storyId`.
- Every `Task.id` appears in some `assignment.taskIds`.
- Every `UserStory.id` appears in some assignment's `storyId` or `additionalStoryIds`.
- Every acceptance criterion index of every story is covered by some assignment's `acIndexes`
  (an assignment with empty `acIndexes` covers all of its stories' criteria).
- Every `assignment.storyId` / `additionalStoryIds` / `taskIds` resolves to a real id.
- Every `assignment.dependsOn` entry resolves to a real assignment id (**P10**).
- No duplicate ids in any collection.

### Enforcement

In `productManagerNode` and `teamLeaderNode`, after `invokeAgent`:

1. Run the validator.
2. If violations exist and `PLAN_COVERAGE_MODE !== 'off'`, re-invoke the same agent **once per attempt** with a
   targeted gap prompt (up to `PLAN_COVERAGE_REPAIR_ATTEMPTS`, default `2`) that lists only the gaps:

   ```
   Your assignment plan is incomplete. These user stories have no assignment:
     US-002 (2 AC): "Each ghost follows its defined targeting logic during chase mode", …
     US-003 (3 AC): …
   These tasks are unassigned: TASK-007, TASK-011, …
   These dependsOn ids do not exist: ASSIGN-031.
   Return ONLY the ADDITIONAL assignments needed to close these gaps, as
   { "assignments": [ … ] }, continuing the id sequence from ASSIGN-<N+1>.
   Do not restate assignments you already produced.
   ```

3. Merge the additions. Re-validate.
4. If violations remain:
   - `PLAN_COVERAGE_MODE='enforce'` (default): record them on state as `planViolations` (append reducer), log every
     one at `error`, and let Sub-Plan 03's `SCOPE` acceptance criterion fail the run. Under
     `RUN_FAIL_POLICY='halt'` the run stops here instead of spending an hour building 2 of 20 stories.
   - `PLAN_COVERAGE_MODE='warn'`: log and continue.

Also emit `emitRunEvent('plan:coverage', { violations: n, stories: s, assigned: a })` so the dashboard shows it.

**Log the funnel explicitly** at the end of `teamLeaderNode` — this one line would have made both failures obvious:

```
[Team Leader] INFO Plan funnel: 10 epics → 20 stories (45 AC) → 26 tasks → 7 assignments
[Team Leader] ERROR Coverage: 2/20 stories assigned, 18 unassigned, 4/45 AC covered — 22 violation(s)
```

---

## 6. Work item 5 — Team Leader prompt rewrite (P7, P8)

`src/agents/team-leader/team-leader.prompt.ts`:

1. **Delete** lines 84-85 (`TARGET: no more than 8 feature branches… merge closely-related stories onto one
   branch`). Replace with batching that does not lose ids:

   ```
   - Create ONE feature branch per user story by default. If you must reduce branch count,
     BATCH stories onto one branch by putting the extra story ids in `additionalStoryIds` —
     never by omitting a story. Every story id in the plan MUST appear in exactly one
     assignment's `storyId` or `additionalStoryIds`.
   - Soft target: <= 10 feature branches. Exceeding it is acceptable; DROPPING A STORY IS NOT.
   ```

2. Add a mandatory self-check to `<workflow>`:

   ```
   7. VERIFY COVERAGE before you output:
      a. Count the user stories you were given: N.
      b. Confirm every one of the N story ids appears in `storyId` or `additionalStoryIds`.
      c. Confirm every task id you were given appears in some assignment's `taskIds`.
      d. Confirm every `dependsOn` id is an assignment id you actually created.
      e. State the counts in the `coverageNote` field: "20 stories, 26 tasks, 22 assignments, 0 unassigned".
   ```

   Add `coverageNote: z.string()` to `TeamLeaderOutputSchema` and log it. Forcing the model to state the
   arithmetic materially improves coverage and gives a cheap cross-check against the deterministic validator.

3. Add explicit `<output_rules>` about `taskIds`/`acIndexes` now that the schema has them.

4. Correct the `<integration_check>` block: it currently asks for one integration assignment; make it
   *"one integration assignment per stack root, depending on all component assignments for that root"*, and require
   it to reference the entry-point files named in the architecture contract (Sub-Plan 05).

### Give the TL the acceptance criteria (P8)

`nodes.ts:1027` passes `summariseStories(state.userStories)` which emits `(3 AC)`. Change the TL context to a new
`storiesWithCriteria(stories, opts)` in `context-builder.ts` that emits, at `priority: 1`:

```
- US-003: As a player, I want collision detection …
    AC0: Pac-Man stops upon colliding with a wall tile
    AC1: Eating a dot removes it and increments score
    AC2: Collision with a non-scared ghost reduces a life
```

For 20 stories × ~2.3 AC this is roughly 4–6 KB — affordable, and it is the input the TL needs to size and cover
the work. Raise `CONTEXT_MAX_CHARS` for the TL specifically via a new `TEAM_LEADER_CONTEXT_MAX_CHARS`
(default `48000`) rather than raising it globally.

---

## 7. Work item 6 — Deliver task detail to developers (P11, P12)

1. `context-builder.ts` — add `tasksForIds(tasks: Task[], ids: string[]): string` that includes the **full
   description** (clipped to `CONTEXT_MAX_DESC_CHARS × 4`, i.e. ~800 chars, not 200):

   ```
   - TASK-014 [frontend/react] Implement the ghost AI state machine
       Build ChaseMode/ScatterMode/FrightenedMode with per-ghost targeting …
   ```

2. `pr-workflow.ts:558-574` — insert a `## Tasks for This Branch` section built from
   `tasksForIds(tasks, devAssignments.flatMap(a => a.taskIds))`. Thread `tasks` into `executePRWorkflow`'s
   options and through `dispatchDevelopers` (`dispatcher.ts:160-172`) and `developmentNode` (`nodes.ts`).
3. **P12:** when `storiesForIds` finds no match for a requested id, it must return the marker **and** the caller
   must log `error` and record `outputIntegrity`. Change the signature to
   `storiesForIds(stories, ids): { text: string; missing: string[] }` (or add a sibling
   `findMissingStoryIds`) and in `pr-workflow.ts` do:

   ```ts
   if (missing.length) {
       log.error(`Assignment(s) on branch ${branchName} reference unknown story id(s): ${missing.join(', ')} — ` +
                 `the developer will have NO acceptance criteria. This is a planning defect.`);
   }
   ```

   Sub-Plan 03's acceptance gate must see this via `outputIntegrity`.

---

## 8. Work item 7 — Reducer and clipping fixes (P13, P15)

**P13:** change `epics`, `userStories`, `tasks` and `techStack` from the append reducer to a
**merge-by-id-replace** reducer:

```ts
/** Replace elements with the same `id`, append new ones. Prevents HITL re-runs from duplicating a plan. */
function mergeByIdReducer<T extends { id: string }>(existing: T[], incoming: T[]): T[] { … }
```

For `techStack` (no `id`) key on `layer + technology` or add an `id`. Add a unit test: running
`productManagerNode`'s update twice yields one copy, not two. Also add a `dedupeById` pass in `finalizeNode`'s
summary computation so historical states remain readable.

**P15:** `buildContext` must (a) clip **line-wise** and never mid-line for list-shaped sections, (b) clip from the
middle with an explicit `… [N items omitted] …` marker rather than dropping the tail silently, (c) log `warn` when
it clips and `error` when the result still exceeds the budget, and (d) never silently return an over-budget
string — instead force-clip the lowest-priority sections until it fits and log what was lost.

---

## 9. Config additions

```ts
/** Hard output-token ceiling for all agents. */
export const LLM_MAX_OUTPUT_TOKENS = parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? '16000', 10);
/** Output-token ceiling for planning agents (architect, PM, DBA, team-leader). */
export const PLANNING_MAX_OUTPUT_TOKENS = parseInt(process.env.PLANNING_MAX_OUTPUT_TOKENS ?? '32000', 10);
/** Per-request LLM timeout (ms). Raised from the hardcoded 120000 — long planning generations were being killed. */
export const LLM_REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS ?? '300000', 10);
/** Continuation attempts when an agent's JSON output is truncated. */
export const AGENT_OUTPUT_CONTINUATION_ATTEMPTS = parseInt(process.env.AGENT_OUTPUT_CONTINUATION_ATTEMPTS ?? '3', 10);
/** Plan coverage enforcement: 'off' | 'warn' | 'enforce'. */
export const PLAN_COVERAGE_MODE = (process.env.PLAN_COVERAGE_MODE ?? 'enforce') as 'off' | 'warn' | 'enforce';
/** Gap-repair attempts when the plan does not cover every story/task. */
export const PLAN_COVERAGE_REPAIR_ATTEMPTS = parseInt(process.env.PLAN_COVERAGE_REPAIR_ATTEMPTS ?? '2', 10);
/** Context char budget for the Team Leader (it now receives full acceptance criteria). */
export const TEAM_LEADER_CONTEXT_MAX_CHARS = parseInt(process.env.TEAM_LEADER_CONTEXT_MAX_CHARS ?? '48000', 10);
```

Also change `AGENT_OUTPUT_REPAIR_ATTEMPTS` default `1` → `2`.

---

## 10. Tests

`tests/structured-output-repair.test.ts`:

- The exact pacman case: a `{assignments: [...26 items]}` payload where 7 items have `taskType: "task"`.
  `repairFieldViolations` must coerce all 7 and return **26** items. Assert `value.assignments.length === 26`.
- A collection that shrinks during repair is rejected with `'repair-lossy'`.
- Truncated JSON (cut mid-object at item 10 of 26) ⇒ `wasTruncated: true`, salvage 9 complete items, continuation
  prompt lists exactly `ASSIGN-001…ASSIGN-009`.
- The DevOps case: `k8sManifests: ["apiVersion: v1\n…", {…}]` ⇒ string coerced to an object.

`tests/plan-coverage.test.ts`:

- pacman fixture (20 stories / 26 tasks / 7 assignments) ⇒ 18 `story-without-assignment`, N
  `task-without-assignment`, `SCOPE`-failing.
- retroboard fixture (5 assignments with unknown `storyId`) ⇒ 5 `dangling-story-ref`.
- A dangling `dependsOn` ⇒ `dangling-dependency`, and a companion `dispatcher` test asserting `topoSort` now
  **logs a warning** and treats the dangling dep as pre-satisfied rather than collapsing all layers.
- A complete plan ⇒ zero violations.

`tests/context-builder.test.ts` (extend):

- `storiesWithCriteria` renders every AC.
- `tasksForIds` includes descriptions.
- `storiesForIds` reports `missing` for unknown ids.
- Clipping omits from the middle with a marker and never returns an over-budget string.

`tests/state-reducers.test.ts`:

- Applying a PM update twice yields one copy of each story (P13).

---

## 11. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -rn "slice(0, 4000)" src/utils/structured-output.ts` returns nothing (the lossy clip is gone).
- [ ] `grep -rn "recursionLimit: 6" src/` returns nothing.
- [ ] `grep -rn "merge closely-related stories" src/` returns nothing.
- [ ] `AssignmentSchema` has `taskIds` and `additionalStoryIds`, and every consumer compiles.
- [ ] Running `validateAssignmentPlan` against `tests/fixtures/states/pacman8-state.json` (created in Sub-Plan 03,
      or create it here if 03 has not run) reports ≥18 critical violations.
- [ ] `README.md` + `.env.example` + `AI_Context.md` updated: new `plan-coverage.ts` subsystem, the schema change
      (which "cascades" per `AI_Context.md` rule 5 — list every touched consumer in the commit message).

## 12. Out of scope

- The repo-layout / module contract that stops agents building two incompatible projects → Sub-Plan 05.
- Making the AC coverage metric meaningful → Sub-Plan 10.
- Architect JSON-mode fix (`agent-factory.ts:69` excludes tool-using agents) — note it in the commit message;
  Sub-Plan 05 addresses the Architect's output shape and can fix it there.
