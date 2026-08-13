# Sub-Plan 05 — The Architecture Contract

**Depends on:** Sub-Plan 04 (assignment schema with `taskIds`; coverage validator to hook into).
**Goal:** give every agent one machine-checkable statement of *where files go, what modules exist, and what they
export* — so two agents cannot build two incompatible projects in the same repository.

---

## 1. Evidence

`retroboard3` built a monorepo and a flat repo simultaneously, in the same run.

The Product Manager mandated npm workspaces (`state.json`):

```
1309  "Initialize monorepo using npm workspaces, create `packages/frontend` and `packages/backend`
       directories, configure root package.json scripts."
1326  "Setup React SPA with Vite and TypeScript in `packages/frontend` …"
1345  "Setup Express backend project with TypeScript in `packages/backend` …"
```

`principal-backend` executed it correctly (`run.log 82-151`): root `package.json` with `workspaces`,
`packages/backend/{package.json,tsconfig.json,src/index.ts}`, `packages/frontend/package.json`.

Then the **Team Leader's own assignments contradicted it** (`state.json`):

```
2234  ASSIGN-049: "Create main server entry point (`src/server.ts`) that mounts all REST routes, initializes Socket.io…"
2258  ASSIGN-050: "Update root App component (`src/App.tsx`) to import and compose Board, SessionForm, SideList…"
```

Root-level `src/`, not `packages/*/src/`. Agents then split:

- root `src/`: `src/components/SideList.tsx`, `src/data.js`, `src/store.ts`, `src/features/sessionSlice.ts`,
  `src/components/EditCard.tsx`, `src/server.ts`, `src/components/Board.tsx`, `vite.config.ts`, `jest.config.cjs`,
  `index.html`
- `packages/`: `packages/frontend/src/App.tsx`, `packages/frontend/src/main.tsx`, `packages/frontend/index.html`,
  `packages/frontend/src/components/CardModal.tsx`

Every PR carrying real `packages/frontend/src` code (**#3, #5, #8, #11**) died in merge conflicts and was
abandoned `open`. The root-`src/` stubs merged. The delivered `index.html` (root) references `/src/main.tsx`,
which only ever existed at `packages/frontend/src/main.tsx` in the unmerged PR #3. A reviewer named both halves
exactly (`run.log 8906-8907`):

```
index.html:9 — [MAJOR] The script tag references `/src/main.tsx`, but no such file exists in the repository.
packages/frontend/vite.config.ts:4 — [MINOR] `root: resolve(__dirname, 'packages/frontend')` points Vite to a
    non-existent directory because this config file lives at the repository root.
```

`qa-unit` later searched `packages/backend/src` for `sessionService` (`run.log 16257-16259`), found nothing,
and gave up. And the gate-gaming write (`run.log 8808`) deleted `workspaces`, orphaning both packages permanently.

`pacman8` shows the milder version: `principal-frontend` (scaffold) and `senior-frontend` (feature) each invented
their own layout, producing both `src/InputHandler.ts` **and** `src/hooks/useInputHandler.ts`, and both
`src/GameEngine.ts` **and** `src/engine/GameEngine.ts` (`run.log 138/168/578/609`).

### Root cause in code

`src/agents/_shared/schemas/architecture.schema.ts` is 21 lines and contains **no layout information at all**:

```ts
export const ArchitectureComponentSchema = z.object({
    name: z.string(), type: z.string(), description: z.string(),
    technology: z.string(), communicatesWith: z.array(z.string()),
});
export const ArchitectureDocSchema = z.object({
    style: z.string(), components: z.array(ArchitectureComponentSchema),
    dataFlow: z.string(), integrations: z.array(z.string()),
    nonFunctional: z.array(z.string()), mermaidDiagram: z.string(),
});
```

No directory structure, no module paths, no export surface, no entry points, no naming convention. By the time it
reaches a developer it has been reduced to one clipped line per component
(`context-builder.ts:43-65`, descriptions clipped to `CONTEXT_MAX_DESC_CHARS = 200`). Nothing forces two agents
onto the same path, and nothing forces them to agree on an interface.

---

## 2. Work item 1 — Schema: `RepoContract`

New file `src/agents/_shared/schemas/repo-contract.schema.ts`:

```ts
// ─── Repo Contract ──────────────────────────────────────────────────────────
// The single source of truth for WHERE code goes and WHAT it exports.
// Produced by the Architect, enforced mechanically, read by every downstream agent.

export const ModuleContractSchema = z.object({
    /** Stable id referenced by tasks and assignments, e.g. 'MOD-GHOST-AI'. */
    id: z.string(),
    /** Exact file path relative to the repo root, e.g. 'packages/frontend/src/game/GhostAI.ts'. */
    path: z.string(),
    /** Which architecture component this module belongs to. */
    componentName: z.string(),
    /** Named exports this module MUST provide, with their shapes as TypeScript-ish signatures. */
    exports: z.array(z.object({
        name: z.string(),
        kind: z.enum(['function', 'class', 'const', 'type', 'interface', 'component', 'hook', 'router', 'default']),
        signature: z.string(),   // e.g. 'chooseTarget(ghost: Ghost, pac: PacMan, mode: Mode): Tile'
    })),
    /** Module ids or bare package names this module may import. Enforced by the layout linter. */
    dependsOn: z.array(z.string()).default([]),
});

export const StackRootContractSchema = z.object({
    /** Directory relative to repo root; '.' for a single-root project. */
    dir: z.string(),
    kind: z.enum(['frontend', 'backend', 'shared', 'infra', 'e2e']),
    /** Stack: 'node' | 'maven' | … matching quality-gates StackKind. */
    stack: z.string(),
    /** Entry point files that bootstrap this root, e.g. ['src/main.tsx'] or ['src/server.ts']. */
    entryPoints: z.array(z.string()).min(1),
    /** Directories agents may create files in, relative to `dir`. */
    sourceDirs: z.array(z.string()).min(1),
    /** Where tests go, relative to `dir`. */
    testDirs: z.array(z.string()).min(1),
    /** Exact npm/maven/… scripts this root must expose. FROZEN once set (see Sub-Plan 02). */
    scripts: z.record(z.string(), z.string()),
    /** Build output directory relative to `dir`, or null for non-bundled roots. */
    buildOutputDir: z.string().nullable(),
});

export const RepoContractSchema = z.object({
    /** 'single-root' | 'npm-workspaces' | 'polyrepo-in-one' — decided ONCE by the Architect. */
    layout: z.enum(['single-root', 'npm-workspaces', 'multi-stack']),
    roots: z.array(StackRootContractSchema).min(1),
    modules: z.array(ModuleContractSchema),
    /** File naming convention, e.g. 'PascalCase for components, camelCase for utils, kebab-case for routes'. */
    namingConvention: z.string(),
    /** Shared type/interface file paths every root may import. */
    sharedTypes: z.array(z.string()).default([]),
    /** Paths that are frozen after scaffolding (config files). Informational; enforcement lives in Sub-Plan 02. */
    frozenPaths: z.array(z.string()).default([]),
});
```

Add `repoContract: RepoContractSchema` to `ArchitectOutputSchema` (`src/agents/architect/schemas/`), and
`repoContract: RepoContract | null` to `ProjectState` with a **replace** reducer.

**Keep it proportional.** The Architect prompt already has a `<proportionality>` block; the contract for a
single-page Pac-Man clone should be `layout: 'single-root'`, one root, ~10–20 modules. Do not let this become a
1,000-line artifact — cap `modules` at `REPO_CONTRACT_MAX_MODULES` (config, default `60`) and instruct the
Architect to declare modules only for units that more than one agent will touch or import.

---

## 3. Work item 2 — Architect prompt & JSON mode

`src/agents/architect/architect.prompt.ts`:

1. New mandatory section:

   ```
   <repo_contract>
       You MUST emit a `repoContract` that fixes the physical shape of the repository. Every other
       agent is bound by it and a linter enforces it. Get it right and be concrete.

       1. CHOOSE ONE layout and commit to it:
          - 'single-root'    — one package at the repo root. DEFAULT. Use it unless there is a
                               genuine need for separate deployables.
          - 'npm-workspaces' — only when frontend and backend are separately deployable AND you
                               declare the root `workspaces` globs and the root build script.
          - 'multi-stack'    — different languages in sibling directories.
          A single-page browser game or a small SPA+API is 'single-root'. Do NOT create a monorepo
          for a project with fewer than ~15 stories.
       2. For EVERY root declare: dir, kind, stack, entryPoints, sourceDirs, testDirs, scripts,
          buildOutputDir. `scripts` MUST include a real `build` and a real `test` command — never
          `echo`, never `exit 0`, never `--passWithNoTests`.
       3. Declare a module for every unit that another agent will import, with its EXACT path and
          its EXACT named exports and signatures. Two developers working in parallel must be able
          to code against each other's modules from this contract alone, without reading each
          other's files.
       4. Every entryPoint MUST appear as a module whose `dependsOn` lists the modules it composes.
       5. Paths are relative to the repo root and use forward slashes. No path may contain the
          project slug or `generated-projects/`.
   </repo_contract>
   ```

2. In `<output_rules>` add: *"`repoContract.roots[].scripts` is frozen for the rest of the run. If you specify a
   build command, the pipeline will execute exactly that command and require it to produce artifacts in
   `buildOutputDir`."*

3. **Fix JSON mode for the Architect.** `agent-factory.ts:69` disables JSON mode whenever `cfg.tools.length > 0`,
   and `architect.agent.ts:11` passes `emitMermaidTool` — so the largest planning output in the system is the only
   one generated without JSON-mode constraints. Remove the tool: have the Architect return
   `architecture.mermaidDiagram` as a string (it already does — `ArchitectureDocSchema.mermaidDiagram`) and let
   `architectNode` write the diagram file itself via the same code path `emitMermaidTool` uses. Then
   `tools: []` and JSON mode applies. Verify `sanitizeMermaidLabels` is still called (`nodes.ts:39`).

---

## 4. Work item 3 — Materialise the contract into the workspace

New file `src/utils/repo-contract-writer.ts`:

```ts
/** Write the machine-readable contract and its human-readable rendering into the workspace. */
export function writeRepoContract(workspacePath: string, contract: RepoContract): { jsonPath: string; mdPath: string };

/** Read it back (used by QA, DevOps, the layout linter and maintain-mode runs). */
export function readRepoContract(workspacePath: string): RepoContract | null;

/** Compact prompt rendering, budgeted. Used in every agent context. */
export function renderContractForPrompt(contract: RepoContract, opts?: { moduleIds?: string[]; maxChars?: number }): string;
```

- `.agent/repo-contract.json` — canonical, machine-read. Put it under `.agent/` (new directory) so it is clearly
  pipeline metadata, and **add `.agent/` to the generated `.gitignore` block** in
  `src/utils/coding-conventions.ts` / wherever the `─── AgenticDevTeam (do not edit this block) ───` gitignore
  block is produced (see `generated-projects/pacman8/.gitignore` lines 1 and 43-44 for the existing pattern). The
  delivered product should not ship pipeline scaffolding — the same mistake `.conventions/` already made.
- `docs/ARCHITECTURE-CONTRACT.md` — human-readable, **committed** (it is genuine documentation): the layout, a
  directory tree, the module table with paths and exports, the naming convention.
- Called from `architectNode` right after the artifact is written, and re-written by `architectNode` on a HITL
  re-run.
- In **maintain mode**, `codebaseAnalyzerNode` must produce the contract by *inference* from the existing tree
  (roots, entry points, source/test dirs, scripts from the real `package.json`) and the Architect must extend
  rather than replace it. Add a `deriveContractFromAnalysis(analysis, workspacePath): RepoContract` helper.

`renderContractForPrompt` output, for a developer working on modules `MOD-GHOST-AI`, `MOD-GHOST-SPRITE`:

```
## Repo Contract (binding — do not deviate)
Layout: single-root
Root `.` (frontend/node): entry src/main.tsx | source src/, src/game/, src/ui/ | tests src/__tests__/
  build: `vite build` → dist/   test: `jest`
Naming: PascalCase components, camelCase utils.
Your modules:
  MOD-GHOST-AI  src/game/GhostAI.ts
    export function chooseTarget(ghost: Ghost, pac: PacMan, mode: Mode): Tile
    export const SCATTER_TARGETS: Record<GhostName, Tile>
    depends on: MOD-TYPES, MOD-MAZE
Modules you may import (do not modify):
  MOD-TYPES  src/game/types.ts   export interface Ghost { … }  export type Mode = …
  MOD-MAZE   src/game/Maze.ts    export class Maze { tileAt(x,y): Tile; isWall(t): boolean }
```

---

## 5. Work item 4 — The layout linter (mechanical enforcement)

New file `src/conductor/layout-lint.ts`:

```ts
export type LayoutViolationKind =
    | 'file-outside-source-dirs'
    | 'unknown-root'
    | 'duplicate-module'          // two paths implementing the same module id / same logical unit
    | 'module-path-mismatch'      // a declared module exists at a different path
    | 'missing-declared-export'
    | 'entrypoint-missing'
    | 'entrypoint-does-not-compose'  // entry point does not import the modules it must
    | 'test-outside-test-dirs'
    | 'cross-root-relative-import'   // e.g. packages/frontend importing ../../packages/backend/src/x
    | 'naming-violation';

export interface LayoutViolation { kind: LayoutViolationKind; severity: 'critical' | 'major' | 'minor'; path: string; detail: string; }

export function lintLayout(workspacePath: string, contract: RepoContract, opts?: { changedPaths?: string[] }): LayoutViolation[];
```

Implementation notes:

- Reuse `buildImportGraph(workspacePath)` from Sub-Plan 01/02 (exported from `product-verify.ts`) — do not write a
  third specifier extractor.
- `duplicate-module`: two files whose basename (case-insensitive, minus `use` prefix and extension) collide across
  different directories and both are imported by nothing shared — this is what would have caught
  `src/InputHandler.ts` vs `src/hooks/useInputHandler.ts` and `src/GameEngine.ts` vs `src/engine/GameEngine.ts`.
- `missing-declared-export`: regex the declared file for `export (function|class|const|interface|type|default)
  <name>` / `export { … name … }`. Cheap and sufficient.
- `entrypoint-does-not-compose`: for each root, the entry point's transitive import set must include every module
  whose `componentName` maps to a UI/route/service that the plan says is user-visible. Start narrow: require that
  the entry point transitively imports **at least one** module from every declared component. This is the check
  that catches `src/App.tsx` returning `<div>Pac-Man</div>` while 40 modules sit unimported, and
  `packages/backend/src/index.ts` never mounting the columns router.
- `severity`: `critical` for `unknown-root`, `entrypoint-missing`, `entrypoint-does-not-compose`,
  `cross-root-relative-import`, `duplicate-module`; `major` for the rest; `minor` for `naming-violation`.

### Where it runs

| Site | Scope | Effect |
|---|---|---|
| `pr-workflow.ts`, after the dev loop, before the gate | `changedPaths` = files touched on this branch | `critical` violations trigger a repair invocation (reuse the existing gate-repair loop, with the violation list as the prompt) and, if still present, block the PR |
| `qaNode`, after workspace sync | whole tree | violations become `Bug`s with stable ids `LAYOUT-<kind>-<path>` and feed the bugfix loop |
| `acceptanceNode` (Sub-Plan 03) | whole tree | any `critical` layout violation fails the `SCOPE` criterion |

Also: `dispatchDevelopers` should refuse to run a branch whose assignments reference module paths outside the
contract's `sourceDirs`, and instead log the mismatch as a planning defect — cheaper than discovering it after the
agent has written 20 files.

---

## 6. Work item 5 — Bind the rest of the pipeline to the contract

| Agent / node | Change |
|---|---|
| Product Manager | Inject `renderContractForPrompt(contract)` at `priority: 1`. Add to the prompt: *"Every task MUST name the module id(s) it implements, and every file path you mention MUST match the repo contract. Do NOT invent a directory layout."* Add `moduleIds: z.array(z.string()).default([])` to `TaskSchema` and validate them in Sub-Plan 04's `validateStoryPlan` (`unknown-module-ref` violation). |
| DBA | Inject the contract's backend root(s) so migrations land in the right directory. |
| Team Leader | Inject the contract. Prompt: *"Every assignment MUST list the module ids it owns (`moduleIds`) and those ids MUST come from the repo contract. Two assignments MUST NOT own the same module. Every module in the contract MUST be owned by exactly one assignment."* Add `moduleIds` to `AssignmentSchema` and add coverage rules `module-without-assignment` / `module-owned-twice` to Sub-Plan 04's `validateAssignmentPlan`. This also gives the dispatcher real file-ownership data for conflict avoidance (Sub-Plan 06). |
| Developer persona | Add a `<repo_contract>` block: *"The repo contract is authoritative. Create files ONLY at the paths declared for your modules. Import other modules ONLY via their declared paths and exports — those files may not exist yet; code against the signatures. Never create a second implementation of a module that already has a declared path. A layout linter checks this and blocks your PR."* |
| QA Lead / QA Unit | Inject the contract's `testDirs`, `scripts.test` and module list. `qa-unit`'s repeated failure was partly not knowing where to look (`run.log 16257-16259` searching `packages/backend/src` for code that lived in root `src/`). |
| DevOps | Inject roots, `buildOutputDir` and `entryPoints` so Dockerfiles reference real paths. |
| Codebase Analyzer | Emit `deriveContractFromAnalysis` output; extend `CodebaseAnalysis` schema with `repoContract`. |

---

## 7. Work item 6 — Contract-first scaffolding

Change the scaffold assignment's semantics: the scaffold branch must create, in one PR:

1. Every root's `package.json` with **exactly** the contract's `scripts`.
2. Every root's `tsconfig`/bundler config, `index.html`, and the `sourceDirs`/`testDirs` directory skeleton.
3. **Interface stubs for every declared module** — a file at each module's declared path exporting the declared
   symbols with the declared signatures and a `throw new Error('not implemented')` body (or a typed placeholder).

Item 3 is the highest-leverage change in this sub-plan: it means every subsequent parallel branch compiles against
real files, `findUnresolvedReferences` has nothing to report, and the four `packages/frontend` PRs that died in
conflicts would instead have edited pre-existing files. Add it to the team-leader prompt's `<integration_check>`
and to the scaffold assignment description template.

Consequence to handle: `NO DEAD CODE` in the dev persona (`persona.ts:74`) and the reviewers will object to
`not implemented` stubs. Add an explicit carve-out to both: *"Interface stubs created by the scaffold assignment
from the repo contract are expected and MUST NOT be reported as dead code. Replacing a stub body with a real
implementation is the job of the owning assignment."*

---

## 8. Config additions

```ts
/** Enforce the Architect's repo contract: 'off' | 'warn' | 'enforce'. */
export const REPO_CONTRACT_MODE = (process.env.REPO_CONTRACT_MODE ?? 'enforce') as 'off' | 'warn' | 'enforce';
/** Cap on declared modules (keeps the contract proportional). */
export const REPO_CONTRACT_MAX_MODULES = parseInt(process.env.REPO_CONTRACT_MAX_MODULES ?? '60', 10);
/** Create typed interface stubs for every declared module during scaffolding. */
export const CONTRACT_STUB_SCAFFOLD = (process.env.CONTRACT_STUB_SCAFFOLD ?? 'true') === 'true';
/** Char budget for the contract section injected into agent prompts. */
export const CONTRACT_PROMPT_MAX_CHARS = parseInt(process.env.CONTRACT_PROMPT_MAX_CHARS ?? '6000', 10);
```

---

## 9. Tests

`tests/repo-contract.test.ts`:

- `RepoContractSchema` accepts a minimal single-root contract and rejects one with an empty `entryPoints`,
  an `echo` build script (add a `.refine` that rejects `NO_OP_SCRIPT_RE` from Sub-Plan 02 — if 02 has not landed,
  duplicate the regex and leave a `// TODO: share with gate-integrity` note), or a path containing
  `generated-projects/`.
- `renderContractForPrompt` stays under `CONTRACT_PROMPT_MAX_CHARS` for a 60-module contract and always includes
  the owning modules in full.
- `writeRepoContract` / `readRepoContract` round-trip.
- `deriveContractFromAnalysis` on a fixture mirroring `generated-projects/retroboard3` yields
  `layout: 'npm-workspaces'` with 3 roots.

`tests/layout-lint.test.ts`, with fixtures under `tests/fixtures/layout/`:

| Fixture | Expected |
|---|---|
| `retro-split/` — contract says `npm-workspaces` with `packages/frontend/src`; tree also has root `src/components/Board.tsx` and root `src/server.ts` | ≥2 `file-outside-source-dirs`, 1 `entrypoint-missing` for `/src/main.tsx` |
| `pacman-duplicate/` — both `src/InputHandler.ts` and `src/hooks/useInputHandler.ts` | 1 `duplicate-module` |
| `pacman-stub-app/` — contract declares 12 modules; `src/App.tsx` imports none | 1 `entrypoint-does-not-compose` listing the unimported components |
| `missing-export/` — module declares `chooseTarget` but the file exports only `foo` | 1 `missing-declared-export` |
| `clean/` — a contract and a tree that match | zero violations |

---

## 10. Verification checklist

- [ ] `npx tsc --noEmit` clean; `npm run test:unit` green.
- [ ] `lintLayout` against `generated-projects/retroboard3` with a derived `npm-workspaces` contract reports the
      root-`src/` files and the missing `/src/main.tsx` entry point.
- [ ] `lintLayout` against `generated-projects/pacman8` with a derived contract reports
      `entrypoint-does-not-compose` (App.tsx composes nothing).
- [ ] The Architect agent has `tools: []` and JSON mode is active for it (add an assertion in
      `tests/agent-factory.test.ts` or equivalent).
- [ ] `.agent/` appears in the generated `.gitignore` block; `docs/ARCHITECTURE-CONTRACT.md` does **not**.
- [ ] `README.md` gains an "Architecture Contract" section; `AI_Context.md` gains the schema, the
      `layout-lint.ts` and `repo-contract-writer.ts` subsystems, and lists `repoContract` in the ProjectState table.

## 11. Out of scope

- Merge-conflict avoidance and branch scheduling → Sub-Plan 06 (it consumes `assignment.moduleIds` added here).
- Reviewer enforcement of the contract → Sub-Plan 07.
- Do not attempt full type-level contract verification (no `ts-morph`, no AST dependency). Regex + the import
  graph is the right cost/benefit here; `tsc --noEmit` from Sub-Plan 01 catches the rest.
