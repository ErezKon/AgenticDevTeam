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
| Agent Framework | LangChain (`createAgent` + middleware, multi-provider: `ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI`, structured output) |
| GitHub Integration | Octokit REST + local bare-repo stand-in for offline mode |
| Schema Validation | Zod v4 (20+ schemas for all domain entities) |
| Runtime | Node.js 20+ with TypeScript (tsx, no build step in dev) |
| Container Management | Dockerode + Docker Compose |
| E2E Testing | Playwright MCP (Model Context Protocol) |
| Server | Express 5 + WebSocket (`ws`) |
| Dashboard | Angular 19 (standalone components) |
| Authentication | Direct API keys (OpenAI, Anthropic, Google) with OAuth2 client-credentials fallback for OpenAI |
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
    assignment-policy.ts           # Prevent re-dispatch of completed assignments + sanitizeAssignmentStoryIds
    review-policy.ts               # Fail-closed review: ReviewOutcome, decideMerge, escalation, quorum (Sub-Plan 07)
    devops-verify.ts               # Real Docker build/run/health-check
    file-checkpointer.ts           # Persistent checkpoints for crash recovery

  agents/
    registry.ts                    # Master 20-agent registry (id, name, tag, color)
    _shared/
      agent-factory.ts             # buildAgent() wrapper for createAgent
      llm-provider.ts              # Multi-provider LLM factory (OpenAI, Anthropic, Google)
      history-compactor.ts         # ReAct history compaction + streaming-residue sanitiser
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
        bug.schema.ts              # Bug (severity, steps, optional storyId)
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
    token-callback.ts              # LangChain callback for token recording (two-tier provider lookup)
    token-usage-extractor.ts       # Shared usage normalisation (normaliseUsage/sumUsageMetadata) + per-invocation aggregation
    token-report.ts                # HTML + JSON token usage report generator
    cost.ts                        # USD cost estimation per model
    run-snapshot.ts                # state.json + run-manifest.json writer
    git-exec.ts                    # Centralized git command execution (signal/exit-code diagnostics, network timeouts)
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
  *.test.ts                        # 70+ test files

Plans/                             # Historical plan documents (01 … 21) + implementation reports
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
- E2E bugfix looping is enabled by default (`E2E_BUGFIX_ENABLED=true`; was `false` pre-Plan-19-11).

### Phase Details

| # | Phase | Node Function | What It Does |
|---|-------|--------------|-------------|
| 1 | **Intake** | `intakeNode` | Parse requirements, create workspace/output dirs, resolve git context, create/checkout system branch (`project/<slug>`), initialize token tracking |
| 1b | **Codebase Analyzer** | `codebaseAnalyzerNode` | (Maintain only) Scan existing project with read-only tools, produce `CodebaseAnalysis`, write `docs/codebase-analysis.md` |
| 2 | **Architect** | `architectNode` | Analyze requirements, produce architecture doc, component list, tech stack decisions, epics, and Mermaid diagram |
| 3 | **Product Manager** | `productManagerNode` | Convert architecture + epics into user stories (with acceptance criteria) and granular tasks |
| 4 | **DBA** | `dbaNode` | Design database entities, relationships, indexes, migration scripts, ERD diagram |
| 5 | **Team Leader** | `teamLeaderNode` | Assign tasks to developers with rank-based reviewer selection, branch naming, dependencies |
| 6 | **Development** | `developmentNode` | Fan-out assignments to dev agents via `dispatchDevelopers` with topological sorting and concurrency control. Each branch goes through the full PR workflow. Appends one `DispatchRound` to `state.dispatchRounds` counting **merged** PRs only, so `detectUnrecoverable()` can see a zero-output round |
| 7 | **QA** | `qaNode` | QA Lead creates test plan -> QA Unit writes tests -> **Real test runner** parses runner output (authoritative signal; agent self-report is advisory) -> Test sufficiency gate (min counts, coverage floor, per-story coverage) -> Quality gates (deterministic build/lint/test) -> Security gates (secrets, deps, licences) -> AC coverage gate. QA crash synthesises a bug; testReports is never empty after qaNode. |
| 8 | **Bug-fix Triage** | `bugfixTriageNode` | Runs `detectUnrecoverable()` first (halts the QA→triage→dev loop under `RUN_FAIL_POLICY=halt`); Team Leader re-assigns critical/major bugs; namespaced IDs prevent collision; `sanitizeAssignmentStoryIds()` guarantees every `storyId` references a real user story |
| 9 | **DevOps** | `devopsNode` | Generate Dockerfiles, compose, K8s manifests; fallback Dockerfile generator when agent fails (`DEVOPS_FALLBACK_ENABLED`); always overwrite agent claims with `verifyDeployment` result; synthesise `DEPLOY-BUILD-FAILED`/`DEPLOY-UNHEALTHY` bugs |
| 9b | **E2E** | `e2eNode` | Playwright MCP browser tests with preflight check. `e2eStatus` state channel: `passed`/`failed`/`skipped-no-services`/`error`. Falls back to `runSmokeTest` when Playwright unavailable or no Docker services but a web root exists (`E2E_ALLOW_LOCAL_SERVER`). Catch path synthesises `E2E-INFRA-FAILED` bug. |
| 10 | **Finalize** | `finalizeNode` | Tear down containers, write summary, token report (HTML + JSON), traceability matrix, state snapshot, run manifest |

### Conditional Routing (graph.ts)

- **afterIntakeRouter**: `maintain` -> `codebase-analyzer`, `greenfield` -> `architect`
- **rerunRouter**: Each HITL phase can loop back to itself when user selects "enhance"
- **afterQaRouter**: Test failures + iterations remaining -> `bugfix-triage`, else -> `devops`
- **afterE2eRouter**: E2E failures (type=e2e, source=executed, current iteration) + `E2E_BUGFIX_ENABLED` + iterations remaining -> `bugfix-triage`, else -> `acceptance-gate`
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

1. Detects the LLM provider from the model name via `detectProvider()` in `src/agents/_shared/llm-provider.ts`
2. Creates the appropriate chat model via `createChatModel()`:
   - **OpenAI** (default, covers `gpt-*`, `o1-*`, `llama-*`, `mistral-*`, `gemma-*`): `ChatOpenAI` with `OPENAI_API_KEY` (direct) or OAuth-wrapped fetch chain (fallback)
   - **Anthropic** (model matches `/claude|anthropic/i`): `ChatAnthropic` with `ANTHROPIC_API_KEY`
   - **Google** (model matches `/gemini/i`): `ChatGoogleGenerativeAI` with `GOOGLE_API_KEY`
3. Appends the JSON schema instruction to the system prompt if `responseFormat` is provided
4. Wraps all tools with `withLoopGuard()` for infinite-loop prevention
5. Returns a `createAgent()` instance with its own `MemorySaver` and a `history-compaction` middleware

### Provider Transport Invariants (Plan 21)

These are load-bearing. Changing any of them reintroduces a failure mode that is silent, total, and billable.

| Invariant | Where | Why |
|-----------|-------|-----|
| `ChatAnthropic` is created **with** `streaming: true` + A2 sanitiser guard | `llm-provider.ts` | Anthropic's HTTP endpoint times out after ~10 minutes on non-streaming requests, killing long agent runs. Streaming residue (`input_json_delta`, id-less `tool_use`) is stripped by `sanitizeStreamingContentBlocks()` before every LLM call. Token accounting for streaming uses the `usage_metadata` fallback (D's two-tier lookup). |
| Adaptive-only Anthropic models omit `temperature`/`topK`/`topP` | `llm-provider.ts` | `claude-opus-4-7+`, `claude-opus-5+`, `claude-sonnet-5+`, `claude-fable-5+`, `claude-mythos-*` reject non-default sampling params. The regex is a deliberate **superset** of `ADAPTIVE_ONLY_MODEL_PREFIXES` in `@langchain/anthropic` and must **not** be narrowed to match it — the SDK list lags the API (it still omits `claude-sonnet-5` as of `1.5.6`, so the SDK sends `temperature` and the API returns `400 "temperature is deprecated for this model"`). Add new model families here as Anthropic ships them, without waiting for the SDK. |
| JSON mode uses `model.withConfig({ response_format })`, **never** `modelKwargs` | `llm-provider.ts` | `modelKwargs` is spread verbatim into the request body. `*codex*` / `gpt-5.x-pro` route through the OpenAI **Responses API**, which rejects top-level `response_format`. `withConfig` lets LangChain emit `response_format` (Chat Completions) or `text.format` (Responses). |
| `sanitizeStreamingContentBlocks()` runs before `compactHistory()` on every call | `history-compactor.ts`, wired in `agent-factory.ts` | Defence-in-depth against corrupt histories, including ones restored from a checkpoint written by an older provider package. Operates on a copy; `tool_calls` is untouched (the adapter re-materialises `tool_use` blocks from it). Flag: `SANITIZE_STREAM_BLOCKS`. |
| `handleLLMEnd` reads `llmOutput.{tokenUsage,token_usage,usage,estimatedTokenUsage}`, then falls back to `generations[].message.usage_metadata` | `token-callback.ts` + `token-usage-extractor.ts` | No single field covers every transport. Reading only tier 1 recorded 5 token records for a 60+ call run, silently disabling `MAX_RUN_COST_USD`. Tier 1 wins when present, so nothing is double-counted. Both paths share `normaliseUsage` / `sumUsageMetadata`. |
| `AgentConfig.topP` / `topK` are forwarded to `createChatModel()` | `agent-factory.ts` | They were accepted by 10 agent builders and silently dropped. |
| `invokeAgent()` normalises `AIMessage.content` from content blocks to string before JSON parsing | `nodes.ts`, `pr-workflow.ts` | Anthropic streaming and OpenAI Responses API (`*codex*`, `gpt-5.x-pro`) return `content` as `[{ type: 'text', text: '...' }]` arrays, not plain strings. Without normalisation, the `typeof content !== 'string'` guard bypasses all JSON parsing and schema validation, producing silent empty output. Uses `extractTextFromContentBlocks()` / `normaliseContentToString()` from `structured-output.ts`. |

OpenAI auth priority: `OPENAI_API_KEY` (direct API key, no custom fetch chain) > OAuth client-credentials flow (`oauthFetch` -> `cassetteFetch` -> `throttledFetch`).
Anthropic and Google use their own HTTP handling with direct API keys.
When any direct API key is set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`) and `OAUTH_TOKEN_URL` is not configured, the OAuth flow is skipped entirely — no OAuth env vars are required.
Set `LLM_PROVIDER_DETECTION=openai` to force all models through the OpenAI-compatible endpoint (escape hatch for proxies).

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
2. **Dev agent invocation** -- Agent writes code with TDD (tests first), commits with conventional format.
   Every `invokeDevAgent` call wrapped in `try/finally` with `commitWorktree()` to preserve partial work.
3. **Quality gates** -- Deterministic build/lint/test verification
4. **Quality gate repair** -- If gates fail, re-invoke dev agent with error output (up to `PR_TEST_REPAIR_ATTEMPTS`).
   Repair wrapped in `try/finally` with `commitWorktree()`.
5. **Security gate** (optional) -- Secret scan before PR
6. **PR creation** -- Checks for existing open PR first (`findExistingPR`), then creates via Octokit or curl.
   422 "already exists" errors reuse the existing PR instead of deadlocking. Auth errors (`classifyPrFailure`)
   are fatal and halt the run immediately.
7. **Review loop** -- Sequential per-reviewer; each reviewer sees code after previous fixes.
   Fix agents wrapped in `try/finally` with `commitWorktree()`.
8. **Fix cycle** -- Dev agent fixes review comments; no-progress detection after 2 unchanged iterations
9. **Escalation** -- Unresolved CRITICALs escalate to higher-rank dev agent. `selectEscalationCandidate()`
   guarantees a candidate via cross-domain fallback (Sub-Plan 07). Wrapped in `try/finally`.
   Guarded by `PR_EXHAUSTION_STRATEGY`: skipped when `'fix-only'`.
10. **Strong Model Fixer (Sub-Plan 20)** -- When `STRONG_FIXER_ENABLED` and PR is still open after
    escalation (or instead of it for `'fix-only'`), a dedicated powerful model (`STRONG_FIXER_MODEL`,
    defaults to `PRINCIPAL_DEV_MODEL`) gets comprehensive context: original task, ALL review comments
    from all iterations, full diff, quality gate results, and integrity findings. Single pass — one fix
    attempt, one final review. Uses `buildStrongFixerAgent()` (principal persona, higher tool budget
    `STRONG_FIXER_MAX_TOOL_CALLS=40`). After fix, runs quality gates and a final review. If approved,
    proceeds to merge. If not, PR remains open. Guarded by `PR_EXHAUSTION_STRATEGY`:
    - `'escalate-then-fix'` (default): escalation first, then strong fixer if still unresolved
    - `'fix-only'`: skip escalation, go straight to strong fixer
    - `'escalate-only'`: no strong fixer (backward-compatible)
11. **Evidence-based merge decision (Sub-Plan 07)** -- `decideMerge()` evaluates gate report, integrity
    findings, layout violations, blocking review comments, file change count, and quorum before allowing
    merge. Policy modes: `strict` (default, all evidence required), `permissive` (hard blockers only),
    `legacy` (pre-Plan-19 unconditional merge). Blocked PRs get status `'blocked'` and a `pr:blocked` event.
12. **Merge ladder** -- `git merge origin/<base> --no-edit` (not rebase). On conflict: auto-resolve lockfiles
    and `package.json` via `resolveKnownConflicts()`; hand remaining conflicts to dev agent for
    `MERGE_CONFLICT_FIX_ATTEMPTS`; if still unresolved, salvage branch and report `pr:conflict`.
13. **Evidence-based completion** -- After merge, compute `CompletionEvidence` (real file changes,
    declared modules present, gate passed). Assignments that merge without evidence go back to pending.
14. **Worktree disposal** -- On success: remove worktree + delete remote branch. On failure: move worktree
    to `.worktrees-failed/` for salvage, export `git format-patch` to `<outputPath>/salvage/`, do NOT
    delete remote branch. Cap retained failed worktrees at `WORKTREE_SALVAGE_MAX`.

### Scaffold Barrier (dispatcher.ts)

- `injectScaffoldDependencies()` ensures every non-scaffold assignment depends on all scaffold assignments
- Scaffold branches run first (sequentially); `syncWorkspaceToBranch()` called after each merge
- `findOverlappingBranches()` detects branches with shared `moduleIds` and serialises them
- `CONFIG_OWNERSHIP_SCAFFOLD_ONLY` prevents feature branches from modifying root config files

### Git Branching Strategy

- **System branch**: `project/<system-slug>` (all feature branches target this)
- **Feature branches**: `<project-slug>/feature/<story-slug>` (one branch per user story)
- **Scaffold branch**: `<project-slug>/chore/scaffold`
- **Commit format**: `[project-slug]-[STORY-ID]-TYPE: description` (feat, fix, test, refactor, chore)

---

## Key Subsystems

### Tool Loop Guard (`tool-loop-guard.ts`) — Sub-Plan 08

Prevents agents from infinite tool-call loops with per-tool scoping and split budgets:
- Tracks total invocations per `toolName::args` key
- **Read-only tools** (read_file, list_dir, search_code, git tools) cache results; duplicates return `[CACHED]` (free — no budget consumed)
- **Mutating tools** (write_file, edit_file, etc.) clear all caches (workspace changed)
- 3rd identical call blocks ONLY that specific `(tool, args)` — other tools keep working
- **Split budgets**: separate read/write/shell ceilings per rank (principal: 30/25/10, senior: 25/20/8, junior: 20/15/8)
- **Progress bonus**: agents that produce real writes get `LOOP_GUARD_PROGRESS_BONUS` (10) extra read calls
- **Hard ceiling**: `LOOP_GUARD_HARD_CEILING` (80) absolute stop across all categories
- **Terminal guidance**: on exhaustion, injects "return your JSON now, do not claim files you did not write"
- **Legacy mode**: numeric `maxTotalCalls` parameter still works for non-dev agents

### Workspace Snapshot (`workspace-snapshot.ts`) — Sub-Plan 08

Pre-computed answers injected into dev agent prompts to eliminate reconnaissance waste:
- `git ls-files` tree grouped by directory (capped at `SNAPSHOT_MAX_FILES`, default 400)
- Verbatim `scripts` block from every `package.json` (root + workspace members)
- Test framework detection (runner, directories, command)
- Dependency list (names only, no versions)
- Budget: `SNAPSHOT_MAX_CHARS` (default 8000)
- Expected effect: eliminates 6–10 of every ~30 tool calls per invocation

### File Change Reconciliation (`file-change-reconciliation.ts`) — Sub-Plan 08

Reconciles agent-claimed fileChanges against the worktree to detect phantoms:
- `git diff --name-only` + `git ls-files --others` gives ground truth
- Claimed files not on disk → `phantomFileChanges` (dropped, logged, appended to state)
- Files on disk not claimed → added as `(unreported by agent)`
- Enabled by `RECONCILE_FILE_CHANGES` (default: true)

### LLM Throttle (`llm-throttle.ts`)

Process-wide rate-limit protection:
- **Concurrency semaphore**: `LLM_MAX_CONCURRENT_REQUESTS` (default 2)
- **Request spacing**: `LLM_MIN_REQUEST_INTERVAL_MS` (default 400ms), adaptive increase on 429
- **Global cooldown**: Exponential backoff on 429 (5s base, 90s max, +/-25% jitter)
- **Adaptive decay**: After 20 consecutive successes, interval decreases

### Retry (`retry.ts`) — Sub-Plan 08

Extended retry-with-backoff for transient failures:
- **Rate-limit errors**: 429, "Rate limit", "Request limit", "Token limit"
- **Transient errors** (new): ECONNRESET, ECONNREFUSED, ETIMEDOUT, socket hang up, Connection error, HTTP 5xx
- **Non-retryable**: 4xx (other than 429) — 401 Unauthorized, 404 Not Found, etc.
- Exponential backoff + ±30% jitter, max 120s delay

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

### QA Real Execution (`test-runner.ts`, `test-sufficiency.ts`) — Sub-Plan 09

QA reports are now derived from **real test-runner output**, not LLM self-reports.

- **`test-runner.ts`**: Executes each stack root's test suite with machine-readable output flags
  (Jest `--json`, JUnit XML, Go `-json`, etc.), parses the results into `ExecutedTestReport` objects.
  Distinguishes `runnerError` (config issue / missing dep) from real test failures.
- **`executedToTestReports()`**: Converts runner output into `TestReport` with `source: 'executed'`.
  The agent's self-report gets `source: 'claimed'` and is advisory only — it does not drive routing.
- **`compareClaimVsReality()`**: Detects discrepancies between agent claims and runner results;
  logged and recorded as `qaClaimDiscrepancies` on state.
- **`test-sufficiency.ts`**: `checkTestSufficiency()` enforces 6 rules: at-least-one-root-tested,
  no-runner-errors, min-total-tests, per-story-coverage, coverage-floor, no-all-trivial-tests.
  Violations become `Bug`s with stable ids `QA-<kind>[-<storyId>]`.
- **Tag convention**: Every test name must begin with `[<storyId>#<acIndex>]` for traceability.
  `parseTraceTag()` extracts this from runner output into `ExecutedTestCase.storyId`/`acIndex`.
- **Schema changes**: `TestReportSchema` now has `source` (`executed`/`claimed`/`quality-gates`),
  `iterationIndex`, `runnerError`, `coverage`, and required `cases` array with required
  `storyId`/`acIndex`. Refine rejects `{ total: 0, status: 'pass' }`.
- **QA crash handling**: QA Unit or QA Lead crash synthesises a `QA-UNIT-FAILED` / `QA-LEAD-FAILED`
  bug. `testReports` is never empty after `qaNode` (invariant assertion).

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

### Acceptance Gate (`acceptance-gate.ts`) — Sub-Plan 03

Single deterministic function that evaluates whether the product is acceptable.

- **`evaluateAcceptance(state)`** — checks 10 criteria: BUILD, ARTIFACTS, RESOLVE, TESTS, SMOKE,
  INTEGRITY, SCOPE, AC_COVERAGE, DEPLOY, E2E. Required criteria (BUILD, ARTIFACTS, RESOLVE, TESTS,
  SMOKE, INTEGRITY, SCOPE) must all pass for `'accepted'`; otherwise `'rejected'`, `'partial'`
  (all required pass but optional fail), or `'inconclusive'` (some required criteria could not execute).
- **`detectUnrecoverable(state)`** — detects when no further pipeline work can change the outcome:
  N consecutive zero-progress dispatch rounds, merge-conflict blocked branches, sourceless workspaces,
  or bugs attempted 2+ times that remain unresolved. Called at the **top of `bugfixTriageNode`** as
  well as from the acceptance gate — otherwise `unrecoverable` is only ever set post-e2e and the
  QA → triage → development loop can never halt itself (Plan 21, E3).
  Its zero-progress check reads `state.dispatchRounds`, which **`developmentNode` must keep writing**;
  `prs` there counts merged PRs only, never `PR-SKIPPED-*` placeholders.
- **`haltIfUnrecoverable()`** — checked in developmentNode, qaNode, devopsNode to skip early under
  `RUN_FAIL_POLICY='halt'`.
- **`acceptanceBlockersToBugs()`** — converts failed required criteria into `ACCEPT-*` bugs for the
  bugfix loop.

The acceptance gate runs as a new graph node (`acceptance-gate`) between E2E and finalize. The
`afterAcceptanceRouter` routes back to bugfix-triage while iterations remain and the product is not
accepted (and not unrecoverable).

Key env vars: `RUN_FAIL_POLICY` (halt/finalize/legacy), `ACCEPT_MIN_TESTS`, `ACCEPT_REQUIRE_SMOKE`,
`UNRECOVERABLE_ZERO_ROUNDS`.

### Requirements Traceability & AC Coverage (`traceability.ts`, `nodes.ts`) — Sub-Plan 10

Chains epics → stories → acceptance criteria → tasks → assignments → PRs → tests into a
full traceability matrix so "did we build and verify what was asked?" is answerable.

**Graded AC Status** — Each acceptance criterion is classified into one of 6 states:

| `AcStatus` | Meaning |
|------------|---------|
| `verified` | PR merged **and** a passing test with `source: 'executed'` covers the AC |
| `tested-failing` | PR merged, tagged test exists but fails |
| `implemented-untested` | PR merged, no tagged test executed |
| `planned-only` | Assignment exists, PR not merged |
| `blocked` | Assignment exists, PR blocked/conflicted/open after run |
| `missing` | No assignment references this story/AC at all |

**Coverage Metrics** — `CoverageTotals` carries three metrics instead of the old single `coveragePct`:

| Metric | Formula |
|--------|---------|
| `verifiedPct` | `verified / criteria` — the strict bar |
| `implementedPct` | `(verified + implemented) / criteria` — "the code exists" |
| `deliveryScore` | `(verified × 1.0 + implemented × 0.5 + testedFailing × 0.25) / criteria` — weighted composite |

**Key rules:**
- Only `source: 'executed'` test reports count toward coverage — `claimed` reports are excluded.
- `hasMerged` requires `status === 'merged'` (not `'approved'`).
- No in-place mutation of `story.acceptanceCriteria` — a local copy is used.
- Developer persona requires `[storyId#acIndex]` test naming (e.g. `it('[US-003#1] eating a dot increments score', ...)`).

**AC Coverage Gate** (in `qaNode`):
- Enabled when `MIN_AC_COVERAGE_PCT > 0` (default 70%). The `AC_COVERAGE` acceptance criterion
  becomes **required** when this threshold is set.
- Emits a `TestReport` signal with `framework: 'ac-coverage'` and `source: 'quality-gates'`
  so `afterQaRouter` sees failures and routes to the bugfix loop.
- On failure, synthesises bugs with `severity: 'critical'`, prioritising **missing** over
  **tested-failing** over **blocked** over **implemented-untested** (gap-first ordering).
  Bug IDs follow the pattern `AC-<storyId>-<acIndex>`.
- Max bugs per gate run: `MIN_AC_COVERAGE_MAX_BUGS` (default 25).

**QA Plan Gap Detection** (in `qaNode`):
- After the QA Lead produces a test plan, the conductor checks whether every acceptance
  criterion has at least one test plan item. Uncovered criteria generate `QA-PLAN-GAP` bugs
  with stable IDs `QA-PLAN-GAP-<storyId>-<acIndex>` (capped at 15 per run).

**Traceability Report** (in `finalizeNode`):
- `TraceabilityReport` includes: `rows`, `totals`, `orphanedStories`, `orphanedAssignments`,
  `orphanedTasks`, `unassignedTasks`, `blockedDeliveries`, `claimedVsExecuted`.
- Output: `outputs/<run>/traceability.md` (human-readable) **and** `outputs/<run>/traceability.json`
  (machine-readable, controlled by `TRACEABILITY_JSON`, default true).

**Key env vars**: `MIN_AC_COVERAGE_PCT` (70), `MIN_AC_IMPLEMENTED_PCT` (90),
`MIN_AC_COVERAGE_MAX_BUGS` (25), `TRACEABILITY_JSON` (true).

### DevOps & E2E Hardening — Sub-Plan 11

**DevOps verification** (`devops-verify.ts`, `devops-fallback.ts`, `nodes.ts`):
- Agent's self-reported `buildStatus`/`runStatus`/`serviceUrls` are **always** overwritten by
  `verifyDeployment` — even when Docker is unavailable (returns `skipped`, not the agent's claims).
  Prevents the retroboard3 bug where hallucinated service URLs reached E2E.
- Health-gates the `runStatus`: `docker compose ps` checks service state; HTTP health checks
  must all pass for `'running'`; failures produce `'unhealthy'` and a `DEPLOY-UNHEALTHY` bug.
- Deterministic Dockerfile fallback (`DEVOPS_FALLBACK_ENABLED`, default `true`): when the DevOps
  agent fails or produces no Docker artifacts, `generateFallbackDeployment` creates Dockerfiles
  and `docker-compose.yml` from detected stack roots. Templates for SPA (nginx), Node server,
  Python, Go. This unblocks E2E for frontend-only projects.

**E2E state tracking** (`state.ts`):
- `e2eStatus`: `'not-run'` | `'passed'` | `'failed'` | `'skipped-no-services'` | `'skipped-disabled'` | `'error'`
- `e2eSkipReason`: human-readable reason when skipped/error.
- `e2eEvidence`: `{ screenshots, consoleErrors, urlsVisited }`.
- Every exit path of `e2eNode` sets `e2eStatus`. The acceptance gate's E2E criterion reads this
  field, not the test reports array.

**Playwright preflight** (`playwright-preflight.ts`):
- Runs once per process (cached). Checks `npx playwright --version`, auto-installs chromium
  if `PLAYWRIGHT_AUTO_INSTALL=true`, retries MCP connection `PLAYWRIGHT_MCP_CONNECT_RETRIES` times.
- On failure: falls back to `runSmokeTest` (deterministic HTTP check from Sub-Plan 01).

**Non-Docker E2E path**: When no service URLs exist but a web root is detected
(`E2E_ALLOW_LOCAL_SERVER=true`), `e2eNode` runs `runSmokeTest` against the built artifacts.
A 200 response is `'passed'`; failure is `'error'`.

**E2E catch path**: Synthesises `E2E-INFRA-FAILED` bug (major), pushes an `inconclusive` e2e
TestReport, and records a `verificationErrors` entry. No silent swallowing.

**afterE2eRouter**: Filters to `type === 'e2e' && source === 'executed'` at the current
`iterationIndex`. `E2E_BUGFIX_ENABLED` default flipped to `true`.

**Key env vars**: `E2E_BUGFIX_ENABLED` (true), `E2E_ALLOW_LOCAL_SERVER` (true),
`ACCEPT_REQUIRE_E2E` (false), `PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS` (60000),
`PLAYWRIGHT_MCP_CONNECT_RETRIES` (2), `PLAYWRIGHT_AUTO_INSTALL` (true),
`DEVOPS_FALLBACK_ENABLED` (true).

### Security Gates (`security-gates.ts`)

Three checks combined:
- **Secret scan**: Regex patterns for AWS keys, private keys, GitHub tokens, JWTs, generic secrets
- **Dependency audit**: Per-stack (npm audit, pip-audit, govulncheck, etc.)
- **Licence check**: SPDX deny-list for npm packages
- Never logs matched values (redaction discipline)

### Plan Coverage (`plan-coverage.ts`) -- Sub-Plan 04

Validates that no stories or tasks are silently dropped between planning phases:
- `validateStoryPlan(state)` -- epics -> stories -> tasks (after PM)
- `validateAssignmentPlan(state)` -- stories/tasks -> assignments (after TL)
- `buildCoverageGapPrompt(violations, nextId)` -- targeted gap prompt for the TL
- Controlled by `PLAN_COVERAGE_MODE` (off/warn/enforce), `PLAN_COVERAGE_REPAIR_ATTEMPTS`
- The Team Leader now receives full acceptance criteria (`storiesWithCriteria`), has a larger
  context budget (`TEAM_LEADER_CONTEXT_MAX_CHARS`), and must fill `taskIds`/`additionalStoryIds`
  on every assignment. After the TL produces assignments, the conductor validates coverage and
  re-invokes the TL with a gap prompt if stories/tasks are missing.

### Architecture Contract (`repo-contract.schema.ts`, `repo-contract-writer.ts`, `layout-lint.ts`) — Sub-Plan 05

A machine-checkable repo layout and module contract produced by the Architect:

- **Schema** (`RepoContractSchema`): `layout` (single-root / npm-workspaces / multi-stack),
  `roots[]` (dir, kind, stack, entryPoints, sourceDirs, testDirs, scripts, buildOutputDir),
  `modules[]` (id, path, componentName, exports with signatures, dependsOn),
  `namingConvention`, `sharedTypes`, `frozenPaths`.
- **State channel**: `repoContract: RepoContract | null` (replace reducer).
- **Writer** (`repo-contract-writer.ts`): `writeRepoContract` writes `.agent/repo-contract.json`
  (machine-read, gitignored) + `docs/ARCHITECTURE-CONTRACT.md` (human-readable, committed).
  `readRepoContract` reads it back. `renderContractForPrompt` produces a budgeted prompt section.
  `deriveContractFromAnalysis` infers a contract from an existing codebase (maintain mode).
- **Layout Linter** (`layout-lint.ts`): `lintLayout(workspace, contract, opts?)` checks 10
  violation kinds: `file-outside-source-dirs`, `unknown-root`, `duplicate-module`,
  `module-path-mismatch`, `missing-declared-export`, `entrypoint-missing`,
  `entrypoint-does-not-compose`, `test-outside-test-dirs`, `cross-root-relative-import`,
  `naming-violation`. Reuses `buildImportGraph` from gate-integrity.
- **Architect**: `tools: []` (JSON mode active), prompt includes `<repo_contract>` section,
  output includes `repoContract` field. `architectNode` caps modules at `REPO_CONTRACT_MAX_MODULES`.
- **All agents** receive the contract in their context (priority 1). Developer persona includes
  `<repo_contract>` block. Reviewers have a stub carve-out for scaffold stubs.
- **Env vars**: `REPO_CONTRACT_MODE` (off/warn/enforce), `REPO_CONTRACT_MAX_MODULES` (60),
  `CONTRACT_STUB_SCAFFOLD` (true), `CONTRACT_PROMPT_MAX_CHARS` (6000).

### Structured Output (`structured-output.ts`)

Robust JSON extraction from LLM responses:
1. Direct `JSON.parse`
2. Code fence extraction (```json ... ```)
3. Balanced braces extraction
4. `jsonrepair` for truncated/malformed JSON (sets `wasTruncated` flag)
5. `detectTruncation()` for structural completeness check
6. `repairFieldViolations()` -- deterministic field-level repair (enum near-miss, scalar/array coercion, type coercion) before LLM repair
7. Zod validation with repair loop (re-invoke agent with issue summary, 16k middle-clip budget)

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
- `traceability.md` -- Requirements traceability matrix (human-readable)
- `traceability.json` -- Requirements traceability matrix (machine-readable, if `TRACEABILITY_JSON=true`)
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
| 20 | Multi-provider LLM support (Anthropic, Google alongside OpenAI) and strong model PR fixer |

When referenced in code comments, these plans are cited as "fixes A1", "fixes A2", etc. (referring to sub-plans within Plan 16).

---

## Common Gotchas

1. **`env.ts` must be imported first** -- Before any module that reads `process.env`. Uses `override: true` so `.env` wins over shell vars.
2. **Append vs Replace reducers** -- Arrays use append (data accumulates); scalars/objects use replace (last write wins). Returning `[]` for an append field adds nothing, not clears it.
3. **Agent recursion limits differ by type** -- Pipeline agents: 15, tool-using pipeline agents: 120, dev agents: 140, reviewers: 40. (Sub-Plan 08: raised from 15/60/58/26 because the loop guard is now the binding constraint.)
4. **Tool budgets are split by category (Sub-Plan 08)** -- Read/write/shell separate budgets per rank: principal 30/25/10, senior 25/20/8, junior 20/15/8. Reviewer: 14 total. Progress bonus grants 10 extra reads when writing. Hard ceiling: 80.
5. **`git_diff` was removed from reviewer tools** -- It showed empty results for committed code and caused llama-3-3-70b-instruct to loop. Use `git_merge_base_diff` instead.
6. **`emitMermaidTool` removed from dev agents** -- Caused infinite loops. Only the Architect has it.
7. **Worktree cleanup is critical** -- Stale worktrees break subsequent runs. Intake prunes them.
8. **SSL workaround** -- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set globally for corporate environments with self-signed certs.
9. **Dockerfiles are patched for SSL** -- `patchDockerfilesSsl()` injects `npm config set strict-ssl false` before npm commands.
10. **`GITHUB_MODE=local`** creates a bare repo under the run output directory and patches `origin` to point there.
11. **Protected config files are refused for repair agents** (`CONFIG_OWNERSHIP_SCAFFOLD_ONLY`) — feature branches cannot modify shared root config files; only the scaffold branch may.
12. **Only `source: 'executed'` test reports count toward coverage and routing** — agent self-reported (`claimed`) test results are advisory only and do not drive pipeline decisions.
13. **`completed` now means accepted by the acceptance gate** — never a false positive. The `finalStatus` is one of `completed`, `failed`, `partial`, or `inconclusive`, determined by the deterministic acceptance gate.
14. **`.agent/` is gitignored in generated projects** — the `repo-contract.json` and other machine-generated files live there and must not be committed.

---

## Failure modes observed in production runs

Two autonomous greenfield runs (`pacman8` and `retroboard3`) revealed systemic pipeline failures.
See `Plans/19-autonomous-run-remediation/00-INDEX.md` for the full post-mortem.

Key failure classes (all fixed by Plan 19 sub-plans 01-12):

1. **No product verification.** Quality gates ran `npm run build --if-present` — a missing script
   meant exit 0 → "pass". The gate never checked build artifacts, imports, or rendering. (SP-01)
2. **Gate gaming.** An agent replaced `package.json` scripts with `echo Build successful` during a
   gate repair. No tamper detection existed. (SP-02)
3. **Always-completed status.** `finalStatus = cancelled ? 'cancelled' : 'completed'` — the only
   failure path was cancellation. (SP-03)
4. **Silent scope loss.** 18 of 20 stories were dropped between PM and TL due to a scalar
   `storyId` field, lossy repair (4000 char clip), and a prompt encouraging merging. (SP-04)
5. **No architecture contract.** Agents built two incompatible directory structures in the same
   run (root `src/` vs `packages/*/src/`). (SP-05)
6. **PR work loss.** Scaffold and feature branches dispatched from the same commit caused
   permanent conflicts. Worktree cleanup deleted uncommitted code. (SP-06)
7. **Reviewer overruled.** 9 of 14 PRs force-merged despite `changes_requested`. Six separate
   fail-open paths in the review code defaulted to `approved`. (SP-07)
8. **Poisoning death spiral.** 289 tool-poisoning events, 193 respawns with zero carried state.
   Agents burned budgets on reconnaissance and never got to write code. (SP-08)
9. **QA never ran a test.** `total: 0, status: 'pass'` was explicitly authorised by the prompt.
   QA crashing was indistinguishable from QA passing. (SP-09)
10. **Coverage metric pinned at 0%.** Required fields were optional, the metric was computed and
    discarded, and the gate was dead code. (SP-10)
11. **Unverified deployment claims.** The DevOps agent's self-reported URLs survived into state
    even when `verifyDeployment` returned `skipped`. (SP-11)
12. **No observability.** Both runs saturated the 500-event buffer. Diagnosing required reading
    a 2.1 MB log line by line. (SP-12)
