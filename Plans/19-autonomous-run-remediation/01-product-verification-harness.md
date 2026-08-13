# Sub-Plan 01 — Product Verification Harness

**Depends on:** nothing. This is the foundation for 02, 03, 07, 09, 11.
**Goal:** build a deterministic instrument that answers *"does the generated product actually build, resolve its
imports, and render something?"* — because today nothing in the system can answer that.

---

## 1. Context you need (read these first)

- `src/conductor/quality-gates.ts` (420 lines) — the current gate. Read all of it.
- `src/conductor/nodes.ts` — `qaNode` around lines 1180–1400 (where gates are called and swallowed).
- `src/conductor/pr-workflow.ts:615-704` — where gates are called in the PR flow.
- `src/conductor/devops-verify.ts` — the Docker-mode verifier (patterns to reuse: `execSync` wrapper, timeouts).
- `src/config.ts:313-329` — the `QUALITY_GATE_*` block.
- `.env.example` — the quality-gates block (~lines 109-117).
- `src/tools/mcp/playwright-mcp.ts` — existing MCP client (you will **not** use MCP here; see §5 note).

### Evidence this sub-plan responds to

`generated-projects/pacman8/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";     // ← this file does not exist. vite build fails. npm run dev serves a white page.
```

`generated-projects/pacman8/src/App.tsx` is `export default function App() { return <div>Pac-Man</div>; }`.

`generated-projects/retroboard3/package.json`:

```json
"scripts": { "build": "echo Build successful", "test": "npx jest" }
```

`generated-projects/retroboard3/index.html` line 10 references `/src/main.tsx`, which does not exist.
`packages/frontend/` contains `package.json`, `tsconfig.json`, `vite.config.ts`, `.eslintrc.js` and
**zero source files** — and was never gated because `detectStacks` only reads the repo root.

Both runs' gates reported PASSED. Both products are non-functional.

---

## 2. Current defects to fix, precisely

| ID | Defect | Location |
|---|---|---|
| D1 | `detectStacks` is a single non-recursive `fs.readdirSync(workspacePath)` — subpackages are never gated | `quality-gates.ts:62-85` |
| D2 | `build: 'npm run build --if-present'` — a missing build script exits 0 and is recorded `passed: true, skipped: false` | `quality-gates.ts:93` |
| D3 | `lint: 'npm run lint --if-present'` — same | `quality-gates.ts:94` |
| D4 | No typecheck step exists for any stack | `quality-gates.ts:90-125` |
| D5 | No assertion that the build produced artifacts | — |
| D6 | No check that imported modules / referenced assets exist | — |
| D7 | No check that the app renders | — |
| D8 | `passed = results.every(r => r.passed \|\| r.skipped)` — all-skipped ⇒ `passed: true` | `quality-gates.ts:300` |
| D9 | `gateReportToTestReport` returns `null` for an all-skipped report ⇒ downstream sees **no signal** | `quality-gates.ts:317` |
| D10 | Missing toolchain ⇒ `passed: !QUALITY_GATE_STRICT_TOOLCHAIN` (default false ⇒ pass) | `quality-gates.ts:229-244` |
| D11 | 3 no-op steps are rendered as `total: 3, passed: 3, status: 'pass'` "unit tests" | `quality-gates.ts:315-334` |
| D12 | `install` skipped whenever `node_modules` exists — a partial/stale tree is never revalidated | `quality-gates.ts:256-268` |

---

## 3. Work item 1 — Multi-root stack detection (fixes D1)

Rewrite `detectStacks` into `detectStackRoots(workspacePath): StackRoot[]` where:

```ts
export interface StackRoot {
    /** Absolute path of the directory containing the marker file. */
    dir: string;
    /** Path relative to the workspace root ('' for the root itself). */
    relDir: string;
    stack: StackKind;
    /** True when this root is a member of a detected workspace/monorepo (npm workspaces, pnpm, go work, maven modules). */
    isWorkspaceMember: boolean;
}
```

Rules:

1. Walk the tree up to `QUALITY_GATE_SCAN_DEPTH` (new config, default `3`) levels deep. Prune
   `node_modules`, `.git`, `.worktrees`, `dist`, `build`, `.next`, `out`, `coverage`, `.venv`, `venv`,
   `vendor`, `target`, `.conventions`.
2. Keep the existing `STACK_MARKERS` table but apply it per directory.
3. **Workspace awareness:** if a root `package.json` declares `workspaces` (array or `{packages: []}`), mark the
   matching child roots `isWorkspaceMember: true`. For those, prefer running the root's
   `npm run build --workspaces` once over building each member separately — but only if that script exists;
   otherwise gate each member individually.
4. Cap the number of roots at `QUALITY_GATE_MAX_ROOTS` (new config, default `8`) and log a `warn` when capped.
5. Keep the old `detectStacks(workspacePath): StackKind[]` export as a thin wrapper
   (`detectStackRoots(p).map(r => r.stack)` deduped) — `tests/quality-gates.test.ts` and possibly other
   callers use it. Grep for `detectStacks(` before changing its signature.

`GateResult` gains `relDir: string` so failures name the directory. `GateReport` gains `roots: StackRoot[]`.

---

## 4. Work item 2 — Real gate steps (fixes D2, D3, D4, D12)

Extend `GateStep` to `'install' | 'typecheck' | 'build' | 'lint' | 'test' | 'artifacts' | 'resolve' | 'smoke'`.

New/changed commands in `GATE_COMMANDS`:

```ts
node: {
    install:   'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
    typecheck: '<resolved at runtime — see below>',
    build:     '<resolved at runtime — see below>',
    lint:      '<resolved at runtime — see below>',
    test:      '<resolved at runtime — see below>',
},
```

Add a **script resolver** for the node stack that reads the target directory's `package.json` and decides:

```ts
/**
 * Resolve the concrete command for a gate step from the target package.json.
 * Returns `{ command, mode }` where mode is:
 *   'real'    — a project script exists and will be executed
 *   'fallback'— no script; run a stack-default tool directly (still a real check)
 *   'absent'  — the step cannot be performed for this root
 */
function resolveNodeStep(dir: string, step: GateStep): { command: string; mode: 'real' | 'fallback' | 'absent' };
```

Behaviour (this replaces `--if-present` entirely — **never use `--if-present` again**):

| Step | Script present | Script absent → fallback |
|---|---|---|
| `typecheck` | `npm run typecheck` / `type-check` | `npx --no-install tsc --noEmit -p <tsconfig>` when a `tsconfig.json` exists; `absent` otherwise |
| `build` | `npm run build` | If a bundler config exists (`vite.config.*`, `webpack.config.*`, `next.config.*`, `angular.json`, `rollup.config.*`) → run that bundler's build via `npx --no-install`; if the package has no build concept (pure library/backend with `tsc`) → treat `typecheck` as the build and mark `build` `absent` |
| `lint` | `npm run lint` | `npx --no-install eslint . --max-warnings=0` when an eslint config exists; `absent` otherwise |
| `test` | `npm test` | `absent` — and **that is a failure**, see §6 |

A step whose mode is `absent` must be recorded with a new field `mode: 'absent'` and must **not** count as a pass.
See §6 for how `report.passed` treats it.

**D12:** stop skipping `install` on the mere presence of `node_modules`. Instead skip only when a marker file
`node_modules/.package-lock.json` exists **and** its mtime is newer than `package-lock.json`/`package.json`.
Otherwise run install. Record `skipped: true, output: 'deps up to date'`.

Also add for other stacks (keep them cheap):

- `go`: `typecheck` → `go build ./...` already covers it; add `artifacts` (binary or `go build -o /dev/null`).
- `python`: `typecheck` → `python -m mypy .` only if a mypy config exists, else `absent`.
- `dotnet`, `maven`, `gradle`, `rust`: add `lint` fallbacks only where a config exists; otherwise `absent`.

---

## 5. Work item 3 — New file `src/conductor/product-verify.ts`

This holds the three checks that do not exist at all today (D5, D6, D7). It must be a **pure-ish** module:
side-effect-free exported analysis functions plus one orchestrator that shells out.

```ts
// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArtifactCheck {
    root: string;              // relDir
    expectedDirs: string[];    // e.g. ['dist'] or ['build', '.next']
    foundDir: string | null;
    fileCount: number;
    totalBytes: number;
    hasEntryHtml: boolean;     // for web apps
    hasEntryJs: boolean;
    passed: boolean;
    reason: string;
}

export interface ResolveIssue {
    file: string;              // relative to workspace
    line: number;
    specifier: string;         // './index.css', '/src/main.tsx', '@/lib/foo'
    kind: 'import' | 'require' | 'html-src' | 'html-href' | 'css-url';
    reason: 'missing-file' | 'missing-package';
}

export interface SmokeResult {
    ran: boolean;
    skippedReason?: string;
    url: string;
    httpStatus: number | null;
    /** Bytes of the served document. */
    bodyBytes: number;
    /** True when the served HTML/DOM contains meaningful content beyond an empty root div. */
    rendered: boolean;
    /** Console errors captured, if a browser was used. */
    consoleErrors: string[];
    passed: boolean;
    reason: string;
}

export interface ProductVerifyReport {
    artifacts: ArtifactCheck[];
    resolveIssues: ResolveIssue[];
    smoke: SmokeResult | null;
    passed: boolean;
    summary: string;
}
```

### 5a. `verifyBuildArtifacts(workspacePath, roots): ArtifactCheck[]` (D5)

- Determine expected output dirs per root: read `vite.config.*` / `angular.json` / `next.config.*` when cheap,
  otherwise probe the standard set `['dist', 'build', 'out', '.next', 'public/build']`.
- **Fail** when: no expected dir exists, or it exists with 0 files, or total bytes < `PRODUCT_MIN_ARTIFACT_BYTES`
  (new config, default `2048`), or — for a root whose `index.html` exists in source — the output has no `.html`
  **and** no `.js` file.
- This is what catches `"build": "echo Build successful"`: exit 0, no `dist/`, `passed: false`,
  `reason: 'build script exited 0 but produced no artifacts in dist/, build/, out/, .next/'`.
- Backend-only roots (no `index.html`, no bundler config) are exempt — return `passed: true` with
  `reason: 'no bundled artifacts expected'`. Do not invent failures for API packages.

### 5b. `findUnresolvedReferences(workspacePath): ResolveIssue[]` (D6)

Static, no bundler needed. This is the check that catches **both** headline bugs.

1. Enumerate source files under the workspace, honouring the prune list from §3, limited to
   `.ts .tsx .js .jsx .mjs .cjs .vue .svelte .html .css .scss`, capped at `PRODUCT_RESOLVE_MAX_FILES`
   (new config, default `2000`).
2. Extract specifiers with regexes (do **not** add a parser dependency):
   - `import ... from '<spec>'`, `import '<spec>'`, `export ... from '<spec>'`
   - `require('<spec>')`, `import('<spec>')`
   - HTML: `src="<spec>"`, `href="<spec>"` (skip `http:`, `https:`, `//`, `data:`, `mailto:`, `#`)
   - CSS: `url(<spec>)` (same skips)
3. Classify:
   - **Relative** (`./`, `../`) or **root-absolute** (`/foo`): resolve against the file's directory (or the
     nearest dir containing `index.html` for root-absolute in HTML). Try the literal path, then extension
     candidates `['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.vue', '.svelte']`,
     then `<path>/index.<ext>`. Missing ⇒ `reason: 'missing-file'`.
   - **Alias** (`@/…`, `~/…`, or any prefix declared in `tsconfig.json` `compilerOptions.paths`): resolve via
     the tsconfig paths map. Missing ⇒ `missing-file`. If no paths map exists, skip (do not report).
   - **Bare package** (`react`, `express`, `socket.io`): check it is listed in the nearest
     `package.json` `dependencies`/`devDependencies`/`peerDependencies`, or is a Node builtin
     (`node:`-prefixed or in `require('module').builtinModules`). Missing ⇒ `reason: 'missing-package'`.
     Do **not** require `node_modules` to be installed for this check.
4. Return every issue. `pacman8` must yield exactly one `missing-file` for `./index.css` from `src/main.tsx`;
   `retroboard3` must yield `missing-file` for `/src/main.tsx` from `index.html`.

**Write unit tests using fixture directories under `tests/fixtures/product-verify/` that reproduce both real
bugs.** These two fixtures are the acceptance test for this whole sub-plan.

### 5c. `runSmokeTest(workspacePath, roots, opts): SmokeResult` (D7)

Deliberately simple and dependency-free. **Do not use Playwright MCP here** — Playwright is unreliable in this
environment (`retroboard3 run.log 16405`: `Failed to connect to stdio server "playwright"`) and E2E remains
Sub-Plan 11's concern. This check must work with nothing but Node.

Algorithm:

1. Pick the web root: the root with an `index.html` and a bundler config; prefer one whose build produced
   artifacts. If none, return `{ ran: false, skippedReason: 'no web root detected', passed: true }`.
2. Prefer serving the **built artifacts** statically over running a dev server (faster, no watcher, no port race):
   spawn `npx --no-install http-server` if available, else implement a ~40-line static file server inline with
   `node:http` + `node:fs` — **prefer the inline server**; it removes a dependency and a network install.
   Fall back to `npm run preview -- --port <p>` then `npm run dev -- --port <p>` if there are no artifacts.
3. Port: `PRODUCT_SMOKE_BASE_PORT` (new config, default `18190`), probing upward for a free port.
4. Wait for readiness: poll `GET /` every 500 ms up to `PRODUCT_SMOKE_TIMEOUT_MS` (new config, default `60000`).
5. Fetch `/`. Then fetch every `src`/`href` the served HTML references (same-origin only, max 20) and record any
   non-2xx as a failure — **this is what turns "white screen because index.css 404s" into a red gate.**
6. `rendered` heuristic for a static bundle: the HTML must reference at least one script that returns 2xx, and the
   total bytes of successfully fetched same-origin assets must exceed `PRODUCT_MIN_ARTIFACT_BYTES`.
   For an SPA the served HTML legitimately contains an empty `<div id="root">`; do **not** fail on that alone.
7. Always kill the child process in a `finally`, and always free the port.

`consoleErrors` stays `[]` in this sub-plan (no browser). Sub-Plan 11 fills it from the real E2E path.

### 5d. `runProductVerification(workspacePath, roots, opts): ProductVerifyReport`

Runs 5a → 5b → 5c, composes `passed`, and produces a one-paragraph `summary` suitable for a PR body and a
transcript message. Emit `emitRunEvent('gate:result', { kind: 'product-verify', ... })`.

---

## 6. Work item 4 — Honest aggregation (fixes D8, D9, D10, D11)

In `quality-gates.ts`:

```ts
// ─── Aggregation ────────────────────────────────────────────────────────────
// A gate report only "passes" when at least one step was really executed and
// nothing that could be executed failed. Skipped/absent steps are NOT passes:
// they are recorded as `inconclusive`, which callers must treat as not-green.
```

1. Add `mode: 'real' | 'fallback' | 'absent'` and `inconclusive: boolean` to `GateResult`.
2. `report.passed` = `executed.length > 0 && executed.every(r => r.passed)` where
   `executed = results.filter(r => !r.skipped && r.mode !== 'absent')`.
3. Add `report.inconclusive = executed.length === 0 || results.some(r => r.mode === 'absent' && REQUIRED_STEPS.has(r.step))`
   with `REQUIRED_STEPS = new Set(['build', 'test'])`. A node project with no `test` script is **inconclusive**,
   not passing.
4. **D10:** flip `QUALITY_GATE_STRICT_TOOLCHAIN` default to `true`. A missing toolchain is now a failure with
   `output: "Toolchain 'mvn' not available — cannot verify this stack"`. Rationale: a silently unverified stack is
   exactly how `retroboard3` shipped. Document the flag in `.env.example` as
   "set to false only for local experiments".
5. **D9/D11:** replace `gateReportToTestReport` with `gateReportToVerificationReport`, and stop pretending gate
   steps are unit tests:
   - Keep a `TestReport` for state compatibility, but set `framework: 'quality-gates'` **and**
     `type: 'unit'` only when the `test` step actually ran with a real runner. When only build/lint ran, emit
     `total: 0` with `status: 'fail'` if any step failed, or a new status value if the schema allows —
     **check `src/agents/_shared/schemas/testing.schema.ts` first**; if `status` is a 2-value union, extend it to
     `'pass' | 'fail' | 'inconclusive'` and update every consumer (grep `status === 'fail'` and `status: 'pass'`).
   - Never return `null`. For an all-skipped/inconclusive report, return a report with
     `status: 'inconclusive'` so downstream routers can see it. This is essential — today an empty gate report
     produces silence, and silence reads as success.
6. Include `productVerify` in the report: extend `GateReport` with
   `productVerify?: ProductVerifyReport`, populated when the caller asks for it (see §7).

Update `synthesiseGateBugs` to also synthesise bugs from `ProductVerifyReport`:

- one `critical` bug per failing `ArtifactCheck` with id `PRODUCT-ARTIFACTS-<relDir>`
- one `critical` bug for unresolved references, id `PRODUCT-RESOLVE`, listing up to 10 issues in
  `actualBehavior` (`src/main.tsx:4 → './index.css' (missing-file)`)
- one `critical` bug for a failing smoke test, id `PRODUCT-SMOKE`

Stable ids matter — `dedupeBugs` relies on them.

Update `gateReportToMarkdown` to render the new columns (`Dir`, `Mode`) and a `Product verification` section.

---

## 7. Work item 5 — Wire it in (two call sites, no behaviour change to routing yet)

Routing/status changes belong to Sub-Plan 03. Here, only produce the signal.

1. `src/conductor/pr-workflow.ts:620-624` — pass `{ productVerify: 'artifacts+resolve' }`. Run artifact and
   resolve checks in the worktree (cheap, deterministic). **Do not** run the smoke server per PR — it is slow and
   port-contended across `MAX_CONCURRENT_DEVS` parallel worktrees.
2. `src/conductor/nodes.ts` `qaNode` (the `runQualityGates` call around line 1300) — pass
   `{ productVerify: 'full' }` so the smoke test runs once per QA phase against the synced workspace.
3. Log a clear line at both sites:
   `Product verification: artifacts=<n ok/n>, unresolved refs=<n>, smoke=<pass|fail|skipped>`.

---

## 8. Config additions (`src/config.ts` + `.env.example` + README table)

```ts
// ─── Product Verification ───────────────────────────────────────────────────

/** Max directory depth scanned when detecting stack roots (monorepo packages). */
export const QUALITY_GATE_SCAN_DEPTH = parseInt(process.env.QUALITY_GATE_SCAN_DEPTH ?? '3', 10);

/** Max stack roots gated per run (guards pathological trees). */
export const QUALITY_GATE_MAX_ROOTS = parseInt(process.env.QUALITY_GATE_MAX_ROOTS ?? '8', 10);

/** Enable artifact / import-resolution / smoke verification of the generated product. */
export const PRODUCT_VERIFY_ENABLED = (process.env.PRODUCT_VERIFY_ENABLED ?? 'true') === 'true';

/** Minimum total bytes a build must emit before it counts as a real build. */
export const PRODUCT_MIN_ARTIFACT_BYTES = parseInt(process.env.PRODUCT_MIN_ARTIFACT_BYTES ?? '2048', 10);

/** Max source files scanned by the import-resolution check. */
export const PRODUCT_RESOLVE_MAX_FILES = parseInt(process.env.PRODUCT_RESOLVE_MAX_FILES ?? '2000', 10);

/** First host port used by the smoke server (probes upward when busy). */
export const PRODUCT_SMOKE_BASE_PORT = parseInt(process.env.PRODUCT_SMOKE_BASE_PORT ?? '18190', 10);

/** Timeout (ms) for the smoke server to become ready and answer. */
export const PRODUCT_SMOKE_TIMEOUT_MS = parseInt(process.env.PRODUCT_SMOKE_TIMEOUT_MS ?? '60000', 10);
```

Also change: `QUALITY_GATE_STRICT_TOOLCHAIN` default `'false'` → `'true'`, and
`QUALITY_GATE_STEPS` default `'install,build,lint,test'` → `'install,typecheck,build,lint,test'`.

---

## 9. Tests (all offline, all required)

Create `tests/product-verify.test.ts` and extend `tests/quality-gates.test.ts` (check whether the latter exists;
if not, create it).

Fixtures under `tests/fixtures/product-verify/`:

| Fixture | Contents | Expected |
|---|---|---|
| `pacman-missing-css/` | `src/main.tsx` importing `./index.css` (absent), `src/App.tsx`, `index.html`, `package.json` with a real `vite build` | `findUnresolvedReferences` → exactly 1 issue, `missing-file`, `./index.css`, line 4 |
| `retro-echo-build/` | `package.json` with `"build": "echo Build successful"`, `index.html` referencing `/src/main.tsx` (absent), `__tests__/math.test.js` | `findUnresolvedReferences` → 1 `missing-file` for `/src/main.tsx`; `verifyBuildArtifacts` → `passed: false` with the "exited 0 but produced no artifacts" reason |
| `monorepo/` | root `package.json` with `workspaces: ['packages/*']`, `packages/frontend/package.json`, `packages/backend/package.json` | `detectStackRoots` → 3 roots, children `isWorkspaceMember: true` |
| `healthy-vite/` | a minimal but complete Vite app **with a committed `dist/`** | artifacts pass, resolve clean, smoke passes against the static server |
| `missing-package/` | source importing `socket.io-client` not present in `package.json` | 1 `missing-package` issue |
| `alias-paths/` | `tsconfig.json` with `paths: { "@/*": ["src/*"] }`, one resolving and one broken alias import | exactly 1 issue |

Unit tests for aggregation, using the existing injected `exec` seam (`ExecFn`) so nothing shells out:

- all-skipped ⇒ `passed: false`, `inconclusive: true`
- one real failing step ⇒ `passed: false`
- node root with no `test` script ⇒ `test` step `mode: 'absent'`, report `inconclusive: true`
- missing toolchain with the new default ⇒ `passed: false`
- `synthesiseGateBugs` produces `PRODUCT-RESOLVE` with a stable id across two calls

Smoke-server test: start the inline static server against `healthy-vite/dist`, assert 200 and `rendered: true`;
then delete the referenced JS asset and assert `passed: false` with a 404 recorded.

---

## 10. Verification checklist

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run test:unit` green, including the six new fixtures.
- [ ] `grep -rn "if-present" src/` returns **zero** hits.
- [ ] `detectStackRoots` on `generated-projects/retroboard3` finds ≥3 roots including both `packages/*`.
- [ ] `findUnresolvedReferences` on `generated-projects/pacman8` reports `src/main.tsx → ./index.css`.
- [ ] `findUnresolvedReferences` on `generated-projects/retroboard3` reports `index.html → /src/main.tsx`.
- [ ] `README.md` Environment Variables table and `.env.example` updated for all new vars and the two changed defaults.
- [ ] `AI_Context.md` "Key Subsystems" gains a `Product Verification (product-verify.ts)` entry; the Quality Gates
      entry is updated to mention multi-root detection and the new steps.

## 11. Explicitly out of scope here

- Changing routing, run status, or whether a failure blocks the pipeline → **Sub-Plan 03**.
- Preventing agents from tampering with `package.json` → **Sub-Plan 02**.
- Browser-based E2E and Playwright → **Sub-Plan 11**.
- Do not add new runtime dependencies. Everything above is achievable with `node:` builtins plus what is already
  in `package.json`.
