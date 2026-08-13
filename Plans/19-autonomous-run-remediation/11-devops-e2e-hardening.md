# Sub-Plan 11 — DevOps & E2E Hardening

**Depends on:** Sub-Plan 01 (`runSmokeTest`, `StackRoot`), Sub-Plan 03 (acceptance gate, `verificationErrors`),
Sub-Plan 05 (contract's `entryPoints`/`buildOutputDir`) — degrades gracefully without 05.
**Goal:** stop accepting the DevOps agent's word for whether the product deploys, and stop treating "E2E never ran"
as "E2E passed".

---

## 1. Evidence

### 1a. `pacman8` — the DevOps agent crashed and silently took E2E with it

```
5858  [InvokeAgent] WARN Agent "devops" returned unparseable JSON — entering repair loop. Could not extract JSON.
5866  [InvokeAgent] WARN Repair attempt 1 for "devops" threw: Recursion limit of 6 reached ...
5870  [InvokeAgent] ERROR Agent "devops" output invalid after 1 repair attempt(s).
5871  [DevOps] ERROR DevOps agent failed: ...
5876      at RunnableCallable.devopsNode (/home/sio/Code/AgenticDevTeam/src/conductor/nodes.ts:1513:19)
5883  [DevOpsVerify] INFO No Docker artifacts found — skipping deployment verification
5888  [QA E2E] INFO Starting E2E testing phase...
5889  [QA E2E] INFO Skipping E2E tests — no service URLs from DevOps — deployment did not produce running services
```

The repair loop's `recursionLimit: 6` was consumed by the agent's first tool call. No `playwright`, `navigate` or
`service URL` string appears anywhere else in the log. The final run status was `completed`.

### 1b. `retroboard3` — E2E threw and the next line was "Finalizing"

```
16375  [structured-output] WARN parseAgentJson: recovered via jsonrepair (input was malformed/truncated)
16376  [InvokeAgent] WARN Agent "devops" output failed schema validation:
       - devops.k8sManifests.6: Invalid input: expected object, received string
       - devops.k8sManifests.7: Invalid input: expected object, received string
       - devops.k8sManifests.8: Invalid input: expected object, received array
       ... and 6 more issue(s)
16393  [InvokeAgent] INFO Agent "devops" repaired on attempt 1
16394  [DevOps] INFO Build: pending, Run: pending
16395  [DevOpsVerify] INFO No Docker artifacts found — skipping deployment verification
16400  [QA E2E] INFO Starting E2E testing phase...
16401  [QA E2E] INFO Running E2E tests against 2 service(s)...
16402  [PlaywrightMCP] INFO Connecting to Playwright MCP: npx @playwright/mcp@latest --headless
16405  [QA E2E] ERROR E2E testing failed: Failed to connect to stdio server "playwright": McpError: MCP error -32000: Connection closed
16413      at RunnableCallable.e2eNode (/home/sio/Code/AgenticDevTeam/src/conductor/nodes.ts:1612:26)
16417  [Finalize] INFO Finalizing run...
```

Note line 16401: *"Running E2E tests against **2 service(s)**"* while line 16395 says verification was **skipped**.
Those two service URLs were **hallucinated by the LLM** and survived into state because `verifyDeployment` returned
`skipped` — see D2 below. A hard MCP failure then produced no report, no bug, no status change.

### 1c. Root causes in code

| ID | Defect | Location |
|---|---|---|
| D1 | Repair invoke uses a hardcoded `recursionLimit: 6`, and `AGENT_OUTPUT_REPAIR_ATTEMPTS = 1` | `nodes.ts:403-415`, `config.ts:241` |
| D2 | When `verifyDeployment` returns `buildStatus: 'skipped'`, the `if (verified.buildStatus !== 'skipped')` guard is false and **the agent's unverified `buildStatus`, `runStatus` and `serviceUrls` remain in state** | `nodes.ts:1527-1537`, `devops-verify.ts:151-165` |
| D3 | `verifyCompose` returns `buildStatus: 'success'` whenever `docker compose up -d --build` exits 0, regardless of container health; `runStatus: 'running'` if ≥1 published port parsed | `devops-verify.ts:278-285` |
| D4 | `verifyDockerfile` computes `healthChecks` and then returns `runStatus: 'running'` without consulting them | `devops-verify.ts:347-360` |
| D5 | `devopsNode` never inspects `verified.buildStatus === 'failed'` or unhealthy `healthChecks`; `graph.ts:206-210` routes `devops → e2e` unconditionally | `nodes.ts:1527-1577` |
| D6 | E2E skips whenever `serviceUrls` is empty and **records nothing** — no `testReports` entry, no bug, no flag. "Passed" and "never ran" are indistinguishable | `nodes.ts:1591-1603` |
| D7 | `E2E_BUGFIX_ENABLED` defaults to `false`, so `afterE2eRouter` always returns `finalize`; and the predicate scans **all** `testReports`, not just `type === 'e2e'` | `config.ts:213`, `graph.ts:74-83` |
| D8 | E2E `catch` returns normally with no report and no bug | `nodes.ts:1642-1653` |
| D9 | The E2E report is 100 % LLM self-report; no MCP transcript cross-check, no screenshot verification | `nodes.ts:1620` |
| D10 | `getPlaywrightMcpTools()` has no preflight: no browser-install check, no tool-count assertion, no retry | `playwright-mcp.ts:18-38` |
| D11 | The DevOps agent crashing kills the phase entirely; there is no deterministic fallback to generate a Dockerfile | `nodes.ts:1513` |

---

## 2. Work item 1 — Never keep unverified deployment claims (D2, D3, D4, D5)

`src/conductor/devops-verify.ts` and `nodes.ts` `devopsNode`.

1. **Always overwrite the agent's claims.** Replace the `if (verified.buildStatus !== 'skipped')` guard:

   ```ts
   // The agent's self-reported deployment status is NEVER authoritative. When verification is
   // skipped we overwrite the claims with 'skipped' / [] rather than leaving them in place —
   // retroboard3 ran E2E against two hallucinated service URLs because of the old guard.
   output.devops = {
       ...output.devops,
       buildStatus: verified.buildStatus,
       runStatus: verified.runStatus,
       serviceUrls: verified.serviceUrls ?? [],
       healthChecks: verified.healthChecks ?? [],
       verificationMode: verified.mode,       // 'compose' | 'dockerfile' | 'none' | 'docker-unavailable'
   };
   if (claimedUrls.length && (verified.serviceUrls ?? []).length === 0) {
       opsLog.error(`DevOps agent claimed ${claimedUrls.length} service URL(s) but verification produced none — discarding the claims.`);
       verificationErrors.push({ stage: 'devops', message: 'unverified serviceUrls discarded' });
   }
   ```

   Extend `DevOpsPlanSchema` with `verificationMode` and make `buildStatus`/`runStatus` unions include `'skipped'`
   and `'unverified'` explicitly (check the current schema in
   `src/agents/_shared/schemas/devops-plan.schema.ts` before editing).

2. **Health gates the run status.** In `verifyDockerfile` and `verifyCompose`:
   - `runStatus: 'running'` only when **every** configured health check succeeds. Otherwise `'unhealthy'`, with the
     failing URLs and their status codes in `logs`.
   - For compose, add a health pass: `docker compose ps --format json`, require every service `State: running` and
     (where a healthcheck is declared) `Health: healthy`; then HTTP-probe every published port.
   - `buildStatus: 'success'` only when the build exited 0 **and** at least one image/container was produced —
     `docker compose up -d --build` exiting 0 with zero services is not a success.

3. **`devopsNode` reacts.** `buildStatus === 'failed'` or `runStatus === 'unhealthy'` produces a `critical` Bug
   (`DEPLOY-BUILD-FAILED` / `DEPLOY-UNHEALTHY`) with the captured logs, and populates Sub-Plan 03's `DEPLOY`
   acceptance criterion. Under `RUN_FAIL_POLICY='halt'`, a failed deployment build with no bugfix budget left ends
   the run as `failed` rather than proceeding to a meaningless E2E.

---

## 3. Work item 2 — DevOps agent robustness (D1, D11)

1. Remove the hardcoded `recursionLimit: 6` in `nodes.ts:403-415`; use `PIPELINE_RECURSION_LIMIT` (Sub-Plan 08
   also does this — if it has landed, verify rather than duplicate).
2. The `k8sManifests` failure in `retroboard3` is a textbook case for Sub-Plan 04's `repairFieldViolations`
   (string-where-object coercion). If Sub-Plan 04 has landed, confirm `devopsNode` benefits. If not, add a local
   coercion for `k8sManifests` entries: a string is parsed as YAML-ish into `{ name, content }`; an array is
   flattened.
3. **Deterministic Dockerfile fallback (D11).** Add `src/conductor/devops-fallback.ts`:

   ```ts
   /**
    * Generate a minimal, correct Dockerfile + docker-compose.yml from the detected stack roots
    * when the DevOps agent fails or produces nothing. Deterministic, template-based, no LLM.
    */
   export function generateFallbackDeployment(workspacePath: string, roots: StackRoot[], contract?: RepoContract | null): { files: FileChange[]; composeServices: string[] };
   ```

   Templates for: node static SPA (build → `nginx:alpine` serving `buildOutputDir`), node server
   (`node:20-alpine`, `npm ci --omit=dev`, `CMD node <entryPoint>`), python (`python:3.12-slim` + requirements),
   go (multi-stage), dotnet, maven. Reuse `patchDockerfilesSsl()` (already referenced in `AI_Context.md` gotcha 9).

   Invoke it when the DevOps agent throws, when its output has no Dockerfile, or when the tree has no Docker
   artifacts after the agent ran. **This single change is what unblocks E2E for a frontend-only project** — both
   runs skipped E2E because no Dockerfile existed, and both were frontend-only projects for which a 6-line
   Dockerfile is entirely mechanical.

---

## 4. Work item 3 — `e2eStatus` in state: skipped ≠ passed (D6, D7, D8)

1. Add to `ProjectState` (replace reducer):

   ```ts
   /** Terminal E2E outcome. 'not-run' is the initial value and must never be conflated with 'passed'. */
   e2eStatus: 'not-run' | 'passed' | 'failed' | 'skipped-no-services' | 'skipped-disabled' | 'error';
   e2eSkipReason: string | null;
   ```

2. Every exit path of `e2eNode` sets it. The skip path (`nodes.ts:1591-1603`) sets
   `'skipped-no-services'` **and** pushes a `TestReport` with
   `{ type: 'e2e', source: 'executed', status: 'inconclusive', total: 0, runnerError: true }` so downstream code
   sees a signal instead of silence.
3. The `catch` (`nodes.ts:1642-1653`) sets `'error'`, pushes an `inconclusive` e2e report, records a
   `verificationErrors` entry, and synthesises a `major` Bug `E2E-INFRA-FAILED` with the MCP error text.
4. `afterE2eRouter` (`graph.ts:74-83`): filter `r.type === 'e2e' && r.source === 'executed'` and honour
   `iterationIndex` (D7's secondary bug — today a stale unit-test failure could misroute it).
5. **Flip `E2E_BUGFIX_ENABLED` default to `true`.** The comment says it is off "to preserve the cost profile", but
   with Sub-Plan 03's early-halt and the run budget defaults from Sub-Plan 08, an E2E failure is one of the few
   signals worth spending a bugfix iteration on. It was also never exercised — there is no evidence it costs
   anything, because E2E never ran.
6. Sub-Plan 03's `E2E` acceptance criterion reads `e2eStatus`: `passed` ⇒ pass; `skipped-no-services` with no web
   root ⇒ pass; `skipped-no-services` **with** a web root ⇒ **fail** (we could have tested and did not);
   `failed`/`error` ⇒ fail. Keep it `required: false` unless `ACCEPT_REQUIRE_E2E` (new config, default `false`).

---

## 5. Work item 4 — Playwright preflight and a non-Docker E2E path (D10)

`src/tools/mcp/playwright-mcp.ts`.

1. **Preflight**, once per run, cached:

   ```ts
   export interface PlaywrightPreflight { available: boolean; reason?: string; toolCount: number; browsersInstalled: boolean; }
   export async function preflightPlaywright(): Promise<PlaywrightPreflight>;
   ```

   - Spawn the MCP server with a `PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS` (config, default `60000`) budget and
     capture stderr — the `retroboard3` failure was `Connection closed` with no diagnostic retained.
   - Assert `getTools()` returns > 0 tools; log the tool names once at `debug`.
   - Check browsers: run `npx playwright install --dry-run` (or probe the browsers path) and, when missing and
     `PLAYWRIGHT_AUTO_INSTALL` (config, default `true`) is set, run `npx playwright install chromium --with-deps`
     once with a generous timeout. This is almost certainly the actual `retroboard3` root cause — a first-ever
     `npx @playwright/mcp@latest` in a corporate-proxy environment with no browsers cached.
   - Retry the connection `PLAYWRIGHT_MCP_CONNECT_RETRIES` (default `2`) times with backoff.
   - On failure, log the captured stderr — never just `Connection closed`.

2. `e2eNode` calls the preflight **before** deciding to run. If unavailable, set `e2eStatus: 'error'` with the real
   reason, and **fall back** to the deterministic HTTP smoke check from Sub-Plan 01 (`runSmokeTest`) against the
   service URLs — a 200 response plus asset checks is far better than nothing, and it is exactly the check that
   would have caught the pacman white screen.

3. **Non-Docker E2E path.** Today E2E requires `devopsPlan.serviceUrls`, which requires Docker. Add: when
   verification is skipped but a web root exists, start the same static/preview server `runSmokeTest` uses, and give
   its URL to the E2E agent. Guard with `E2E_ALLOW_LOCAL_SERVER` (config, default `true`). This is what makes E2E
   reachable for the majority of generated projects.

4. **Cross-check the E2E self-report (D9).** The report is currently whatever the LLM says. Add mechanical evidence:
   - Require `screenshotPath` on every failure and verify the file exists and is non-empty; drop claims whose
     screenshot is missing and log the discrepancy.
   - Capture the browser console via the MCP `browser_console_messages` tool (or equivalent — enumerate the tool
     list in the preflight and pick the right name) after each scenario, and fail the scenario on any
     uncaught error. A React app rendering a white page because a 404'd stylesheet threw would be caught here.
   - Record `e2eEvidence: { screenshots: string[]; consoleErrors: string[]; urlsVisited: string[] }` on state and
     include counts in the manifest. If the agent claims 12 passing scenarios and visited 0 URLs, that is a
     discrepancy — record it the same way Sub-Plan 09 records QA claim discrepancies.

5. Apply the `[US-003#1]` tagging convention (Sub-Plan 09 §4) to E2E scenario names too, so E2E results feed AC
   coverage. Add it to `qa-e2e.prompt.ts` and parse it in the report handling.

---

## 6. Config additions / changes

```ts
// ─── E2E ────────────────────────────────────────────────────────────────────

/** Allow E2E failures to trigger a bugfix iteration. */
export const E2E_BUGFIX_ENABLED = (process.env.E2E_BUGFIX_ENABLED ?? 'true') === 'true';   // was 'false'
/** Serve the built product locally for E2E when no Docker services are available. */
export const E2E_ALLOW_LOCAL_SERVER = (process.env.E2E_ALLOW_LOCAL_SERVER ?? 'true') === 'true';
/** Make the E2E acceptance criterion required. */
export const ACCEPT_REQUIRE_E2E = (process.env.ACCEPT_REQUIRE_E2E ?? 'false') === 'true';
/** Playwright MCP startup budget (ms). */
export const PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS ?? '60000', 10);
/** Connection retries for the Playwright MCP server. */
export const PLAYWRIGHT_MCP_CONNECT_RETRIES = parseInt(process.env.PLAYWRIGHT_MCP_CONNECT_RETRIES ?? '2', 10);
/** Run `npx playwright install chromium --with-deps` when browsers are missing. */
export const PLAYWRIGHT_AUTO_INSTALL = (process.env.PLAYWRIGHT_AUTO_INSTALL ?? 'true') === 'true';
/** Generate a deterministic Dockerfile/compose when the DevOps agent fails or produces none. */
export const DEVOPS_FALLBACK_ENABLED = (process.env.DEVOPS_FALLBACK_ENABLED ?? 'true') === 'true';
```

---

## 7. Tests

`tests/devops-verify.test.ts` (use the injected exec seam; do not require Docker in CI):

- Docker unavailable ⇒ `buildStatus: 'skipped'`, and `devopsNode` **discards** the agent's claimed
  `serviceUrls: ['http://localhost:3000', 'http://localhost:5173']` (use the literal retroboard claim) and logs the
  discard.
- `docker compose up` exits 0 but `compose ps` shows a service `exited` ⇒ `buildStatus: 'failed'`.
- Container starts, all health checks 500 ⇒ `runStatus: 'unhealthy'`, `DEPLOY-UNHEALTHY` bug synthesised.
- All health checks 200 ⇒ `runStatus: 'running'`.

`tests/devops-fallback.test.ts`:

- A Vite SPA root with `buildOutputDir: 'dist'` ⇒ a Dockerfile building and serving `dist` via nginx, plus a
  compose service with a published port.
- An Express root with `entryPoints: ['src/server.ts']` ⇒ a node Dockerfile with the right `CMD`.
- A monorepo with both ⇒ two services in compose.
- `patchDockerfilesSsl` applied.

`tests/e2e-node.test.ts` (mock the MCP client):

- No service URLs, no web root ⇒ `e2eStatus: 'skipped-no-services'`, an `inconclusive` e2e report exists,
  acceptance `E2E` passes.
- No service URLs **but** a web root exists ⇒ local server path taken; if that also fails, `e2eStatus: 'error'` and
  the acceptance criterion fails.
- MCP connect throws `Connection closed` (the literal retroboard message) ⇒ `e2eStatus: 'error'`,
  `E2E-INFRA-FAILED` bug, stderr captured in the bug's `actualBehavior`.
- Agent claims 5 passing scenarios with 0 recorded screenshots and 0 visited URLs ⇒ discrepancy recorded.
- `afterE2eRouter` with a failing **unit** report and a passing e2e report ⇒ does not route to bugfix.

`tests/playwright-preflight.test.ts`:

- Tool count 0 ⇒ `available: false` with a reason.
- Missing browsers with `PLAYWRIGHT_AUTO_INSTALL=false` ⇒ `available: false`, reason names the install command.

---

## 8. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `grep -n "verified.buildStatus !== 'skipped'" src/conductor/nodes.ts` returns nothing.
- [ ] `grep -rn "recursionLimit: 6" src/` returns nothing.
- [ ] `e2eStatus` is set on **every** return path of `e2eNode` (read the function end to end and confirm).
- [ ] A manual `npx @playwright/mcp@latest --headless` preflight in this environment either succeeds or produces a
      captured, actionable error — run it once by hand and record the result in the sub-plan's completion notes,
      because `retroboard3`'s failure suggests it does not currently work here at all.
- [ ] `README.md` DevOps/E2E phase docs and `AI_Context.md` phase table (`9b | E2E`) updated with `e2eStatus`, the
      local-server path and the fallback Dockerfile generator; the `E2E_BUGFIX_ENABLED` default change noted in
      `.env.example`.

## 9. Out of scope

- The static smoke check itself → Sub-Plan 01 (this sub-plan reuses `runSmokeTest`).
- The acceptance gate mechanics → Sub-Plan 03.
- Do not attempt real Kubernetes deployment verification. `k8sManifests` should be validated syntactically
  (`kubectl apply --dry-run=client` when `kubectl` is on PATH, otherwise a YAML parse) and nothing more.
