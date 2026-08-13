# Sub-Plan 07 — Review & Merge: Fail Closed

**Depends on:** Sub-Plan 01 (`GateReport`/`ProductVerifyReport`), Sub-Plan 02 (`TamperFinding`),
Sub-Plan 06 (`classifyPrFailure`, durable commits). Consumes Sub-Plan 05's contract if present.
**Goal:** make review outcomes mean something. Today every reviewer failure mode resolves to *approved*, and the
terminal merge decision ignores reviewers entirely.

---

## 1. Evidence

### 1a. The reviewers were right and were overruled

`retroboard3 run.log 8901-8907`, nine seconds after PR #10 (the gate-gaming PR) opened:

```
8901  [Principal FE] [REVIEW] INFO Decision: changes_requested (6 comments)
8902    packages/backend/src/columns.ts:1 — [MAJOR] The file defines only in-memory column helpers but does not
        expose an Express router or implement the required PATCH /api/columns/:id endpoint.
8903    packages/backend/src/index.ts:1 — [MAJOR] The backend server never imports or mounts the columns router,
        so even if the router existed the endpoint would not be reachable.
8904    __tests__/math.test.js:1 — [MAJOR] The only test added verifies a trivial math utility and does not cover
        the new column rename API.
8905    jest.config.cjs:4 — [MAJOR] `testEnvironment` is defined twice (first as 'node', then as 'jsdom').
8906    index.html:9 — [MAJOR] The script tag references `/src/main.tsx`, but no such file exists in the repository.
8907    packages/frontend/vite.config.ts:4 — [MINOR] `root: resolve(__dirname, 'packages/frontend')` points Vite
        to a non-existent directory because this config file lives at the repository root.
```

Every defect in the shipped product, identified correctly, on the day. Then:

```
9424  INFO Review iteration 3/5
9427  WARN Max review iterations reached. Merging PR #10 despite pending reviews.
9433  INFO PR #10 merged to project/retroboard3
```

Note `iteration 3/5` immediately followed by "max iterations reached" — the accounting is also wrong.

### 1b. Merge-despite-review is the dominant path

`retroboard3`: **10 of 14 PRs merged; 9 of those via `despite pending reviews` or `proceeding with merge despite
CRITICALs`.** The other 4 (#3, #5, #8, #11) were abandoned `open` on merge conflicts. Only #13 and #14 reached
"consensus", both degenerately (§1c, §1d).

`pacman8`: PRs #1, #3, #4, #5 all merged under `Max review iterations reached`. For #5 the log literally
contradicts itself:

```
4614  WARN Escalated reviewer also requested changes for PR #5 — leaving open for human intervention
4615  WARN Max review iterations reached. Merging PR #5 despite pending reviews.
4618  INFO PR #5 merged to project/pacman8
```

And in every case the quality gate was red at merge time:

```
pacman8 3210  Quality gates: stacks=node steps=install,build,lint,test
pacman8 3211  Quality gates FAILED: 3 executed, 3 failed
pacman8 3635  WARN Max review iterations reached. Merging PR #3 despite pending reviews.
pacman8 3638  INFO PR #3 merged to project/pacman8
```

### 1c. Reviewer infrastructure failures count as approvals

```
retroboard3  2322  WARN Reviewer principal-frontend-reviewer output schema issues (defaulting to approved):
retroboard3  2324  [Principal FE] [REVIEW] INFO Decision: approved (0 comments)
retroboard3  6510  WARN Reviewer principal-frontend-reviewer hit the recursion limit — abstaining (treated as approved).
retroboard3 12667  WARN Reviewer principal-backend-reviewer output schema issues (defaulting to approved):
retroboard3 12671  INFO All reviewers approved!
pacman8      4073  WARN Reviewer principal-backend-reviewer hit the recursion limit — abstaining (treated as approved).
```

PR #13 — the bug-fix PR *for the gate failure itself* — was merged on the strength of a Zod parse error.

Fail-open sites in `src/conductor/pr-workflow.ts`: `:370-375` (recursion limit → `{ status: 'approved' }`),
`:385-386` (no messages), `:391-392` (empty content), `:403-406` (schema-invalid), `:961-964` (undefined status),
`:859-863` (empty diff → `prStatus = 'approved'; break;`).

### 1d. Minor-only findings become approvals, and stubs pass

`src/conductor/review-policy.ts:17-28`:

```ts
const BLOCKING_SEVERITIES = new Set(['critical', 'major']);
export function isBlockingReview(comments: { severity?: string }[]): boolean {
    return comments.some(c => BLOCKING_SEVERITIES.has(String(c.severity ?? 'info').toLowerCase()));
}
```

A missing/empty severity is non-blocking. Applied at `:967-970`, which rewrites `changes_requested` to
`approved`. `Only non-blocking comments (minor/suggestion) — recording as approved-with-comments` fires at
`retroboard3 3772, 7913, 9143`.

The reviewer persona actively pushes severity **down** (`src/agents/_shared/persona.ts:255-263`):
*"Only critical and major block a merge — do not inflate severity… If your only findings are minor/suggestion, set
status to 'approved' and list them as comments."* Nothing anywhere defines "this is a stub, not an
implementation" as blocking.

The consequence, `retroboard3` PR #14 (`state.json:5592`) — assignment ASSIGN-033 was
*"Implement client-side reconnection logic with exponential backoff and state replay using buffered events"*:

> ## Changes Made
> - **modified** `src/setupTests.ts` — Wrapped import of '@testing-library/jest-dom' in try/catch to prevent
>   module-not-found error when dependency is absent, allowing tests to run.

Zero reconnection logic. One try/catch that suppresses a test failure. `run.log 13354`: `Decision: approved
(2 comments)`; `13363`: `Decision: approved (1 comments)`; `13365`: `All reviewers approved!`; `13368`: merged.
**This was the final merge of the run.**

Seven of the 14 PR descriptions contain the placeholder `_(changes will be listed after development)_` — half the
PRs recorded no file changes at all, including PR #12 which carried the two most important assignments in the
project (ASSIGN-049 `src/server.ts` mounting all routes, ASSIGN-050 `src/App.tsx` composing the whole UI, both
`critical/very-complex`) and merged under `proceeding with merge despite CRITICALs`.

### 1e. Escalation has never worked

```
retroboard3  2744  WARN PR #3 has unresolved CRITICALs after 5 iterations. Escalating developer...
retroboard3  2745  WARN No escalation candidate found — proceeding with merge despite CRITICALs
retroboard3  4216/4217  (same for PR #4)
retroboard3 10605/10606 (same for PR #12)
pacman8      2162/2163  (same for PR #2)
```

`No escalation candidate found` fires 4/4 times across both runs. The escalation path has **zero** successful
executions.

---

## 2. Work item 1 — Reviewer failures abstain, they do not approve

`src/conductor/pr-workflow.ts`, all six sites.

Introduce an explicit outcome type instead of coercing everything into `ReviewOutput`:

```ts
// ─── Review outcomes ────────────────────────────────────────────────────────

export type ReviewOutcome =
    | { kind: 'approved';           reviewerId: string; output: ReviewOutput }
    | { kind: 'changes_requested';  reviewerId: string; output: ReviewOutput }
    | { kind: 'abstained';          reviewerId: string; reason: 'recursion-limit' | 'empty-output'
                                                             | 'schema-invalid' | 'error'; detail: string };
```

An `abstained` outcome is **neither** an approval nor a rejection. It never counts toward the approval quorum.

### Quorum rule

`REVIEW_QUORUM` (config, default `1`): the number of *genuine* approvals required to merge.

- `approvals >= REVIEW_QUORUM` and no blocking findings ⇒ mergeable.
- All reviewers abstained ⇒ **retry** the review with a fresh agent (up to `REVIEW_ABSTAIN_RETRIES`, default `1`);
  if still all abstained, the PR is `inconclusive` — not mergeable under `REVIEW_MERGE_POLICY='strict'`.
- Empty diff (`:859-863`) ⇒ `changes_requested` with a synthetic `critical` comment
  *"No changes were produced for this assignment"* — never `approved`. This is the correct handling of the
  seven `_(changes will be listed after development)_` PRs.

Also fix the abstention causes rather than only the accounting: reviewer `recursionLimit` is `26` with
`REVIEWER_MAX_TOOL_CALLS = 8`, and the diff is supposed to be inline. Log the diff size at review time; if
reviewers routinely abstain on recursion limits, the diff is being truncated and they are groping with tools —
Sub-Plan 08 raises the budgets, and §6 here reduces the need.

---

## 3. Work item 2 — Merge policy driven by evidence, not by a timer

Replace `pr-workflow.ts:1381-1385`.

```ts
// ─── Merge decision ─────────────────────────────────────────────────────────
// Pre-Plan-19 this merged whenever prStatus was 'approved' OR 'open', logging
// "Max review iterations reached. Merging … despite pending reviews." That single line
// is responsible for shipping every defect the reviewers correctly identified.
```

New `MergeDecision`:

```ts
export interface MergeDecision {
    merge: boolean;
    reason: string;
    /** Hard blockers that must be resolved by a human or a later iteration. */
    blockers: string[];
}

export function decideMerge(input: {
    approvals: number;
    blockingComments: ReviewComment[];   // critical + major from non-abstaining reviewers
    abstentions: number;
    gateReport: GateReport | null;
    productVerify: ProductVerifyReport | null;
    integrityFindings: TamperFinding[];
    layoutViolations: LayoutViolation[]; // empty when Sub-Plan 05 is absent
    filesChanged: number;
    iterationsUsed: number;
    policy: 'strict' | 'permissive' | 'legacy';
}): MergeDecision;
```

Hard blockers under `strict` (the new default) — **no timer overrides any of these**:

1. `gateReport` is not `passed` (or is `inconclusive`).
2. `productVerify` has a failing `ArtifactCheck` or any `resolveIssue`.
3. Any `critical` `TamperFinding`.
4. Any `critical` `LayoutViolation`.
5. Any unresolved `critical` review comment.
6. `filesChanged === 0`.
7. `approvals < REVIEW_QUORUM`.

Unresolved **major** comments after `MAX_REVIEW_ITERATIONS`: allowed to merge under `strict` **only** if 1–6 are
clean and the majors are recorded on the PR and converted into `Bug`s (id `REVIEW-<prNumber>-<n>`, severity
`major`) so the bugfix loop picks them up. Blocking on majors forever would deadlock on subjective comments; not
recording them is how `retroboard3` lost them.

`permissive` = current behaviour minus the tamper/gate blockers (1–4 still hard). `legacy` = today's behaviour
exactly, for A/B comparison. Config: `REVIEW_MERGE_POLICY`, default `strict`.

When `merge === false`:

- Leave the PR open with a clear title prefix `[BLOCKED]` and a PR comment listing the blockers.
- Do **not** delete the branch; export a salvage patch (Sub-Plan 06 §3).
- Return the `PullRequest` with `status: 'blocked'` (extend the status union in
  `src/agents/_shared/schemas/pr.schema.ts`; grep every consumer of `pr.status`, including
  `assignment-policy.ts:42-50`, `traceability.ts:173` and the dashboard).
- Emit `emitRunEvent('pr:blocked', { prNumber, blockers })`.
- Synthesise a `critical` Bug `PR-BLOCKED-<branch>` so the bugfix loop retries the branch with the blockers as
  context — this is what turns a blocked PR into progress instead of a dead end.
- Assignments on a blocked PR stay `pending` (Sub-Plan 06 §6 already requires `merged === true`).

**`traceability.ts:173`** currently treats `status === 'approved'` as merged (`hasMerged`). Fix it to require
`'merged'` only — an approved-but-unmerged PR delivered nothing.

---

## 4. Work item 3 — Make escalation actually work

Find the escalation candidate selection (search for `No escalation candidate found`, `pr-workflow.ts:~1340-1376`)
and rewrite it:

1. Build the candidate list from `src/agents/developers/registry.ts` by rank: for a `junior` author →
   all `senior` then all `principal`; for a `senior` → all `principal`; for a `principal` → the *other*
   principal(s), and if none, the same principal with an escalation prompt that includes the full reviewer
   findings and a `MUST FIX` framing.
2. Filter by domain relevance (`frontend`/`backend`/`fullstack`) but **never** return empty because of the
   domain filter — fall back to any higher-or-equal rank agent.
3. If the author is the only principal in its domain, escalate to the principal of the *other* domain rather than
   giving up. A principal-backend reviewing a stuck frontend PR is far better than merging it.
4. Log the selection: `Escalating PR #12 from senior-backend → principal-backend (2 unresolved CRITICALs)`.
5. Add a unit test asserting a non-empty candidate for **every** `(rank, domain)` pair in the registry. This is a
   4-line test that would have caught a 0/4 failure rate.

Also raise the escalated agent's budget: escalation exists to break a deadlock, so give it
`ESCALATION_TOOL_CALL_BONUS` (config, default `+10`) tool calls and a fresh context with the full reviewer
findings (not the compacted history).

---

## 5. Work item 4 — Reviewers must be able to block stubs

`src/agents/_shared/persona.ts`, `buildReviewerPersona`.

1. Replace the severity-deflation guidance with a rubric that names the failure modes actually observed:

   ```
   <severity_rubric>
       critical — breaks the build, breaks or disables a test, a security hole, OR any of:
         * `scripts` in a package.json changed; a build/test command replaced with a no-op
           (`echo`, `exit 0`, `|| true`, `--passWithNoTests`)
         * a test deleted, renamed away, skipped (`it.skip`, `xit`), or added for a subject that
           nothing in the application imports
         * tsconfig/eslint strictness relaxed, or a source path added to an ignore file
         * an import or asset reference to a file that does not exist in the repository
         * the PR's diff contains no production code for a feature assignment
       major — the assignment's acceptance criteria are not implemented. This INCLUDES:
         * a component that renders only its own name or a placeholder
         * a function that returns a hardcoded constant instead of computing
         * a router/handler/module that is never imported or mounted by an entry point
         * a file created but not wired into the running application
         "It compiles" is NOT "it is implemented".
       minor / suggestion — naming, formatting, comments, non-behavioural refactors.

       Do NOT downgrade a finding to `minor` because you are unsure. If the acceptance criteria are
       not demonstrably met by the diff, that is `major`.
   </severity_rubric>
   ```

2. Replace the *"If your only findings are minor/suggestion, set status to 'approved'"* instruction with:

   ```
   - Approve ONLY when the diff implements the assignment's acceptance criteria and you can name,
     for each criterion, the code that satisfies it.
   ```

3. Add a required output field to `ReviewOutput` (`src/agents/developers/schemas/review-output.schema.ts`):

   ```ts
   /** Per-acceptance-criterion verdict. The reviewer must account for every criterion in the assignment. */
   criteriaVerdicts: z.array(z.object({
       storyId: z.string(),
       acIndex: z.number().int(),
       met: z.boolean(),
       evidence: z.string(),   // file:line or 'not implemented'
   })).default([]),
   ```

   Then enforce mechanically: if any `criteriaVerdicts[].met === false` and the reviewer's status is `approved`,
   downgrade to `changes_requested` and log the inconsistency. And if `criteriaVerdicts` is empty while the
   assignment has acceptance criteria, treat the review as `abstained` (reason `'empty-output'`) rather than
   as an approval. This makes "approve without reading the requirements" structurally impossible.

4. Give the reviewer the acceptance criteria in the prompt — it needs them for §5.3. Reuse
   `storiesWithCriteria` from Sub-Plan 04 (or `storiesForIds`), scoped to the branch's stories.

---

## 6. Work item 5 — Deterministic pre-review, so reviewers spend budget on judgement

Before invoking any reviewer, attach a **deterministic findings block** to the review prompt, produced from data
that now exists:

```
## Automated findings (already verified — do not re-derive, but DO judge them)
- QUALITY GATE: build FAILED — `npm run build`: Could not resolve "./index.css" from "src/main.tsx"
- UNRESOLVED REFERENCES (1): src/main.tsx:4 → './index.css' (missing-file)
- GATE INTEGRITY: package.json `scripts.build` changed "vite build" → "echo Build successful" (critical)
- TRIVIAL TEST: __tests__/math.test.js — subject `src/utils/math.js` is imported by nothing (critical)
- LAYOUT: index.html references /src/main.tsx which is outside the declared source dirs (critical)
- DIFF: 3 files, 41 insertions, 0 test files changed
```

Two benefits: reviewers stop burning their 8-call budget rediscovering mechanical facts (which is why they hit
recursion limits and abstained), and the *human* reading the PR sees the blockers immediately. Add these as
non-negotiable `critical` comments regardless of what the reviewer says — attribute them to a synthetic reviewer id
`automated-verification` so `decideMerge` counts them without an LLM in the loop.

Also fix the review-iteration accounting bug visible at `retroboard3 run.log 9424` vs `9427`
(`Review iteration 3/5` then `Max review iterations reached`): find the loop counter and the
`MAX_REVIEW_ITERATIONS` comparison and reconcile them; log
`Review iteration N/M` and `Review budget exhausted after N iterations` consistently.

---

## 7. Config additions

```ts
/** Merge policy: 'strict' (evidence required) | 'permissive' | 'legacy' (pre-Plan-19). */
export const REVIEW_MERGE_POLICY = (process.env.REVIEW_MERGE_POLICY ?? 'strict') as 'strict' | 'permissive' | 'legacy';
/** Genuine approvals required to merge (abstentions do not count). */
export const REVIEW_QUORUM = parseInt(process.env.REVIEW_QUORUM ?? '1', 10);
/** Retries when every reviewer abstained (schema error / recursion limit / empty output). */
export const REVIEW_ABSTAIN_RETRIES = parseInt(process.env.REVIEW_ABSTAIN_RETRIES ?? '1', 10);
/** Extra tool calls granted to an escalated developer. */
export const ESCALATION_TOOL_CALL_BONUS = parseInt(process.env.ESCALATION_TOOL_CALL_BONUS ?? '10', 10);
/** Convert unresolved major review comments into Bugs for the bugfix loop. */
export const REVIEW_MAJORS_TO_BUGS = (process.env.REVIEW_MAJORS_TO_BUGS ?? 'true') === 'true';
```

---

## 8. Tests

`tests/review-policy.test.ts` (extend the existing file):

- `isBlockingReview` with `severity: undefined` ⇒ **blocking** (invert today's default: unknown severity must be
  treated as `major`, not `info`).
- An abstention does not count toward quorum.
- All-abstain ⇒ `inconclusive`, retried once, then not mergeable under `strict`.

`tests/merge-decision.test.ts` — one case per blocker, plus the two real scenarios:

- **retroboard PR #10 fixture**: gate "passed" but `ArtifactCheck` failed, 1 resolve issue, 3 critical tamper
  findings, 6 major review comments ⇒ `merge: false`, blockers list all four classes.
- **retroboard PR #14 fixture**: 1 file changed (`src/setupTests.ts`), 0 production code, 2 approvals ⇒
  `merge: false` (blocker: no production code for a feature assignment; `criteriaVerdicts` unmet).
- **pacman PR #3 fixture**: `Quality gates FAILED: 3 executed, 3 failed`, 2 approvals ⇒ `merge: false`.
- A clean PR with 1 approval, green gate, no findings ⇒ `merge: true`.
- `policy: 'legacy'` reproduces a merge for the retroboard PR #10 fixture (proves the escape hatch).

`tests/escalation.test.ts`:

- For every `(rank, domain)` pair in `src/agents/developers/registry.ts`, `selectEscalationCandidate` returns a
  non-empty candidate that is not the author.
- `principal-frontend` with no other frontend principal ⇒ falls back to `principal-backend`, never empty.

`tests/reviewer-output.test.ts`:

- `status: 'approved'` with a `criteriaVerdicts` entry `met: false` ⇒ downgraded to `changes_requested`.
- Empty `criteriaVerdicts` on an assignment with criteria ⇒ treated as `abstained`.

---

## 9. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -rn "treated as approved" src/` returns nothing.
- [ ] `grep -rn "defaulting to approved" src/` returns nothing.
- [ ] `grep -rn "despite pending reviews" src/` returns nothing (or only inside the `legacy` branch, clearly labelled).
- [ ] `grep -rn "No escalation candidate found" src/` returns nothing.
- [ ] `pr.status` union includes `'blocked'` and every consumer handles it (`assignment-policy.ts`,
      `traceability.ts`, `dashboard/`, the manifest writer).
- [ ] `README.md` "Review Rules" section rewritten to document the quorum, the severity rubric, the hard blockers
      and the three policies; `AI_Context.md` PR-workflow steps 7–10 updated.

## 10. Out of scope

- Fixing *why* reviewers hit recursion limits (budget/context) → Sub-Plan 08.
- QA-side test verification → Sub-Plan 09.
- Do not remove `MAX_REVIEW_ITERATIONS`; it still bounds cost. It just no longer authorises a merge.
