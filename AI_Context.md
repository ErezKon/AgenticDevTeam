# AI Context — AgenticDevTeam

> **Purpose of this file:** Provide AI sessions with deep project understanding so they can skip or reduce codebase analysis. This file is the authoritative reference for architecture, conventions, patterns, and rules that AI agents must follow when making changes.

---

## Rules for AI Sessions

1. **Read this file first.** Before making any changes, read this file and `README.md` to understand the project's architecture, conventions, and constraints.
2. **Maintain consistency.** All changes must follow the existing patterns, naming conventions, and architectural decisions documented here. Do not introduce new patterns without explicit user approval.
3. **Update context files.** If your changes alter the pipeline flow, add/remove agents, modify configuration, change schemas, or affect the architecture in any meaningful way, you **must** update this `AI_Context.md` and `README.md` to reflect those changes.
4. **Never break the pipeline.** The LangGraph state machine is the backbone. Changes to `state.ts`, `graph.ts`, or `nodes/` require understanding the full flow and how reducers merge state.
5. **Schema changes cascade.** Modifying a Zod schema in `src/agents/_shared/schemas/` affects every agent that uses it, the conductor nodes, and the tests. Trace all consumers before changing.
6. **Environment variables are the API.** All configuration is via `.env`. When adding a new config, add it to `src/config.ts`, `.env.example` (with documentation), and the README's Environment Variables table.
7. **Test what you change.** Run `npm run test:unit` for unit tests. Use `npm run test:greenfield` or `npm run test:maintain` for integration tests. Use `npm run test:regression` for acceptance-gate regression tests. Default test timeout is 10 seconds; integration tests set their own per-test timeouts. Use `npm run typecheck` for type checking and `npm run lint` for unused-code detection. Coverage thresholds are configured in `jest.config.js`; run with `--coverage` to check.
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
  cli.ts                           # CLI entry point (thin wrapper — delegates to cli/ modules)
  index.ts                         # Express REST + WebSocket server (testable — guarded listen())
  config.ts                        # All env-driven configuration (single source)
  env.ts                           # dotenv bootstrap (must be imported first)

  cli/                             # CLI modules (Sub-Plan 26-09)
    printers.ts                    # Display helpers (header, roster, artifacts, phase status)
    prompts.ts                     # Readline wrapper, requirements gathering, repo target
    hitl-loop.ts                   # Unified HITL decision loop (was triplicated)
    menu.ts                        # Main menu + run-start functions

  conductor/                       # LangGraph orchestration layer
    state.ts                       # ProjectState (Annotation + reducers, incl. _stopReason)
    graph.ts                       # StateGraph wiring + conditional edges + HITL
    nodes/                         # Phase node functions (split into focused modules)
      index.ts                     # Barrel re-export of all 13 node functions
      _invoke.ts                   # invokeAgent<S>() (generic over Zod schema), getModelForAgent()
      _guards.ts                   # phaseNode() decorator, shouldSkipOnContinue, checkBudgetStop, msg()
      _git-helpers.ts              # detectDefaultBranch, commitAndPushArtifacts, ensureNodeLockfileSync
      intake.ts                    # intakeNode (Phase 1)
      planning.ts                  # codebaseAnalyzerNode, architectNode, pmNode, dbaNode, tlNode (Phases 1b-5)
      development.ts               # developmentNode (Phase 6, fan-out dispatch)
      qa.ts                        # qaNode (Phase 7, test planning + execution + gates)
      bugfix-triage.ts             # bugfixTriageNode (Phase 8)
      devops.ts                    # devopsNode (Phase 9)
      e2e.ts                       # e2eNode (Phase 9b, Playwright + smoke fallback)
      acceptance.ts                # acceptanceNode (Phase 10)
      finalize.ts                  # finalizeNode (Phase 11, reporting + teardown)
    run.ts                         # Autonomous & HITL run helpers + continueRun + handleRunCrash + makeSession
    pr-workflow.ts                 # Backward-compatible re-export shim (~80 lines)
    pr/                            # PR workflow modules (Sub-Plan 26-08)
      index.ts                     # Barrel re-export
      orchestrator.ts              # Top-level PR lifecycle orchestrator (~620 lines)
      worktree.ts                  # Worktree creation, disposal, salvage, eviction
      pr-github.ts                 # Octokit wrapper, PR creation/retry/merge, postComment
      pr-body.ts                   # PR title & description builders (pure, testable)
      dev-prompts.ts               # Prompt fragments & message builders (fix, repair, escalation)
      diff.ts                      # DIFF_EXCLUDE_SPECS + getReviewDiff with stat fallback
      agent-invoke.ts              # invokeDevAgent/invokeReviewerAgent with respawn
      commit.ts                    # commitWorktree (durable stage+commit+push)
      gates.ts                     # Gate running with tamper detection & repair
      review-loop.ts               # Sequential reviewer passes with interleaved fixes
      escalation.ts                # Senior dev + reviewer escalation on CRITICALs
      strong-fixer.ts              # Strong model fixer (Sub-Plan 20)
      merge-ladder.ts              # Base integration & conflict resolution
    context-builder.ts             # Compact context summarizers with char budgets
    quality-gates.ts               # Multi-language build/lint/test gates
    security-gates.ts              # Secret scan + dependency audit + licence check
    workspace-sync.ts              # Git sync after squash merges; Plan 26-11: async fetchWithRetry/syncWorkspaceToBranch with non-blocking sleep()
    assignment-policy.ts           # Prevent re-dispatch of completed assignments + sanitizeAssignmentStoryIds
    review-policy.ts               # Fail-closed review: ReviewOutcome, decideMerge, escalation, quorum (Sub-Plan 07)
    devops-verify.ts               # Real Docker build/run/health-check
    file-checkpointer.ts           # Persistent checkpoints for crash recovery
    provider-failure.ts              # Provider error classification + ProviderRecoveryFailedError
    bug-factory.ts                 # Shared makeBug/makeGateBug Bug constructor helpers
    gate-types.ts                  # Unified gate types (GateStatus, FindingSeverity, GateFinding, GateOutcome<R>, WorkspaceIndex) + legacy GateReport/GateStepResult
    workspace-index.ts             # buildWorkspaceIndex() — pre-built file index passed to all gates
    continue/                      # Continue Run feature (Plan 23)
      index.ts                     # Barrel export
      state-collector.ts           # Read-only artifact collector (listStoppedRuns with stopReason)
      state-reconstructor.ts       # State reconstruction + phase resolution
      singleton-rehydration.ts     # Global singleton rehydration
      git-reconciliation.ts        # Git workspace reconciliation

  agents/
    registry.ts                    # Master 20-agent registry (id, name, tag, color)
    _shared/
      agent-factory.ts             # buildAgent() wrapper for createAgent
      llm-provider.ts              # Multi-provider LLM factory (OpenAI, Anthropic, Google)
      prompt-cache.ts              # Anthropic cache_control breakpoints (Plan 22)
      history-compactor.ts         # ReAct history compaction + streaming-residue sanitiser
      persona.ts                   # Developer prompt builder (rank/domain/languages)
      artifact.ts                  # Mission report writer (docs/agents/*.md)
      tool-loop-guard.ts           # Read/write/shell/turn budgets + loop detection
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
    fs/workspace-tools.ts          # Sandboxed read/write/edit/list/search (5 tools); Plan 26-11: all handlers use fs/promises (non-blocking)
    git/git-tools.ts               # Git CLI tools (12 tools)
    shell/shell-tools.ts           # Guarded shell execution (1 tool)
    diagram/diagram-tools.ts       # Mermaid label sanitization
    requirements/parse-requirements.ts  # .md/.txt/.pdf/.docx parser
    mcp/playwright-mcp.ts          # Playwright MCP client (singleton)

  executor/
    docker-runner.ts               # Dockerode build/run/healthcheck

  utils/
    logger.ts                      # Per-agent colored console + file logger
    oauth-auth.util.ts             # OAuth2 client-credentials token cache
    workspace.ts                   # Project workspace + output dir creation
    retry.ts                       # Exponential backoff + jitter for LLM calls
    llm-throttle.ts                # Global rate-limit protection (semaphore + cooldown) + createProviderProbe()
    llm-cassette.ts                # Record/replay VCR for deterministic tests
    github-local.ts                # Local GitHub stand-in (bare git repo)
    github-repo-manager.ts         # GitHub repo create/validate/init
    run-budget.ts                  # Graceful degradation on budget limits + shouldStopRun()
    structured-output.ts           # JSON extraction + Zod validation + repair + content-block text extraction
    response-log.ts                # Full-response dumps (outputs/<run>/full-responses/*.json + index.jsonl)
    event-bus.ts                   # Typed singleton event bus (14 event types, incl. run:budget-stop, run:provider-stop)
    token-tracker.ts               # Token consumption tracker (singleton); Plan 26-11: appends JSONL per call (O(1)), debounces full JSON flush every 10s
    token-callback.ts              # LangChain callback for token recording (two-tier provider lookup)
    token-usage-extractor.ts       # Shared usage normalisation (normaliseUsage/sumUsageMetadata) + per-invocation aggregation
    token-report.ts                # HTML + JSON token usage report generator
    cost.ts                        # USD cost estimation per model
    run-snapshot.ts                # state.json + run-manifest.json writer + writePeriodicSnapshot(); Plan 26-11: debounced full snapshots (30s min interval) + immediate latest-phase.json marker
    git-exec.ts                    # Centralized git command execution (execFileSync, shellSplit, assertValidRef, redactSecrets)
    coding-conventions.ts          # Convention file resolution + deployment
    traceability.ts                # Requirements traceability matrix
    codebase-analysis-writer.ts    # Write analysis markdown
    log-colors.util.ts             # ANSI 256-color codes
    fs-walk.ts                     # Shared filesystem walker (PRUNE_DIRS, SOURCE_EXTENSIONS, walkDir, collectFiles, isTestFile)
    source-graph.ts                # Import extraction + resolution + graph building + transitive reachability
    markdown-table.ts              # Shared mdTable() + mdSection() with automatic pipe-escaping
    shell-exec.ts                  # Shared ExecFn type, safeChildEnv, defaultExec/isToolAvailable; Plan 26-11: async AsyncExecFn, defaultExecAsync, isToolAvailableAsync (execFile + promises)
    branch-naming.ts               # Canonical slugify, systemBranch, featureBranch, projectSlugFromBranch, isSystemBranch
    artifact-writer.ts             # writeOutputFile + appendOutputLine for output-dir artifacts
    crash-handlers.ts              # flushTokenReportOnExit + installProcessHandlers (shared between cli.ts and index.ts)

  templates/
    codebase-analysis.template.ts  # Markdown renderer for CodebaseAnalysis

  types/
    shims.d.ts                     # Module declarations (pdf-parse, mammoth)

dashboard/                         # Angular 19 standalone web UI
  src/app/
    app.component.ts               # Root shell with routing + WebSocket disconnect indicator
    app.routes.ts                  # Dashboard + New Run + Run Session routes
    components/
      markdown-viewer/             # Markdown renderer (marked + DOMPurify + mermaid, ViewEncapsulation.None)
      event-log/                   # Shared <app-event-log> component
      file-changes-table/          # Shared <app-file-changes-table> component
      pr-badge/                    # Shared <app-pr-badge> component
    pages/dashboard/               # Agent roster + active runs + live event feed (with history backfill)
    pages/new-run/                 # Start run form
    pages/run-session/             # Phase timeline, HITL controls, mission report, tabbed state viewer
    services/api.service.ts        # HTTP + WebSocket client (exponential backoff reconnect)

tests/                             # Jest test suite (ts-jest)
  setup.ts                         # Polyfill crypto, load env, validate vars
  setup-env-guard.ts               # Env snapshot/restore (prevents cross-test pollution)
  utils.ts                         # Spec discovery helpers
  helpers/                         # Shared test utilities
    state-factory.ts               # makeState(overrides?) — canonical ProjectStateType fixture
    tmp.ts                         # makeTempDir(), withTempDir() — temp dir lifecycle
    git.ts                         # git(), createTestRepo() — isolated git helpers
  *.test.ts                        # 85+ test files (Sub-Plan 26-13)
  # Notable new test files (Sub-Plan 26-13):
  # provider-failure.test.ts        — classifyProviderFailure, isProviderLevelFailure, ProviderRecoveryFailedError
  # cost.test.ts                    — estimateCost, estimateRunCost (cache-aware pricing)
  # config.test.ts                  — envInt, envFloat, envBool, envEnum helpers
  # assembly-gate.test.ts           — runAssemblyGate, buildAssemblyAssignment, assemblyGateOutcome
  # branch-consolidation.test.ts    — consolidateBranches (union-find, squash, module overlap)
  # workspace.test.ts               — resolveWorkspacePath (security-critical path resolution)
  # pr-body.test.ts                 — buildPRTitle, buildPRDescription (pure functions)
  # acceptance-gate.regression.test.ts — (renamed from regression-plan19.test.ts, tautological tests removed)

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
- **cancel routing**: Any phase can route to `finalize` when `state.cancelled === true` — this is triggered by HITL deny, `checkBudgetStop()` (budget exhaustion), or `developmentNode` (provider failure)

---

## Agent Architecture

### Agent Categories and Tool Access

| Category | Agents | Tools | Model Tier |
|----------|--------|-------|------------|
| **Analysis** | Codebase Analyzer | Read-only workspace (read_file, list_dir, search_code) | `CODEBASE_ANALYZER_MODEL` |
| **Management** | Architect | None (planning-only) | `ARCHITECT_MODEL` |
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

### Provider Transport Invariants (Plans 21 & 22)

These are load-bearing. Changing any of them reintroduces a failure mode that is silent, total, and billable.

| Invariant | Where | Why |
|-----------|-------|-----|
| Anthropic requests carry `cache_control` breakpoints on the system message, the task message and a rolling history point | `prompt-cache.ts`, wired in `agent-factory.ts` | Anthropic serialises `tools` → `system` → `messages`, so the **system** breakpoint also caches the tool schemas and the injected response schema. Without breakpoints the ~6 kB fixed preamble is re-billed on every call: the pacmanclaude run reported `cache_read: 0` on all 227 Anthropic calls and billed **2.32M input / 99.7K output** (23:1) for one branch of fifteen. Max 4 breakpoints per request. Flag: `ANTHROPIC_PROMPT_CACHE_ENABLED`. |
| `cacheReadTokens` / `cacheCreationTokens` are recorded on every `TokenCallRecord`, and a zero-cache run logs an ERROR | `token-usage-extractor.ts`, `token-callback.ts`, `token-report.ts` | These numbers were present on every Anthropic response and discarded, so a total cache miss was invisible. `SANITY_ASSERT_CACHE` fires once after `SANITY_ASSERT_CACHE_AFTER` (20) Anthropic calls with zero cache reads. |
| `opts.timeout` reaches Anthropic (`clientOptions.timeout`) and Google (`timeout`) | `llm-provider.ts` | It was applied to `ChatOpenAI` only, so `LLM_REQUEST_TIMEOUT_MS` was silently OpenAI-exclusive. |
| `ChatAnthropic` is created **with** `streaming: true` + A2 sanitiser guard | `llm-provider.ts` | Anthropic's HTTP endpoint times out after ~10 minutes on non-streaming requests, killing long agent runs. Streaming residue (`input_json_delta`, id-less `tool_use`) is stripped by `sanitizeStreamingContentBlocks()` before every LLM call. Token accounting for streaming uses the `usage_metadata` fallback (D's two-tier lookup). |
| Adaptive-only Anthropic models omit `temperature`/`topK`/`topP` | `llm-provider.ts` | `claude-opus-4-7+`, `claude-opus-5+`, `claude-sonnet-5+`, `claude-fable-5+`, `claude-mythos-*` reject non-default sampling params. The regex is a deliberate **superset** of `ADAPTIVE_ONLY_MODEL_PREFIXES` in `@langchain/anthropic` and must **not** be narrowed to match it — the SDK list lags the API (it still omits `claude-sonnet-5` as of `1.5.6`, so the SDK sends `temperature` and the API returns `400 "temperature is deprecated for this model"`). Add new model families here as Anthropic ships them, without waiting for the SDK. |
| JSON mode uses `model.withConfig({ response_format })`, **never** `modelKwargs` | `llm-provider.ts` | `modelKwargs` is spread verbatim into the request body. `*codex*` / `gpt-5.x-pro` route through the OpenAI **Responses API**, which rejects top-level `response_format`. `withConfig` lets LangChain emit `response_format` (Chat Completions) or `text.format` (Responses). |
| `sanitizeStreamingContentBlocks()` runs before `compactHistory()` on every call | `history-compactor.ts`, wired in `agent-factory.ts` | Defence-in-depth against corrupt histories, including ones restored from a checkpoint written by an older provider package. Operates on a copy; `tool_calls` is untouched (the adapter re-materialises `tool_use` blocks from it). Flag: `SANITIZE_STREAM_BLOCKS`. |
| `handleLLMEnd` reads `llmOutput.{tokenUsage,token_usage,usage,estimatedTokenUsage}`, then falls back to `generations[].message.usage_metadata` | `token-callback.ts` + `token-usage-extractor.ts` | No single field covers every transport. Reading only tier 1 recorded 5 token records for a 60+ call run, silently disabling `MAX_RUN_COST_USD`. Tier 1 wins when present, so nothing is double-counted. Both paths share `normaliseUsage` / `sumUsageMetadata`. |
| `AgentConfig.topP` / `topK` are forwarded to `createChatModel()` | `agent-factory.ts` | They were accepted by 10 agent builders and silently dropped. |
| `invokeAgent()` normalises `AIMessage.content` from content blocks to string before JSON parsing | `nodes/_invoke.ts`, `pr-workflow.ts` | Anthropic streaming and OpenAI Responses API (`*codex*`, `gpt-5.x-pro`) return `content` as `[{ type: 'text', text: '...' }]` arrays, not plain strings. Without normalisation, the `typeof content !== 'string'` guard bypasses all JSON parsing and schema validation, producing silent empty output. Uses `extractAgentText()` from `structured-output.ts`. |
| A response with **no** extractable text never returns raw content blocks when a schema is set | `nodes/_invoke.ts` (`invokeAgent`), `pr-workflow.ts` | Reasoning-only responses and thinking-exhausted output budgets have no text block. Returning `last.content` there is what wrote `architect-mission.md` with `undefined` fields and `0 components` while reporting success. Now it logs the block census, re-asks through the repair loop (repair message carries the original request because there is no previous payload to correct), and throws if still empty. |
| `reasoning` / `thinking` blocks are excluded from extracted text | `structured-output.ts` | Concatenating them into the payload corrupts `JSON.parse`. |
| Every agent invocation is dumped to `outputs/<run>/full-responses/` | `response-log.ts`, wired in `nodes/_invoke.ts` + `pr-workflow.ts` | Response-shape failures are invisible in `run.log` — it only shows the symptom (`0 components`). The dumps + `index.jsonl` (`textSource`, `finalContentBlocks`, `truncatedByTokenLimit`) make the cause a one-line read. Flag: `FULL_RESPONSE_LOG_ENABLED`. |

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
- `cancelled: boolean` -- Set on HITL "deny", budget exhaustion, or unrecoverable provider failure
- `_stopReason: string | null` -- Why the run was stopped gracefully (`'budget-exhausted:<binding>'`, `'provider-billing'`, `'provider-auth'`, etc.). Null during normal runs. Used by `finalizeNode` for manifest status and by continue-run to surface the stop reason. Cleared on continue-run

---

## PR Workflow (pr/ modules, re-exported via pr-workflow.ts)

The development phase uses a sophisticated PR workflow for each branch.
The implementation is split into focused modules under `src/conductor/pr/` (Sub-Plan 26-08).
`pr-workflow.ts` is a backward-compatible re-export shim; the real orchestrator is `pr/orchestrator.ts`.

1. **Worktree creation** -- `git worktree add .worktrees/<branch>` for parallel isolation
2. **Dev agent invocation** -- Agent writes code with TDD (tests first), commits with conventional format.
   Every `invokeDevAgent` call wrapped in `try/finally` with `commitWorktree()` to preserve partial work.
3. **Quality gates** -- Deterministic build/lint/test verification
4. **Quality gate repair** -- If gates fail, re-invoke dev agent with error output (up to `PR_TEST_REPAIR_ATTEMPTS`).
   Repair wrapped in `try/finally` with `commitWorktree()`.
5. **Security gate** (optional) -- Secret scan before PR
6. **PR creation** -- Checks for existing open PR first (`findExistingPR`), then creates via Octokit or curl.
   422 "already exists" errors reuse the existing PR instead of deadlocking. Auth errors (`classifyPrFailure`)
   are fatal and halt the run immediately. Transient failures (GitHub 5xx, network errors) retry up to 3
   times with exponential backoff (2s base).
6b. **PR creation failure** -- If all retries fail, `executePRWorkflow` returns a `PullRequest` with
   `status: 'pr-creation-failed'` instead of throwing. The dispatcher sets a `prCreationFailed` flag,
   skips all remaining branches (scaffold, bootstrap, serialised, parallel), and stops the run
   gracefully. The failed PR entry is persisted in `state.json` so continue-run can retry just the PR
   creation — the branch code is already pushed. See `retryFailedPRCreation()` in `pr-workflow.ts`.
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
    findings, blocking review comments, file change count, and quorum before allowing
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

### Tool Loop Guard (`tool-loop-guard.ts`) — Sub-Plan 08, retuned in Plan 22

Prevents agents from infinite tool-call loops with per-tool scoping and split budgets:
- Tracks total invocations per `toolName::args` key
- **Read-only tools** (read_file, list_dir, search_code, git tools) cache results; duplicates return `[CACHED]` (free — no budget consumed)
- **Mutating tools** (write_file, edit_file, etc.) clear all caches (workspace changed)
- 3rd identical call blocks ONLY that specific `(tool, args)` — other tools keep working
- **Split budgets** (`TOOL_BUDGETS_JSON`): separate read/write/shell/turn ceilings per rank — principal 60/30/14/28, senior 50/25/12/24, junior 40/20/12/20
- **Turn ceiling** (Plan 22 A2): a model turn costs 1 turn regardless of how many tools it calls in parallel. The turn key comes from `config.metadata.langgraph_step`, with time-window batching as a fallback
- **Progress bonus**: agents that produce real writes get `LOOP_GUARD_PROGRESS_BONUS` (10) extra read calls
- **Hard ceiling**: `LOOP_GUARD_HARD_CEILING` (140) absolute stop across all categories
- **Budget pressure footer** (Plan 22 A3): successful tool results carry `[BUDGET: …]` above 60 % usage and `[BUDGET CRITICAL: …]` above 85 %, so the agent can plan its landing
- **Terminal guidance**: on exhaustion, injects "return your JSON now, do not claim files you did not write"
- **Forced termination** (Plan 22 A4): after `MAX_POST_EXHAUSTION_CALLS` (2) guidance responses, `isTerminationDemanded()` becomes true and the agent factory sets `tools: []` + `toolChoice: 'none'` on the next model call. Throwing from a tool does **not** work — LangGraph's ToolNode converts tool errors into ToolMessages and the loop continues
- **Legacy mode**: numeric `maxTotalCalls` parameter still works for reviewer / pipeline agents

> **Plan 22 A1 — load-bearing wiring.** `buildAgent()` must pass `cfg.toolBudgets` (an object)
> to `withLoopGuard`, not `cfg.maxToolCalls` (a number). A number selects the legacy flat-ceiling
> path, which leaves the entire category system — and `resolveToolBudgets()` — as dead code.
> That was the state until Plan 22: a Claude dev agent that batched 9–11 reads into one turn spent
> a 26-unit budget in 5 turns and could then write nothing, so 3 of 6 dev generations in the
> pacmanclaude run produced zero writes. The budget must be denominated in turns and categories,
> never in a single pool of tool calls.

### History Compaction & the Write Boundary (Plan 22, B1–B4)

`compactHistory()` shrinks the ReAct history the model sees. Three invariants keep it from
corrupting the product:

| Invariant | Where | Why |
|-----------|-------|-----|
| The elision marker is `⟪ORCHESTRATOR-ELIDED <n> chars of <what> — already on disk; NEVER copy this marker into a file⟫` | `history-compactor.ts` | The old marker was `[1204 chars elided]`. After seeing fifteen of those in its own compacted history, a dev agent emitted `write_file("src/persistence/SettingsStore.ts", "[770 chars elided]")` for **three brand-new files** — pattern imitation. The marker must not look like plausible source text and must carry its own instruction. |
| `write_file` / `edit_file` **reject** a payload that is an elision marker | `checkWritePayload()` in `workspace-tools.ts` | The only enforcement that cannot be bypassed by prompting. Deliberately narrow: an exact, whole-payload marker match. A "minimum plausible source length" rule was tried and removed — `export const x = 2;` is 19 characters. |
| The recent window is measured in **model turns** (`HISTORY_KEEP_RECENT_TURNS`, default 3), not tool results | `history-compactor.ts` | With 8–11 parallel calls per turn, "keep the last 4 results" preserved exactly ONE turn, so agents re-read files they had just read and exhausted their tool budget doing it. `HISTORY_KEEP_RECENT_TOOL_RESULTS` survives as a lower bound (`min()` of the two boundaries wins). |
| The last `HISTORY_KEEP_RECENT_WRITE_ARGS` (2) write turns keep their arguments verbatim | `history-compactor.ts` | The model needs its most recent writes intact to diff against, and this is exactly the window where placeholder imitation was observed. |
| Fresh `AIMessageChunk`s are normalised **before** they enter graph state | `normaliseAIMessageForState()`, `afterModel` middleware | `sanitizeStreamingContentBlocks()` works on a copy by design, so residue accumulated in the checkpoint and was re-scanned every turn — the cause of the `dropped 2 … dropped 31` monotonic growth in the run log. |

### Respawn Handoff (`agent-respawn.ts`) — Sub-Plan 08, fixed in Plan 22

When a dev agent hits its ceiling it is respawned with a fresh context plus a deterministic
handoff (no extra LLM call). Plan 22 made the handoff actually useful:

- **`buildHandoff` must be called with `worktreeDir` + `baseRef`** (C1). Without them
  `worktreeVerified` is always false, byte sizes are absent, there is no tree snapshot, and
  `filesWritten` is the agent's *claim* — which is how generations with committed work were
  terminated for "zero writes". `pr-workflow.ts` passes `respawnCtx` at all 7 call sites.
- **`filesRead` + `treeSnapshot` + `budgetSpent`** are carried forward (C2). Dumps 019/020/021 of
  the pacmanclaude run each re-read the same 24 files; the successor now starts with an inventory.
- **`madeProgress()`** counts a passing build/test/lint command as progress, not just writes (C3),
  and consecutive no-progress generations are capped at `MAX_CONSECUTIVE_ZERO_WRITE_GENERATIONS` (1)
  — `junior-react` previously burned 4 respawns and 882 k input tokens on reconnaissance.
- `git status` is read with **`--porcelain --untracked-files=all`**: plain `--short` collapses a
  wholly-untracked directory to a single `?? src/` entry, so a generation that created
  `src/a.ts`, `src/b.ts`, … was recorded as having written the directory `src/`.

### Integrity Gate Policy (Plan 22, F2/F3)

- **Browser-driven specs are exempt from the import-graph rules.** A Playwright/Cypress spec
  imports nothing from the product tree by construction. `isBrowserDrivenTest()` detects them by
  path (`**/e2e/**`, `*.e2e.spec.*`, `cypress/**`), by import (`@playwright/test`, `cypress`,
  `selenium-webdriver`, …) or by API use (`page.goto(`, `cy.visit(`). They are instead checked for
  the presence of *any* assertion (`no-assertions`).
- **Severity is split.** `tautological-assertion`, `single-arithmetic-test` and `no-assertions` are
  unambiguous gate-gaming and stay `critical`. `no-product-import` and `subject-not-in-product` are
  heuristic import-graph results and are downgraded to `major` (report only).
- **Deletion is opt-in** (`GATE_INTEGRITY_DELETE_TRIVIAL_TESTS`, default `false`) and only ever
  applies to `critical` findings; every body is archived to `outputs/<run>/deleted-tests/` first.
  Previously the gate deleted four legitimate Playwright specs plus a unit test, pushed the
  deletion, and the reviewer then filed `[MAJOR] No test files exist`.

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

### Run Budget & Graceful Shutdown (`run-budget.ts`, `provider-failure.ts`)

Graceful degradation on budget limits with four levels:
- **ok/warn**: Full config limits
- **degrade**: 1 review iteration, 1 reviewer, 0 repair attempts, 0 bugfix iterations
- **stop**: No new branch workflows; `shouldStopRun()` returns `true`, triggering `checkBudgetStop()` in the next node to set `cancelled=true` + `_stopReason`, routing to finalize
- Three limits: `MAX_RUN_TOKENS`, `MAX_RUN_COST_USD`, `MAX_RUN_WALL_MS`

**Provider failure handling** (`provider-failure.ts`, `dispatcher.ts`):
- Errors are classified into `billing`, `auth`, `quota`, `model-not-found`, `transient`, and `unknown`
- **Fatal errors** (`auth`, `model-not-found`): dispatch stops immediately; `providerFailureKind` is set on `DispatchResult`
- **Pauseable errors** (`billing`, `quota`): `awaitProviderRecovery()` probes the provider's `/models` endpoint with exponential backoff via `createProviderProbe()`. If recovery fails, `providerFailureKind` is set
- `developmentNode` checks `result.providerFailureKind` and returns `{ cancelled: true, _stopReason: 'provider-<kind>' }`, routing to finalize
- Planning-phase provider failures propagate as unhandled exceptions, caught by `run.ts` crash snapshot

**Periodic state snapshots** (`run-snapshot.ts`):
- Every node writes a `writePeriodicSnapshot()` at `phase:start` — captures the full accumulated state from all previous phases plus a `latest-phase.json` marker
- Ensures continue-run has a recent snapshot even if the process crashes mid-phase
- `checkBudgetStop()` also writes a snapshot before returning the cancellation update

**Manifest status** includes `'budget-exhausted'` for runs stopped by budget or provider failures. `finalizeNode` checks `_stopReason` to select this status.

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

### Requirements Traceability & AC Coverage (`traceability.ts`, `nodes/qa.ts`) — Sub-Plan 10

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

**DevOps verification** (`devops-verify.ts`, `devops-fallback.ts`, `nodes/devops.ts`):
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
- **Secret scan**: Regex patterns for AWS keys, private keys, GitHub tokens, JWTs, generic secrets; falls back to filesystem walk when git is unavailable (Plan 25, 26-04 &sect;3)
- **Dependency audit**: Per-stack (npm audit, pip-audit, govulncheck, etc.)
- **Licence check**: SPDX deny-list for npm packages
- Never logs matched values (redaction discipline)
- **Fail-closed**: If any sub-gate crashes, `passed` is `false` and errors are propagated to `verificationErrors` (Plan 25, 26-04 &sect;4)

### Unified Gate Abstraction (`gate-types.ts`, `workspace-index.ts`) — Sub-Plan 26-10

All gate modules now share a common result contract via types in `gate-types.ts`:

- **`GateStatus`**: `'passed' | 'failed' | 'error' | 'skipped'`
- **`FindingSeverity`**: `'critical' | 'major' | 'minor' | 'info'`
- **`GateFinding`**: `{ rule, severity, message, file?, line? }`
- **`GateOutcome<R>`**: `{ status, findings, detail: R }` — generic over each gate's native detail type
- **`WorkspaceIndex`**: pre-built file index type (source files, test files, config files)

Every gate module exports a `*GateOutcome()` adapter function that converts its native result to a
standard `GateOutcome`. The workspace index is built once via `buildWorkspaceIndex()` in
`workspace-index.ts` and passed to all gates, avoiding redundant filesystem walks.

All `gate:result` event emissions now include a `gate: string` discriminator field so consumers can
identify which gate produced the event.

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

### Architecture Contract (`repo-contract.schema.ts`, `repo-contract-writer.ts`) — Sub-Plan 05

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
- **Layout Linter** — removed in Sub-Plan 26-10 (`layout-lint.ts` was dead code, never called in production).
- **Architect**: `tools: []` (JSON mode active), prompt includes `<repo_contract>` section,
  output includes `repoContract` field. `architectNode` caps modules at `REPO_CONTRACT_MAX_MODULES`.
- **All agents** receive the contract in their context (priority 1). Developer persona includes
  `<repo_contract>` block. Reviewers have a stub carve-out for scaffold stubs.
- **Env vars**: `REPO_CONTRACT_MAX_MODULES` (60), `CONTRACT_PROMPT_MAX_CHARS` (6000).
  `REPO_CONTRACT_MODE` and `CONTRACT_STUB_SCAFFOLD` were removed in Sub-Plan 26-10.

### Structured Output (`structured-output.ts`)

Robust JSON extraction from LLM responses:
1. Direct `JSON.parse`
2. Code fence extraction (```json ... ```)
3. Balanced braces extraction
4. `jsonrepair` for truncated/malformed JSON (sets `wasTruncated` flag)
5. `detectTruncation()` for structural completeness check
6. `repairFieldViolations()` -- deterministic field-level repair (enum near-miss, scalar/array coercion, type coercion) before LLM repair
7. Zod validation with repair loop (re-invoke agent with issue summary, 16k middle-clip budget)

Content-block handling (same module, used before any of the above):
- `extractTextFromContentBlocks(content)` -- concatenates payload blocks (`text`, `output_text`, any non-thinking block with a string `text`), skips `reasoning`/`thinking`/`refusal`, returns `null` when nothing usable
- `extractAgentText(messages)` -- locates the payload in a LangGraph result: last message first, then walks back over **AI messages only** (never tool output); reports `source`, `blockTypes` census and `truncatedByTokenLimit` (from `finish_reason`/`stop_reason`/`status`)
- `describeContentBlocks(content)` -- `"reasoning×2, text×1"` census for diagnostics

### Full-Response Log (`response-log.ts`)

`initResponseLog(outputPath)` (intake) + `logAgentResponse(meta, result)` (every agent
invocation, including repair attempts) write `outputs/<run>/full-responses/<seq>-<agent>-<phase>[-repair<n>].json`
with `{ meta, user_message, model_request: { messages, structuredResponse? } }`, plus one
summary line per invocation in `index.jsonl`. Never throws; a write failure is a warning.

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

## Continue Run (Plan 23) & Graceful Shutdown (Plan 24)

When a run stops — whether from a crash, error, SIGINT, budget exhaustion, provider failure, or manual cancellation — the **Continue Run** feature reconstructs pipeline state from persisted artifacts and resumes execution from the last completed phase. **Periodic state snapshots** written at the start of each phase ensure a recent snapshot is always available, even after mid-phase crashes.

### Graceful Shutdown Flow

Budget exhaustion and provider failures trigger a graceful shutdown that preserves state for continue-run:

```
Budget reaches 'stop' level  ─┐
                               ├─→ checkBudgetStop() ─→ { cancelled: true, _stopReason }
Provider billing/auth fails  ─┘    writePeriodicSnapshot()    ├─→ graph routes to finalizeNode
                                                               ├─→ manifest status: 'budget-exhausted'
                                                               └─→ state.json has _stopReason for continue-run
```

| Trigger | Where Detected | Mechanism |
|---------|----------------|-----------|
| **Token/cost/wall-clock limit** | `checkBudgetStop()` in each node | `shouldStopRun()` checks budget level; emits `run:budget-stop`; returns `{ cancelled: true, _stopReason: 'budget-exhausted:<binding>' }` |
| **Provider billing/quota** (recoverable) | `dispatcher.ts` | `awaitProviderRecovery(createProviderProbe())` probes `/models` endpoint; on failure sets `providerFailureKind`; `developmentNode` returns `{ cancelled: true, _stopReason: 'provider-billing' }` |
| **Provider auth/model-not-found** (fatal) | `dispatcher.ts` | Immediate stop — `providerFailureKind` set, `run:provider-stop` emitted |
| **HITL deny** | Graph HITL interrupt | `cancelled = true` (no `_stopReason`) |
| **Crash/SIGINT** | `run.ts` catch block | Best-effort crash snapshot with status `'crashed'` |

### Architecture

```
collectRunState() → reconstructState() → rehydrateSingletons() → reconcileGitState() → conductor.invoke()
```

| Step | Module | Purpose |
|------|--------|---------|
| **Collect** | `src/conductor/continue/state-collector.ts` | Read-only scan of `outputs/<run>/` — reads `state.json`, `run-manifest.json`, `ledger.jsonl`, `token-usage.json`, agent artifacts, git branches. `listStoppedRuns()` surfaces `stopReason` from saved state |
| **Reconstruct** | `src/conductor/continue/state-reconstructor.ts` | Build a valid `ProjectState` from collected artifacts; rehydrate secrets from `.env`; resolve the resume phase |
| **Rehydrate** | `src/conductor/continue/singleton-rehydration.ts` | Reinitialise global singletons: run log, ledger, response log, token tracker, run budget, local bare repo |
| **Reconcile** | `src/conductor/continue/git-reconciliation.ts` | Clean up stale worktrees/lock files, checkout system branch, sync with remote, delete stale branches |
| **Invoke** | `src/conductor/run.ts` (`continueRun()`) | Inject reconstructed state with `_isContinuation=true` + `_resumePhase`; **clears `cancelled` and `_stopReason`** from the previous run; graph nodes skip completed phases via `shouldSkipOnContinue()` |

### State Reconstruction Paths

| Path | Trigger | Confidence |
|------|---------|-----------|
| **Primary** | `state.json` exists | `full` |
| **Fallback** | Only `run-manifest.json` exists | `partial` |
| **Degraded** | Only `ledger.jsonl` exists | `minimal` |

### Phase Resolution

Phases are walked in pipeline order; each phase requires both ledger evidence (end event) and state evidence (e.g., `architecture != null`, `epics.length > 0`). The first phase without evidence is the resume point. Special cases:
- **Intake**: always skipped (workspace already exists)
- **Development**: counts pending assignments; all completed → advances past. If any PRs have `status: 'pr-creation-failed'`, `developmentNode` retries PR creation via `retryFailedPRCreation()` before dispatching new assignments — no dev agent re-run, just the GitHub API call
- **Bugfix loop**: `iteration.bugfix` and `fixedBugIds` are preserved
- **Finalize**: always re-run

### PR Branch Status on Continue-Run

`inferPRBranchStatus()` maps PR status to branch handling:

| PR Status | Branch Status | Git Action |
|-----------|--------------|------------|
| `merged` | `merged` | Delete local branch |
| `open` / `approved` / `escalated_open` | `open` | Delete local branch (re-created on dispatch) |
| `pr-creation-failed` | `pr-creation-failed` | **Keep** branch — PR creation will be retried |
| `blocked` / `closed` (local branch exists) | `open` | Delete local branch |
| salvaged | `failed-salvaged` | Delete local branch |

### Node Idempotency

Every pipeline node except `finalizeNode` calls `shouldSkipOnContinue(state, currentPhase, logger)` at the top. Returns `true` when `_isContinuation` is set and the current phase's index is before the resume phase. Skipped nodes return `{ phase: currentPhase }` — a no-op that maintains correct pipeline state without side effects.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTINUE_TOKEN_CARRY_FORWARD` | `true` | Include previous run's token usage in budget calculations |
| `CONTINUE_GIT_RECONCILE` | `true` | Auto-fix git state issues before resuming |
| `CONTINUE_CLOSE_STALE_PRS` | `true` | Close open GitHub PRs from previous run that will be re-dispatched |

### Entry Points

| Interface | Trigger |
|-----------|---------|
| **CLI** | Menu option 4: "Continue a stopped run" — lists runs, shows summary, confirms |
| **REST API** | `GET /api/runs/stoppable` + `POST /api/run/continue` |

### Files

```
src/conductor/continue/
  index.ts                    # Barrel export
  state-collector.ts          # collectRunState(), findRunOutputs(), listStoppedRuns() (with stopReason)
  state-reconstructor.ts      # reconstructState(), resolveResumePhase() (internal)
  singleton-rehydration.ts    # rehydrateSingletons()
  git-reconciliation.ts       # reconcileGitState()
src/conductor/run.ts          # continueRun() (clears cancelled + _stopReason), ContinueRunOptions
src/conductor/state.ts        # _isContinuation, _resumePhase, _stopReason fields
src/conductor/nodes/_guards.ts # shouldSkipOnContinue(), phaseNode() decorator, checkBudgetStop() + guards on all nodes
src/conductor/provider-failure.ts  # classifyProviderFailure(), ProviderRecoveryFailedError
src/utils/run-budget.ts       # shouldStopRun(), getBudgetStatus(), getEffectiveLimits()
src/utils/run-snapshot.ts     # writePeriodicSnapshot(), writeRunManifest() (with 'budget-exhausted' status)
src/utils/llm-throttle.ts     # awaitProviderRecovery(), createProviderProbe()
src/utils/event-bus.ts        # run:budget-stop, run:provider-stop event types
tests/continue-run.test.ts    # Unit tests (state collector, reconstructor, phase resolver)
tests/continue-integration.test.ts  # Integration tests (full flow, singletons, git)
```

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
| `npm test` | Unit tests only (integration tests excluded via `testPathIgnorePatterns`) |
| `npm run test:unit` | Unit tests only (excludes greenfield/maintain/replay) |
| `npm run test:greenfield` | Greenfield integration test (requires LLM keys) |
| `npm run test:maintain` | Maintain-mode integration test (requires LLM keys) |
| `npm run test:replay` | Cassette replay test |
| `npm run test:oauth` | OAuth integration test |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `tsc --noEmit --noUnusedLocals --noUnusedParameters` |

### Test Infrastructure
- **Framework**: Jest with ts-jest
- **Setup**: `tests/setup.ts` (crypto polyfill, env loading) + `tests/setup-env-guard.ts` (env snapshot/restore per test)
- **Timeout**: 10,000ms (10s) default; integration tests set per-test timeouts
- **restoreMocks**: `true` — all mocks auto-restored after each test
- **testPathIgnorePatterns**: `greenfield`, `maintain`, `oauth`, `pipeline-replay`, `/tests/fixtures/`
- **Transform**: Handles ESM packages (`@octokit`, `universal-user-agent`, `before-after-hook`)
- **Logger mock**: Manual mock at `src/utils/__mocks__/logger.ts` — call `jest.mock('../src/utils/logger')` (no factory needed)
- **CI**: `.github/workflows/ci.yml` — typecheck, unit tests, dashboard build

### Shared Test Helpers (`tests/helpers/`)
- **`state-factory.ts`**: `makeState(overrides?)` — canonical `ProjectStateType` fixture with all 48 fields. Use instead of copy-pasting the state literal.
- **`tmp.ts`**: `makeTempDir(prefix)`, `cleanupDir(dir)`, `withTempDir(prefix, fn)` — temp directory lifecycle.
- **`git.ts`**: `git(cwd, args, timeout?)`, `createTestRepo(prefix)` — isolated git execution (no system config, deterministic author/committer).

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
6. Add node function to `src/conductor/nodes/` (create a new file or add to an existing phase file, then re-export from `nodes/index.ts`)
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

1. Add to `src/config.ts` using `envInt()`, `envFloat()`, `envBool()`, or `envEnum()` helpers (never raw `parseInt`/`parseFloat`)
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

Every node function in `nodes/` follows the `phaseNode()` decorator pattern (or the manual equivalent for unique control flow):
```typescript
export async function someNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // 1. Continue-run idempotency: skip if this phase completed in a previous run
    if (shouldSkipOnContinue(state, 'some-phase', logger)) {
        return { phase: 'some-phase' as PhaseName };
    }
    // 2. Phase lifecycle + periodic snapshot for crash recovery
    emitRunEvent('phase:start', { phase: 'some-phase' });
    writePeriodicSnapshot(state.outputPath, state, 'some-phase');
    // 3. Budget exhaustion check — routes to finalize via cancelled=true
    const budgetStop = checkBudgetStop(state, 'some-phase' as PhaseName, logger);
    if (budgetStop) return budgetStop;
    // 4. Rerun check (HITL enhance feedback)
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

> **Invariant:** Every node except `intakeNode` and `finalizeNode` must call `shouldSkipOnContinue()`, `writePeriodicSnapshot()`, and `checkBudgetStop()` at the top. `acceptanceNode` skips the budget check (lightweight, must always run).

### Error Handling

- `retryWithBackoff()` wraps all agent invocations (rate-limit aware, configurable attempts)
- Node functions catch agent failures and log errors but generally don't crash the pipeline
- `invokeAgent()` includes schema validation with repair loop
- `run.ts` catches crashes and writes best-effort state snapshots (`writeStateSnapshot` + `writeRunManifest` with `'crashed'` status)
- Signal handlers flush token reports on unexpected exits
- **Budget exhaustion**: `checkBudgetStop()` at the start of each node catches the `'stop'` level and routes to finalize gracefully (no exception, no crash)
- **Provider failures**: Dispatcher sets `providerFailureKind` on the result; `developmentNode` translates this to `{ cancelled: true, _stopReason }`. Planning-phase provider failures propagate as exceptions and are caught by the `run.ts` crash path
- **Periodic snapshots** (`writePeriodicSnapshot` at each `phase:start`) ensure the latest complete state is always on disk for continue-run recovery

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
| 21 | Claude run errors: Anthropic streaming corruption, Responses-API JSON mode, runaway detection, universal token accounting |
| 22 | pacmanclaude forensics: tool-budget collapse under parallel tool calls, compaction placeholder corruption, blind respawn handoff, dead scaffold barrier, e2e integrity false positives, Anthropic prompt caching |
| 23 | Continue Run: state reconstruction from persisted artifacts, singleton rehydration, git reconciliation, phase resolution, node idempotency |
| 24 | Anthropic truncation detection, PM token ceiling, trimTruncatedArrayTails, PR creation resilience (retry + pr-creation-failed status + continue-run recovery), periodic snapshots, budget-exhaustion-to-cancellation bridge, provider-failure-to-cancellation bridge, budget-exhausted manifest status, continue-run stop-reason awareness |
| 25 | Codebase audit remediation: config hardening, env-var centralisation |
| 26-05 | Utility extraction: created 8 shared utilities (fs-walk, source-graph, markdown-table, shell-exec, bug-factory, branch-naming, artifact-writer, gate-types) |
| 26-06 | Utility deduplication: migrated all consumers to shared utilities (shell-exec 3 files, markdown-table 11 files/23 tables, bug-factory 7 files/19 sites, branch-naming 6 files/13 sites, artifact-writer 8 files/13 sites). Fixed continue-run slug mismatch bug, added missing pipe-escaping to 9 of 11 table sites, added missing error handling to 3 output-write sites |
| 26-10 | Unified Gate abstraction: `gate-types.ts` exports `GateStatus`, `FindingSeverity`, `GateFinding`, `GateOutcome<R>`, `WorkspaceIndex`; every gate module exports a `*GateOutcome()` adapter; `workspace-index.ts` builds a shared file index once; `gate:result` events carry a `gate` discriminator. Removed dead code: `layout-lint.ts`, `REPO_CONTRACT_MODE`, `CONTRACT_STUB_SCAFFOLD` |

When referenced in code comments, these plans are cited as "fixes A1", "fixes A2", etc. (referring to sub-plans within Plan 16).

---

## Common Gotchas

1. **`env.ts` must be imported first** -- Before any module that reads `process.env`. Uses `override: true` so `.env` wins over shell vars.
2. **Append vs Replace reducers** -- Arrays use append (data accumulates); scalars/objects use replace (last write wins). Returning `[]` for an append field adds nothing, not clears it.
3. **Agent recursion limits differ by type** -- Pipeline agents: 15, tool-using pipeline agents: 120, dev agents: 140, reviewers: 40. (Sub-Plan 08: raised from 15/60/58/26 because the loop guard is now the binding constraint.)
4. **Tool budgets are split by category AND by turn (Sub-Plan 08 + Plan 22)** -- Read/write/shell/turn budgets per rank: principal 60/30/14/28, senior 50/25/12/24, junior 40/20/12/20. Reviewer: 14 total calls (legacy flat mode). Progress bonus grants 10 extra reads when writing. Hard ceiling: 140.
   **The turn ceiling is the important one.** Claude emits up to 11 tool calls in a single turn, so a
   budget denominated in tool calls gives it ~5 turns where it gives an OpenAI model 26. If you ever
   see `buildAgent()` being handed `maxToolCalls` for a dev agent again, the whole category system is
   silently disabled — that was the Plan 22 root cause.
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

Additional failure modes found in `pacmanclaude2` run (2026-08-17, fixed post-Plan 24):

13. **Anthropic truncation not detected.** `extractAgentText()` only checked `response_metadata`
    for `stop_reason`, but Anthropic's LangChain adapter puts it in `additional_kwargs`. PM hit
    `max_tokens` at 32005 tokens without the system knowing. Fixed: also check `additional_kwargs.stop_reason`.
14. **Planning token ceiling too low.** `PLANNING_MAX_OUTPUT_TOKENS=32000` was insufficient for
    complex PM outputs (35 stories + 66 tasks for Pac-Man). Raised to 64000.
15. **No truncation recovery.** When `jsonrepair` salvaged truncated JSON, the last array element
    had missing required fields (e.g. `layer: undefined`). The repair loop couldn't regenerate
    32K+ tokens. Fixed: `trimTruncatedArrayTails()` trims incomplete trailing elements and accepts
    the valid prefix rather than rejecting the entire output.
16. **Stale tests after Plan 24.** `escalation.test.ts` expected `null` for unknown agents (Plan 24
    B1 added fallback), `strong-fixer.test.ts` expected `MAX_TOOL_CALLS=40` (Plan 24 B2 changed to 18).
17. **Transient GitHub 503 crashed the run and burned tokens.** PR creation hit "No server is
    currently available" (GitHub 503). No retry logic existed, so the error threw, was swallowed
    by `Promise.allSettled` in the dispatcher, and the run continued dispatching all remaining
    branches (wasting tokens on branches that depended on the failed scaffold). Fixed: (a) retry
    with exponential backoff (3 attempts); (b) `pr-creation-failed` status persisted in state
    instead of throwing; (c) dispatcher stops all subsequent branches on failure; (d) continue-run
    retries just the PR creation via `retryFailedPRCreation()` without re-running dev agents.
