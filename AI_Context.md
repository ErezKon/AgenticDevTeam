# AI Context — AgenticDevTeam

> **Purpose of this file:** Provide AI sessions with deep project understanding so they can skip or reduce codebase analysis. This file is the authoritative reference for architecture, conventions, patterns, and rules that AI agents must follow when making changes.

---

## Rules for AI Sessions

1. **Read this file first.** Before making any changes, read this file and `README.md` to understand the project's architecture, conventions, and constraints.
2. **Maintain consistency.** All changes must follow the existing patterns, naming conventions, and architectural decisions documented here. Do not introduce new patterns without explicit user approval.
3. **Update context files.** If your changes alter the pipeline flow, add/remove agents, modify configuration, change schemas, or affect the architecture in any meaningful way, you **must** update this `AI_Context.md` and `README.md` to reflect those changes.
4. **Never break the pipeline.** The LangGraph state machine is the backbone. Changes to `state.ts`, `graph.ts`, or `nodes.ts` require understanding the full flow and how reducers merge state.
5. **Schema changes cascade.** Modifying a Zod schema in `src/agents/_shared/schemas/` affects every agent that uses it, the conductor nodes, and the tests. Trace all consumers before changing.
6. **Environment variables are the API.** All configuration is via `.env`. When adding a new config, add it to `src/config.ts`, `.env.example` (with documentation), and the README's Environment Variables table.
7. **Test what you change.** Run `npm run test:unit` for unit tests. Use `npm run test:greenfield` or `npm run test:maintain` for integration tests. The test timeout is 15 minutes due to LLM-heavy tests.
8. **Do not hardcode vendor-specific values.** The system is designed to work with any OpenAI-compatible LLM endpoint. All URLs, tokens, and model names come from environment variables.
9. **Never commit and push changes without explicit consent.** The user will review the changes and approve them, he will commit and push manually. Unless user specifically requests you to commit/push the changes.

---

## Project Overview

**AgenticDevTeam** is a fully autonomous software delivery pipeline powered by 20 specialized AI agents, orchestrated via a **LangGraph state machine**. It supports two run types:

- **Greenfield** -- Build a new project from scratch given a requirements document (Markdown, TXT, PDF, or DOCX).
- **Maintain** -- Analyze an existing codebase and apply changes, fixes, or new features.

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Orchestration | LangGraph (`StateGraph`, `Annotation`, conditional edges, HITL interrupts) |
| Agent Framework | LangChain (`createReactAgent`, `ChatOpenAI`, structured output) |
| GitHub Integration | Octokit REST + local bare-repo stand-in for offline mode |
| Schema Validation | Zod v4 (20+ schemas for all domain entities) |
| Runtime | Node.js 20+ with TypeScript (tsx, no build step in dev) |
| Container Management | Dockerode + Docker Compose |
| E2E Testing | Playwright MCP (Model Context Protocol) |
| Server | Express 5 + WebSocket (`ws`) |
| Dashboard | Angular 19 (standalone components) |
| Authentication | OAuth2 client-credentials flow with token caching |
| Logging | ANSI 256-color per-agent console logging + file capture |

### Entry Points

| Entry | Command | File |
|-------|---------|------|
| CLI | `npm run cli` | `src/cli.ts` |
| REST + WS Server | `npm start` | `src/index.ts` |
| Docker | `docker compose up --build` | `docker-compose.yml` |

---

## Directory Structure

```
AgenticDevTeam/
src/
  cli.ts                           # Interactive CLI (menu-driven)
  index.ts                         # Express REST + WebSocket server
  config.ts                        # All env-driven configuration (single source)
  env.ts                           # dotenv bootstrap (must be imported first)

  conductor/                       # LangGraph orchestration layer
    state.ts                       # ProjectState (Annotation + reducers)
    graph.ts                       # StateGraph wiring + conditional edges + HITL
    nodes.ts                       # 12 phase node functions (~1960 lines, largest file)
    run.ts                         # Autonomous & HITL run helpers + resume
    pr-workflow.ts                 # Full PR lifecycle orchestrator (~1392 lines)
    context-builder.ts             # Compact context summarizers with char budgets
    quality-gates.ts               # Multi-language build/lint/test gates
    security-gates.ts              # Secret scan + dependency audit + licence check
    workspace-sync.ts              # Git sync after squash merges
    assignment-policy.ts           # Prevent re-dispatch of completed assignments
    review-policy.ts               # Blocking severity + no-progress detection
    devops-verify.ts               # Real Docker build/run/health-check
    file-checkpointer.ts           # Persistent checkpoints for crash recovery

  agents/
    registry.ts                    # Master 20-agent registry (id, name, tag, color)
    _shared/
      agent-factory.ts             # buildAgent() wrapper for createReactAgent
      persona.ts                   # Developer prompt builder (rank/domain/languages)
      artifact.ts                  # Mission report writer (docs/agents/*.md)
      tool-loop-guard.ts           # Prevents infinite tool-call loops
      base-schemas.ts              # Barrel re-export of all schemas
      schemas/                     # 17 individual Zod schema files
        index.ts                   # Barrel export
        run-input.schema.ts        # RunInput, RepoTarget
        phase.schema.ts            # PhaseName union type
        architecture.schema.ts     # ArchitectureDoc, Component
        tech-stack.schema.ts       # TechDecision
        epic.schema.ts             # Epic
        user-story.schema.ts       # UserStory with acceptance criteria
        task.schema.ts             # Task (layer, suggestedTech)
        assignment.schema.ts       # Assignment (devAgentId, branchName, reviewers)
        file-change.schema.ts      # FileChange
        db-design.schema.ts        # DbDesign (entities, ERD)
        testing.schema.ts          # TestPlan, TestReport, TestCase
        bug.schema.ts              # Bug (severity, steps)
        devops-plan.schema.ts      # DevOpsPlan
        approval.schema.ts         # Approval (HITL)
        artifact-ref.schema.ts     # ArtifactRef
        transcript.schema.ts       # TranscriptMessage
        codebase-analysis.schema.ts# CodebaseAnalysis
        pr.schema.ts               # PullRequest, BranchAssignment
        git-context.schema.ts      # GitContext (token, owner, repo)
        token-usage.schema.ts      # TokenCallRecord

    codebase-analyzer/             # Maintain-mode codebase scanner
    architect/                     # System design + tech stack + epics
    product-manager/               # User stories + tasks
    dba/                           # Database design + ERD + migrations
    team-leader/                   # Task assignment + reviewer selection
    developers/
      registry.ts                  # 11 developer agent definitions
      dev-agent.builder.ts         # Developer agent constructor
      reviewer-agent.builder.ts    # Code reviewer agent constructor
      dispatcher.ts                # Branch-grouped fan-out + concurrency
      schemas/                     # dev-output.schema.ts, review-output.schema.ts
    qa/                            # QA Lead + Unit + E2E agents
    devops/                        # DevOps agent

  tools/
    fs/workspace-tools.ts          # Sandboxed read/write/edit/list/search (5 tools)
    git/git-tools.ts               # Git CLI tools (12 tools)
    git/github-tools.ts            # GitHub API tools via Octokit (6 tools)
    shell/shell-tools.ts           # Guarded shell execution (1 tool)
    diagram/diagram-tools.ts       # Mermaid diagram emission
    requirements/parse-requirements.ts  # .md/.txt/.pdf/.docx parser
    mcp/playwright-mcp.ts          # Playwright MCP client (singleton)

  executor/
    docker-runner.ts               # Dockerode build/run/healthcheck

  utils/
    logger.ts                      # Per-agent colored console + file logger
    oauth-auth.util.ts             # OAuth2 client-credentials token cache
    workspace.ts                   # Project workspace + output dir creation
    retry.ts                       # Exponential backoff + jitter for LLM calls
    llm-throttle.ts                # Global rate-limit protection (semaphore + cooldown)
    llm-cassette.ts                # Record/replay VCR for deterministic tests
    github-local.ts                # Local GitHub stand-in (bare git repo)
    github-repo-manager.ts         # GitHub repo create/validate/init
    run-budget.ts                  # Graceful degradation on budget limits
    structured-output.ts           # JSON extraction + Zod validation + repair
    event-bus.ts                   # Typed singleton event bus (12 event types)
    token-tracker.ts               # Token consumption tracker (singleton)
    token-callback.ts              # LangChain callback for token recording
    token-usage-extractor.ts       # Extract usage from AIMessage metadata
    token-report.ts                # HTML + JSON token usage report generator
    cost.ts                        # USD cost estimation per model
    run-snapshot.ts                # state.json + run-manifest.json writer
    git-exec.ts                    # Centralized git command execution
    coding-conventions.ts          # Convention file resolution + deployment
    traceability.ts                # Requirements traceability matrix
    codebase-analysis-writer.ts    # Write analysis markdown
    log-capture.util.ts            # stdout/stderr capture
    log-colors.util.ts             # ANSI 256-color codes

  templates/
    codebase-analysis.template.ts  # Markdown renderer for CodebaseAnalysis

  types/
    shims.d.ts                     # Module declarations (pdf-parse, mammoth)

dashboard/                         # Angular 19 standalone web UI
  src/app/
    app.component.ts               # Root shell with routing
    app.routes.ts                  # Dashboard + New Run routes
    pages/dashboard/               # Agent roster + live event feed
    pages/new-run/                 # Start run form
    services/api.service.ts        # HTTP + WebSocket client

tests/                             # Jest test suite (ts-jest)
  setup.ts                         # Polyfill crypto, load env, validate vars
  utils.ts                         # Spec discovery helpers
  *.test.ts                        # 25+ test files

Plans/                             # 17 historical plan documents (01-16.1)
specs/
  new/                             # Greenfield requirement specs (e.g. pacman.md)
  existing/                        # Maintain-mode specs (e.g. scientific-calculator.txt)

generated-projects/                # Output directory for generated codebases
outputs/                           # Run logs, state snapshots, token reports
```

---

## Pipeline Flow (Phase by Phase)

### Phase Sequence

```
intake -> [codebase-analyzer] -> architect -> product-manager -> dba -> team-leader
       -> development (fan-out) -> qa -> [bugfix-triage -> development]*
       -> devops -> e2e -> finalize
```

- `[codebase-analyzer]` only runs in maintain mode.
- `[bugfix-triage -> development]*` loops up to `MAX_BUGFIX_ITERATIONS` (default 3).
- E2E bugfix looping is disabled by default (`E2E_BUGFIX_ENABLED=false`).

### Phase Details

| # | Phase | Node Function | What It Does |
|---|-------|--------------|-------------|
| 1 | **Intake** | `intakeNode` | Parse requirements, create workspace/output dirs, resolve git context, create/checkout system branch (`project/<slug>`), initialize token tracking |
| 1b | **Codebase Analyzer** | `codebaseAnalyzerNode` | (Maintain only) Scan existing project with read-only tools, produce `CodebaseAnalysis`, write `docs/codebase-analysis.md` |
| 2 | **Architect** | `architectNode` | Analyze requirements, produce architecture doc, component list, tech stack decisions, epics, and Mermaid diagram |
| 3 | **Product Manager** | `productManagerNode` | Convert architecture + epics into user stories (with acceptance criteria) and granular tasks |
| 4 | **DBA** | `dbaNode` | Design database entities, relationships, indexes, migration scripts, ERD diagram |
| 5 | **Team Leader** | `teamLeaderNode` | Assign tasks to developers with rank-based reviewer selection, branch naming, dependencies |
| 6 | **Development** | `developmentNode` | Fan-out assignments to dev agents via `dispatchDevelopers` with topological sorting and concurrency control. Each branch goes through the full PR workflow |
| 7 | **QA** | `qaNode` | QA Lead creates test plan -> QA Unit writes & runs tests -> Quality gates (deterministic build/lint/test) -> Security gates (secrets, deps, licences) -> AC coverage gate |
| 8 | **Bug-fix Triage** | `bugfixTriageNode` | Team Leader re-assigns critical/major bugs; namespaced IDs prevent collision |
| 9 | **DevOps** | `devopsNode` | Generate Dockerfiles, compose, K8s manifests; optionally build/run/health-check via `devops-verify` |
| 9b | **E2E** | `e2eNode` | Playwright MCP browser tests against running services (only if DevOps produced service URLs) |
| 10 | **Finalize** | `finalizeNode` | Tear down containers, write summary, token report (HTML + JSON), traceability matrix, state snapshot, run manifest |

### Conditional Routing (graph.ts)

- **afterIntakeRouter**: `maintain` -> `codebase-analyzer`, `greenfield` -> `architect`
- **rerunRouter**: Each HITL phase can loop back to itself when user selects "enhance"
- **afterQaRouter**: Test failures + iterations remaining -> `bugfix-triage`, else -> `devops`
- **afterE2eRouter**: E2E failures + `E2E_BUGFIX_ENABLED` + iterations remaining -> `bugfix-triage`, else -> `finalize`
- **cancel routing**: Any phase can route to `finalize` when `state.cancelled === true`

---

## Agent Architecture

### Agent Categories and Tool Access

| Category | Agents | Tools | Model Tier |
|----------|--------|-------|------------|
| **Analysis** | Codebase Analyzer | Read-only workspace (read_file, list_dir, search_code) | `CODEBASE_ANALYZER_MODEL` |
| **Management** | Architect | emit_mermaid only | `ARCHITECT_MODEL` |
| | Product Manager | None (planning-only) | `PRODUCT_MANAGER_MODEL` |
| | DBA | None (planning-only) | `DBA_MODEL` |
| | Team Leader | None (planning-only) | `TEAM_LEADER_MODEL` |
| **Development** | 11 dev agents | Workspace (fs) + Git + Shell | Rank-based model |
| | Dev reviewers | Read-only Git subset (6 tools) | Same as dev agent |
| **QA** | QA Lead | None (planning-only) | `QA_MODEL` |
| | QA Unit | Workspace (fs) + Shell | `QA_MODEL` |
| | QA E2E | Playwright MCP tools | `QA_MODEL` |
| **Operations** | DevOps | Workspace (fs) + Shell | `DEVOPS_MODEL` |

### Developer Agents (11)

| Agent ID | Rank | Domain | Languages | Model Config |
|----------|------|--------|-----------|-------------|
| `principal-frontend` | Principal | Frontend | Angular, React, Vue, Svelte, TypeScript, HTML/CSS, Tailwind, SASS | `PRINCIPAL_DEV_MODEL` |
| `principal-backend` | Principal | Backend | C#/.NET, Java/Spring, Go, Python/FastAPI/Django, Node.js/Express | `PRINCIPAL_DEV_MODEL` |
| `senior-frontend` | Senior | Frontend | Angular, React, Vue | `SENIOR_DEV_MODEL` |
| `senior-backend` | Senior | Backend | C#/.NET, Java/Spring, Python, Go | `SENIOR_DEV_MODEL` |
| `junior-angular` | Junior | Frontend | Angular | `JUNIOR_DEV_MODEL` |
| `junior-react` | Junior | Frontend | React | `JUNIOR_DEV_MODEL` |
| `junior-vue` | Junior | Frontend | Vue.js | `JUNIOR_DEV_MODEL` |
| `junior-csharp` | Junior | Backend | C#/.NET | `JUNIOR_DEV_MODEL` |
| `junior-java` | Junior | Backend | Java/Spring | `JUNIOR_DEV_MODEL` |
| `junior-go` | Junior | Backend | Go | `JUNIOR_DEV_MODEL` |
| `junior-python` | Junior | Backend | Python | `JUNIOR_DEV_MODEL` |

### Review Rules (Hierarchical)

| Developer Rank | Reviewed By |
|---------------|-------------|
| Junior | 2 Senior developers |
| Senior | 2 Principal developers |
| Principal | 2 other Principal developers |

### Agent Factory Pattern

All agents are built via `buildAgent()` in `src/agents/_shared/agent-factory.ts`:

1. Creates a `ChatOpenAI` instance with the configured model, temperature, and OAuth-wrapped fetch
2. Appends the JSON schema instruction to the system prompt if `responseFormat` is provided
3. Wraps all tools with `withLoopGuard()` for infinite-loop prevention
4. Returns a `createReactAgent()` instance with its own `MemorySaver`

The fetch chain is: `oauthFetch` -> `cassetteFetch` (if recording/replaying) -> `throttledFetch`

---

## State Management (ProjectState)

The `ProjectState` in `src/conductor/state.ts` is a LangGraph `Annotation.Root` with typed fields and merge reducers:

### Reducer Types

| Type | Behavior | Fields Using It |
|------|---------|----------------|
| **Append** | `existing.concat(incoming)` | epics, techStack, userStories, tasks, assignments, completedAssignmentIds, fileChanges, testReports, bugs, fixedBugIds, pullRequests, branchAssignments, approvals, artifacts, transcript, tokenUsage |
| **Replace** | `incoming` (last-write wins) | input, workspacePath, outputPath, systemBranch, gitContext, codebaseAnalysis, architecture, dbDesign, testPlan, devopsPlan, runningContainers, phase, iteration, pendingRerun, cancelled |
| **Custom merge** | Deep-merge with array concatenation | phaseFeedback |

### Key State Fields

- `input: RunInput` -- System name, requirements, mode, runType, existingProjectPath, repoTarget
- `workspacePath` / `outputPath` -- Set once during intake
- `systemBranch` -- `project/<slug>` branch name
- `gitContext: GitContext` -- Token, owner, repo, defaultBranch for git operations
- `phase: PhaseName` -- Current pipeline phase
- `iteration: { bugfix: number }` -- Bug-fix loop counter
- `pendingRerun: PhaseName | null` -- Set when HITL "enhance" is requested
- `phaseFeedback: Record<string, string[]>` -- Accumulated user feedback per phase
- `cancelled: boolean` -- Set on HITL "deny"

---

## PR Workflow (pr-workflow.ts)

The development phase uses a sophisticated PR workflow for each branch:

1. **Worktree creation** -- `git worktree add .worktrees/<branch>` for parallel isolation
2. **Dev agent invocation** -- Agent writes code with TDD (tests first), commits with conventional format
3. **Quality gates** -- Deterministic build/lint/test verification
4. **Quality gate repair** -- If gates fail, re-invoke dev agent with error output (up to `PR_TEST_REPAIR_ATTEMPTS`)
5. **Security gate** (optional) -- Secret scan before PR
6. **PR creation** -- Via Octokit or curl fallback
7. **Review loop** -- Sequential per-reviewer; each reviewer sees code after previous fixes
8. **Fix cycle** -- Dev agent fixes review comments; no-progress detection after 2 unchanged iterations
9. **Escalation** -- Unresolved CRITICALs escalate to higher-rank dev agent
10. **Merge** -- Rebase onto base branch, squash merge, delete remote branch
11. **Worktree cleanup** -- Always in `finally` block

### Git Branching Strategy

- **System branch**: `project/<system-slug>` (all feature branches target this)
- **Feature branches**: `<project-slug>/feature/<story-slug>` (one branch per user story)
- **Scaffold branch**: `<project-slug>/chore/scaffold`
- **Commit format**: `[project-slug]-[STORY-ID]-TYPE: description` (feat, fix, test, refactor, chore)

---

## Key Subsystems

### Tool Loop Guard (`tool-loop-guard.ts`)

Prevents agents from infinite tool-call loops:
- Tracks total invocations per `toolName::args` key
- **Read-only tools** (read_file, list_dir, search_code, git tools) cache results; duplicates return `[CACHED]`
- **Mutating tools** (write_file, edit_file, etc.) clear all caches (workspace changed)
- 3rd identical call "poisons" ALL tools with a JSON error message
- Total ceiling: `maxToolCalls` (default 22, configurable per agent rank)

### LLM Throttle (`llm-throttle.ts`)

Process-wide rate-limit protection:
- **Concurrency semaphore**: `LLM_MAX_CONCURRENT_REQUESTS` (default 2)
- **Request spacing**: `LLM_MIN_REQUEST_INTERVAL_MS` (default 400ms), adaptive increase on 429
- **Global cooldown**: Exponential backoff on 429 (5s base, 90s max, +/-25% jitter)
- **Adaptive decay**: After 20 consecutive successes, interval decreases

### LLM Cassettes (`llm-cassette.ts`)

Record/replay VCR for deterministic offline testing:
- **Record**: Capture LLM HTTP responses to `tests/cassettes/<name>.jsonl`
- **Replay**: Serve responses from cassette (no network, OAuth skipped)
- JSONL format, redacted headers/tokens, stable SHA-256 keys
- `LLM_CASSETTE_ON_MISS`: `strict` (throw) or `passthrough` (call real LLM)

### Local GitHub Stand-in (`github-local.ts`)

Fully offline GitHub replacement backed by a bare git repo:
- Real squash merges via scratch clone + `git merge --squash`
- Monotonic PR numbers persisted in git config
- Activated by `GITHUB_MODE=local`

### Context Builder (`context-builder.ts`)

Replaces raw `JSON.stringify` dumps with compact summaries:
- Priority system: 1 = never clip, 2 = clip last, 3 = clip first
- Hard character budget per prompt: `CONTEXT_MAX_CHARS` (default 24000)
- Pure functions, fully unit-testable

### Run Budget (`run-budget.ts`)

Graceful degradation on budget limits:
- **ok/warn**: Full config limits
- **degrade**: 1 review iteration, 1 reviewer, 0 repair attempts, 0 bugfix iterations
- **stop**: No new branch workflows
- Three limits: `MAX_RUN_TOKENS`, `MAX_RUN_COST_USD`, `MAX_RUN_WALL_MS`

### Quality Gates (`quality-gates.ts`)

Multi-language deterministic verification:
- **7 stacks**: Node, Maven, Gradle, Go, Python, .NET, Rust
- **5 steps**: install, typecheck, build, lint, test
- **Multi-root detection** (`detectStackRoots`): walks up to `QUALITY_GATE_SCAN_DEPTH` levels deep, prunes
  `node_modules`/`.git`/`dist`/etc., npm-workspace-aware (tags `isWorkspaceMember`)
- **Script resolver** for Node: reads `package.json` scripts and resolves to `real`/`fallback`/`absent` mode —
  no more `--if-present` (a missing build script is now a real failure, not a silent pass)
- **Honest aggregation**: `passed = executed.length > 0 && executed.every(r => r.passed)`;
  all-skipped or absent-required-step reports are `inconclusive`, not passing
- `QUALITY_GATE_STRICT_TOOLCHAIN` defaults to `true` (missing toolchain = failure)
- Synthesizes bugs with stable IDs for deduplication
- `gateReportToTestReport` never returns `null` — returns `status: 'inconclusive'` for unverifiable reports

### Product Verification (`product-verify.ts`)

Three checks that verify the generated product actually works:
- **Artifact check** (`verifyBuildArtifacts`): confirms build produced real output in `dist/`/`build/` etc.;
  catches `"build": "echo Build successful"` (exits 0, no artifacts = failure)
- **Import resolution** (`findUnresolvedReferences`): static analysis of all source files for broken imports,
  missing CSS, absent HTML `src`/`href` targets, and undeclared npm packages
- **Smoke test** (`runSmokeTest`): inline static file server serves built artifacts, verifies HTTP 200 and that
  sub-resources resolve; no external dependencies (no Playwright)
- Wired into PR workflow (artifacts+resolve only) and QA node (full mode with smoke)
- Synthesises `PRODUCT-ARTIFACTS-*`, `PRODUCT-RESOLVE`, and `PRODUCT-SMOKE` bugs

### Gate Integrity (`gate-integrity.ts`) — Sub-Plan 02

Prevents agents from gaming quality gates instead of fixing code. Three layers:

1. **Config baseline & tamper detection** — `captureConfigBaseline()` snapshots package.json scripts,
   dependencies, test files, and counts before and after the dev agent runs. `detectTampering()`
   compares the two baselines and flags tampering:
   - `script-neutered` / `script-removed` / `script-weakened` (critical/major)
   - `deps-removed`, `workspaces-removed`, `test-file-deleted`, `test-count-reduced`, `test-skipped`
   - `typecheck-weakened`, `lint-weakened`, `gitignore-widened`

2. **Trivial test detection** — `detectTrivialTests()` builds an import graph from product source
   files and entry points, then flags test files whose subject is not reachable from any entry point
   (`subject-not-in-product`), tests with tautological assertions, or single-arithmetic tests.

3. **Protected paths** — `workspace-tools.ts` supports a `protectionMode` option (`off`/`warn`/`deny`)
   that blocks writes to config files during repair loops. `shell-tools.ts` denies shell commands that
   would modify package.json, revert config via git, or delete test files.

Key env vars: `GATE_INTEGRITY_MODE` (off/warn/enforce), `FS_CONFIG_PROTECTION` (off/warn/deny),
`REJECT_TRIVIAL_TESTS` (true/false).

### Security Gates (`security-gates.ts`)

Three checks combined:
- **Secret scan**: Regex patterns for AWS keys, private keys, GitHub tokens, JWTs, generic secrets
- **Dependency audit**: Per-stack (npm audit, pip-audit, govulncheck, etc.)
- **Licence check**: SPDX deny-list for npm packages
- Never logs matched values (redaction discipline)

### Structured Output (`structured-output.ts`)

Robust JSON extraction from LLM responses:
1. Direct `JSON.parse`
2. Code fence extraction (```json ... ```)
3. Balanced braces extraction
4. Zod validation with repair loop (re-invoke agent with issue summary)

---

## Run Modes

### Autonomous (`RUN_MODE=autonomous`)
Full pipeline executes start-to-finish without human intervention.

### Human-in-the-Loop (`RUN_MODE=human`)
Pipeline pauses before each HITL phase. User can:
- **Approve** -- Continue to next phase
- **Deny** -- Cancel the run (routes to finalize)
- **Enhance** -- Provide feedback; phase re-runs with feedback injected into prompt

HITL interrupt phases: `codebase-analyzer`, `architect`, `product-manager`, `dba`, `team-leader`, `development`, `qa`, `devops`, `e2e`

---

## GitHub Modes

### Live (`GITHUB_MODE=live`)
Uses real GitHub REST API via Octokit. Requires `GITHUB_TOKEN` with `repo` scope.

### Local (`GITHUB_MODE=local`)
Uses local bare git repo as GitHub stand-in. No PAT required. Ideal for offline/testing.
- Bare repo created at `outputs/<run>/origin.git`
- Real squash merges via scratch clone

---

## Multi-Repo Project Targeting

Greenfield projects can be hosted in:
1. **Same repository** (default) -- Project lives inside `generated-projects/`
2. **New GitHub repository** -- Creates repo under `GITHUB_PROJECT_OWNER`
3. **Existing GitHub repository** -- Pushes code to an existing repo

Separate tokens: `GITHUB_PROJECT_TOKEN` / `GITHUB_PROJECT_OWNER` (fall back to `GITHUB_TOKEN` / `GITHUB_OWNER`).

---

## Output Artifacts

### Per Run (`outputs/<system-name>-<timestamp>/`)
- `run.log` -- Full console log (ANSI stripped)
- `state.json` -- Redacted final ProjectState snapshot
- `run-manifest.json` -- Comprehensive run summary with counts, budget, traceability
- `token-usage.json` -- Raw token consumption data
- `token-usage-report.html` -- Interactive HTML report with Chart.js charts
- `traceability.md` -- Requirements traceability matrix
- `codebase-analysis.md` -- (Maintain mode) Snapshot of codebase analysis
- `checkpoints.json` -- (If `CHECKPOINT_PERSIST=true`) LangGraph checkpoints

### Per Project (`generated-projects/<name>/` or existing project)
- `docs/agents/*.md` -- Mission reports from each agent
- `docs/codebase-analysis.md` -- (Maintain mode) Persistent analysis
- Application source code, tests, Dockerfiles, K8s manifests

---

## Testing

### Test Commands

| Command | Scope |
|---------|-------|
| `npm test` | All tests (15-min timeout) |
| `npm run test:unit` | Unit tests only (excludes greenfield/maintain/replay) |
| `npm run test:greenfield` | Greenfield integration test |
| `npm run test:maintain` | Maintain-mode integration test |
| `npm run test:replay` | Cassette replay test |
| `npm run test:oauth` | OAuth integration test |

### Test Infrastructure
- **Framework**: Jest with ts-jest
- **Setup**: `tests/setup.ts` -- Polyfills crypto, loads env, validates required vars
- **Timeout**: 900,000ms (15 min) for LLM-heavy integration tests
- **Transform**: Handles ESM packages (`@octokit`, `universal-user-agent`, `before-after-hook`)

### Cassette Recording
```bash
# Record a cassette
LLM_CASSETTE_MODE=record CASSETTE_NAME=my-run GITHUB_MODE=local npm run cli

# Replay tests
npm run test:replay
```

---

## Coding Patterns & Conventions

### Adding a New Agent

1. Create agent directory under `src/agents/<name>/`
2. Create `<name>.prompt.ts` with XML-tagged system prompt (include `<maintain_mode>` section)
3. Create `<name>.agent.ts` with factory function using `buildAgent()`
4. Create `schemas/<name>-output.schema.ts` with Zod output schema composing shared schemas
5. Add agent to `src/agents/registry.ts` with unique ID, name, tag, color code, and category
6. Add node function to `src/conductor/nodes.ts`
7. Wire into the graph in `src/conductor/graph.ts`
8. Add model config to `src/config.ts` and `.env.example`
9. Update `README.md` Agent Roster and this file

### Adding a New Developer Agent

1. Add entry to `src/agents/developers/registry.ts` with rank, domain, languages, tag, color, temperature
2. The agent is auto-registered into the master registry and available for team leader assignment
3. No prompt file needed -- `buildDevPersona()` generates it from registry data

### Adding a New Tool

1. Create tool in `src/tools/<category>/`
2. Tools must be LangChain `StructuredToolInterface` instances (use `tool()` from `@langchain/core/tools`)
3. Workspace tools must use `resolveWorkspacePath()` for path sandboxing
4. Wire into the relevant agent factory function

### Adding a New Schema

1. Create `src/agents/_shared/schemas/<name>.schema.ts`
2. Export from `src/agents/_shared/schemas/index.ts`
3. Add field to `ProjectState` in `src/conductor/state.ts` with appropriate reducer (append or replace)

### Adding a New Environment Variable

1. Add to `src/config.ts` with `process.env` reading and default value
2. Add to `.env.example` with documentation comment
3. Add to README.md Environment Variables table
4. Update this file if it affects architecture or flow

### System Prompt Conventions

All agent prompts use XML-style tags for structure:
- `<identity>` -- Agent role and responsibilities
- `<mission>` -- What the agent must produce
- `<critical_rules>` -- Hard constraints
- `<workflow>` -- Step-by-step process
- `<output_rules>` -- Output format requirements
- `<maintain_mode>` -- Behavior when working on existing codebases
- `<proportionality>` -- (Architect) Avoid over-engineering
- `<tdd_rules>` -- (Developers) Test-driven development
- `<git_workflow>` -- (Developers) Branch/commit/push conventions
- `<coding_conventions>` -- Convention file read instructions

### Node Function Pattern

Every node function in `nodes.ts` follows this pattern:
```typescript
export async function someNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    emitRunEvent('phase:start', { phase: 'some-phase' });
    const rerunUpdate = checkRerun(state, 'some-phase', logger);
    // ... get API key, create agent, build context ...
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, ...);
    // ... write artifact, commit/push ...
    emitRunEvent('phase:end', { phase: 'some-phase', nextPhase: '...' });
    return {
        ...rerunUpdate,
        // ... state updates with correct reducer semantics ...
        phase: 'next-phase' as PhaseName,
        artifacts: [artifact],
        transcript: [msg(...)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
}
```

### Error Handling

- `retryWithBackoff()` wraps all agent invocations (rate-limit aware, configurable attempts)
- Node functions catch agent failures and log errors but generally don't crash the pipeline
- `invokeAgent()` includes schema validation with repair loop
- `run.ts` catches crashes and writes best-effort state snapshots
- Signal handlers flush token reports on unexpected exits

---

## Historical Plans (Plans/ Directory)

The system evolved through 16+ iteration plans. Key milestones:

| Plan | Feature |
|------|---------|
| 01 | Initial multi-agent architecture |
| 02 | Maintain mode (existing codebases) |
| 04 | Git branching, PR reviews, TDD |
| 07 | Git worktree isolation |
| 10 | PR lifecycle improvements, escalation |
| 11 | Token monitoring and reporting |
| 12 | Multi-repo project targeting |
| 13 | Tool loop guard |
| 14 | Pipeline stability, rate limiting, quality gates |
| 15 | Coding conventions integration |
| 16 | Correctness, verification, cost, observability, offline determinism |

When referenced in code comments, these plans are cited as "fixes A1", "fixes A2", etc. (referring to sub-plans within Plan 16).

---

## Common Gotchas

1. **`env.ts` must be imported first** -- Before any module that reads `process.env`. Uses `override: true` so `.env` wins over shell vars.
2. **Append vs Replace reducers** -- Arrays use append (data accumulates); scalars/objects use replace (last write wins). Returning `[]` for an append field adds nothing, not clears it.
3. **Agent recursion limits differ by type** -- Pipeline agents: 15, tool-using pipeline agents: 60, dev agents: 50, reviewers: 26.
4. **Max tool calls differ by rank** -- Principal: 40, Senior: 35, Junior: 30, Reviewer: 8.
5. **`git_diff` was removed from reviewer tools** -- It showed empty results for committed code and caused llama-3-3-70b-instruct to loop. Use `git_merge_base_diff` instead.
6. **`emitMermaidTool` removed from dev agents** -- Caused infinite loops. Only the Architect has it.
7. **Worktree cleanup is critical** -- Stale worktrees break subsequent runs. Intake prunes them.
8. **SSL workaround** -- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set globally for corporate environments with self-signed certs.
9. **Dockerfiles are patched for SSL** -- `patchDockerfilesSsl()` injects `npm config set strict-ssl false` before npm commands.
10. **`GITHUB_MODE=local`** creates a bare repo under the run output directory and patches `origin` to point there.
