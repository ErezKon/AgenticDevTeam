/**
 * Central configuration module.
 *
 * All external URLs, tokens, and settings are read from environment
 * variables here — nothing is hardcoded to a specific vendor.
 */

// ─── LLM ────────────────────────────────────────────────────────────────────

/** OpenAI-compatible LLM base URL (no trailing slash). */
export const LLM_BASE_URL =
    process.env.LLM_BASE_URL;

/** Default chat model name (global fallback). */
export const LLM_MODEL =
    process.env.LLM_MODEL ?? 'gpt-oss-120b';

// ─── Per-Agent Models ───────────────────────────────────────────────────────

/** Architect agent model. */
export const ARCHITECT_MODEL =
    process.env.ARCHITECT_MODEL ?? 'gpt-oss-120b';

/** Product Manager agent model. */
export const PRODUCT_MANAGER_MODEL =
    process.env.PRODUCT_MANAGER_MODEL ?? 'gpt-oss-120b';

/** DBA agent model. */
export const DBA_MODEL =
    process.env.DBA_MODEL ?? 'gpt-oss-120b';

/** Team Leader agent model. */
export const TEAM_LEADER_MODEL =
    process.env.TEAM_LEADER_MODEL ?? 'gpt-oss-120b';

/** DevOps agent model. */
export const DEVOPS_MODEL =
    process.env.DEVOPS_MODEL ?? 'gpt-oss-120b';

/** Codebase Analyzer agent model. */
export const CODEBASE_ANALYZER_MODEL =
    process.env.CODEBASE_ANALYZER_MODEL ?? process.env.ARCHITECT_MODEL;

/** Principal Developer agent model (frontend & backend). */
export const PRINCIPAL_DEV_MODEL =
    process.env.PRINCIPAL_DEV_MODEL ?? 'gpt-oss-120b';

/** Senior Developer agent model (frontend & backend). */
export const SENIOR_DEV_MODEL =
    process.env.SENIOR_DEV_MODEL ?? 'gpt-oss-120b';

/** Junior Developer agent model (all specialties).
 *  Minimum recommended: 20B+ parameters for reliable code generation.
 *  The original 3B default (llama-3-2-3b-instruct) was too small to follow
 *  structured output schemas or create files; agents looped endlessly. */
export const JUNIOR_DEV_MODEL =
    process.env.JUNIOR_DEV_MODEL ?? 'gpt-oss-20b';

/** QA agent model (Lead, Unit, E2E). */
export const QA_MODEL =
    process.env.QA_MODEL ?? 'gpt-oss-20b';

// ─── Model Pricing ──────────────────────────────────────────────────────────

/**
 * Estimated cost per 1K tokens for each configured model.
 *
 * These are configurable defaults based on typical provider pricing.
 * Adjust via the MODEL_PRICING_OVERRIDES env var (JSON string) if needed.
 */
export const MODEL_PRICING: Record<string, { inputPer1k: number; outputPer1k: number }> = {
    'gpt-oss-120b':                      { inputPer1k: 0.006,  outputPer1k: 0.012 },
    'llama-3-3-70b-instruct':            { inputPer1k: 0.003,  outputPer1k: 0.006 },
    'gemma-3-27b-it':                    { inputPer1k: 0.001,  outputPer1k: 0.002 },
    'mistral-small-3-1-24b-instruct-2503': { inputPer1k: 0.001, outputPer1k: 0.002 },
    'llama-3-2-3b-instruct':             { inputPer1k: 0.0003, outputPer1k: 0.0006 },
    'gpt-oss-20b':                       { inputPer1k: 0.001,  outputPer1k: 0.002 },
    // OpenAI public models
    'gpt-5.3-codex':                     { inputPer1k: 0.00175, outputPer1k: 0.014 },
    'gpt-5.4-mini':                      { inputPer1k: 0.00075, outputPer1k: 0.0045 },
    // Anthropic models (Sub-Plan 20)
    'claude-opus-4-20250514':            { inputPer1k: 0.015,  outputPer1k: 0.075 },
    'claude-sonnet-4-20250514':          { inputPer1k: 0.003,  outputPer1k: 0.015 },
    'claude-3-5-haiku-20241022':         { inputPer1k: 0.0008, outputPer1k: 0.004 },
    'claude-opus-4-6':                   { inputPer1k: 0.005,  outputPer1k: 0.025 },
    'claude-opus-4-8':                   { inputPer1k: 0.005,  outputPer1k: 0.025 },
    'claude-opus-5':                     { inputPer1k: 0.005,  outputPer1k: 0.025 },
    'claude-fable-5':                    { inputPer1k: 0.01,   outputPer1k: 0.05 },
    'claude-sonnet-4-5':                 { inputPer1k: 0.003,  outputPer1k: 0.015 },
    'claude-sonnet-4-6':                 { inputPer1k: 0.003,  outputPer1k: 0.015 },
    'claude-haiku-4-5':                  { inputPer1k: 0.001,  outputPer1k: 0.005 },
    'claude-sonnet-5':                   { inputPer1k: 0.002,  outputPer1k: 0.01 },
    // Google Gemini models (Sub-Plan 20)
    'gemini-2.5-pro':                    { inputPer1k: 0.00125, outputPer1k: 0.01 },
    'gemini-2.5-flash':                  { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    'gemini-2.0-flash':                  { inputPer1k: 0.0001,  outputPer1k: 0.0004 },
    // Merge env-based overrides if provided
    ...(process.env.MODEL_PRICING_OVERRIDES
        ? JSON.parse(process.env.MODEL_PRICING_OVERRIDES) as Record<string, { inputPer1k: number; outputPer1k: number }>
        : {}),
};

// ─── Multi-Provider LLM (Sub-Plan 20) ───────────────────────────────────────

/** API key for OpenAI models. When set, used directly instead of OAuth client-credentials flow.
 *  If empty, OpenAI agents fall back to the OAuth token from OAUTH_TOKEN_URL. */
export const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY ?? '';

/** API key for Anthropic models (Claude). Required when any agent model matches /claude|anthropic/i. */
export const ANTHROPIC_API_KEY =
    process.env.ANTHROPIC_API_KEY ?? '';

/** API key for Google Gemini models. Required when any agent model matches /gemini/i. */
export const GOOGLE_API_KEY =
    process.env.GOOGLE_API_KEY ?? '';

/** Optional base URL override for Anthropic (for proxies). */
export const ANTHROPIC_BASE_URL =
    process.env.ANTHROPIC_BASE_URL ?? '';

/** Place `cache_control` breakpoints on the Anthropic system prompt, tool schemas,
 *  task message and stable history prefix (Plan 22, D1).
 *
 *  The pacmanclaude run reported `cache_read: 0` on all 227 Anthropic calls and
 *  billed 2.32M input tokens against 99.7K output for one branch of fifteen. */
export const ANTHROPIC_PROMPT_CACHE_ENABLED =
    (process.env.ANTHROPIC_PROMPT_CACHE_ENABLED ?? 'true') === 'true';

/** Log an ERROR when Anthropic reports zero cache reads after SANITY_ASSERT_CACHE_AFTER
 *  calls (Plan 22, D2). A silent cache miss is expensive and otherwise invisible. */
export const SANITY_ASSERT_CACHE =
    (process.env.SANITY_ASSERT_CACHE ?? 'true') === 'true';

/** Number of Anthropic calls after which the zero-cache assertion fires. */
export const SANITY_ASSERT_CACHE_AFTER =
    parseInt(process.env.SANITY_ASSERT_CACHE_AFTER ?? '20', 10);

/** Optional base URL override for Google (for proxies). */
export const GOOGLE_BASE_URL =
    process.env.GOOGLE_BASE_URL ?? '';

/**
 * Provider detection strategy:
 * - 'auto' (default): Detect provider from model name (claude* -> Anthropic, gemini* -> Google, else -> OpenAI).
 * - 'openai': Force all models through the OpenAI-compatible endpoint (escape hatch for proxies).
 */
export const LLM_PROVIDER_DETECTION =
    (process.env.LLM_PROVIDER_DETECTION ?? 'auto') as 'auto' | 'openai';

// ─── OAuth2 (client-credentials) ────────────────────────────────────────────

/** OAuth2 token endpoint for client-credentials flow. */
export const OAUTH_TOKEN_URL =
    process.env.OAUTH_TOKEN_URL;

export const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? process.env.DELL_CLIENT_ID ?? '';
export const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? process.env.DELL_CLIENT_SECRET ?? '';

// ─── Run behaviour ──────────────────────────────────────────────────────────

/** Run mode: 'autonomous' (no stops) or 'human' (pause after each phase). */
export const RUN_MODE: 'autonomous' | 'human' =
    (process.env.RUN_MODE as 'autonomous' | 'human') ?? 'human';

/** Max bug-fix loop iterations before the conductor gives up. */
export const MAX_BUGFIX_ITERATIONS =
    parseInt(process.env.MAX_BUGFIX_ITERATIONS ?? '3', 10);

/** Allow a hard reset to origin/<branch> when ff/rebase both fail during workspace sync. */
export const WORKSPACE_SYNC_ALLOW_RESET =
    (process.env.WORKSPACE_SYNC_ALLOW_RESET ?? 'true') === 'true';

/** Timeout (ms) for git subcommands that hit the network (fetch/push/clone).
 *  The default 30 s local timeout is too tight for a GitHub fetch on a loaded
 *  machine, and a SIGTERM'd git produces an empty error (Plan 21, E6). */
export const GIT_NETWORK_TIMEOUT_MS =
    parseInt(process.env.GIT_NETWORK_TIMEOUT_MS ?? '120000', 10);

/**
 * LangGraph recursion limits per agent type.
 *
 * Pipeline agents (architect, PM, DBA, TL, QA) need very few tool calls (1-5).
 * Developer agents need many tool calls (read, create/edit, run tests).
 * LangGraph counts 2 steps per tool call (LLM + tool), so limit ÷ 2 ≈ max calls.
 * Reviewer agents need 5-7 (diff, log, review comments, produce JSON).
 *
 * With split read/write/shell budgets (Sub-Plan 08), the loop guard is the
 * binding constraint — the recursion limit is a safety net, not the primary
 * stop mechanism.  6 × `Recursion limit of 58` killed dev agents mid-work
 * in pacman8 alone; raised to 140 so the loop guard fires first.
 *
 * Per-type env vars override the global fallback.
 */
export const PIPELINE_RECURSION_LIMIT =
    parseInt(process.env.PIPELINE_RECURSION_LIMIT ?? process.env.AGENT_RECURSION_LIMIT ?? '15', 10);

/** Dev recursion limit.  Was 58 — raised to 140 because 6 recursion-limit kills
 *  in pacman8 destroyed dev agents mid-work.  The loop guard (read/write/shell
 *  budgets) is now the binding constraint. */
export const DEV_RECURSION_LIMIT =
    parseInt(process.env.DEV_RECURSION_LIMIT ?? process.env.AGENT_RECURSION_LIMIT ?? '140', 10);

/** Reviewer recursion limit.  Was 26 — raised to 40 because reviewers abstained
 *  on recursion limits and that counted as approval under the old policy. */
export const REVIEWER_RECURSION_LIMIT =
    parseInt(process.env.REVIEWER_RECURSION_LIMIT ?? process.env.AGENT_RECURSION_LIMIT ?? '40', 10);

/**
 * Recursion limit for pipeline agents that USE TOOLS (codebase-analyzer,
 * qa-unit, qa-e2e, devops). These agents explore the workspace, write files
 * and run commands, so 15 (PIPELINE_RECURSION_LIMIT) is far too low — it
 * killed the whole run at the QA phase in runs 5 and 6.
 * Was 60 — raised to 120 because qa-unit was poisoned at 6–7 calls in all
 * 8 QA phases across both runs.
 */
export const TOOL_PIPELINE_RECURSION_LIMIT =
    parseInt(process.env.TOOL_PIPELINE_RECURSION_LIMIT ?? '120', 10);

/** Loop-guard ceiling (total tool calls) for tool-using pipeline agents.
 *  Was 25 — raised to 50 because qa-unit was poisoned at 6–7 calls in all
 *  8 QA phases across both runs. */
export const TOOL_PIPELINE_MAX_TOOL_CALLS =
    parseInt(process.env.TOOL_PIPELINE_MAX_TOOL_CALLS ?? '50', 10);

/** Loop-guard ceiling for reviewer agents (must be < REVIEWER_RECURSION_LIMIT / 2).
 *  Was 8 — raised to 14 because reviewers abstained on budget exhaustion. */
export const REVIEWER_MAX_TOOL_CALLS =
    parseInt(process.env.REVIEWER_MAX_TOOL_CALLS ?? '14', 10);

/** @deprecated Use per-type limits (PIPELINE_RECURSION_LIMIT, DEV_RECURSION_LIMIT, REVIEWER_RECURSION_LIMIT). */
export const AGENT_RECURSION_LIMIT =
    parseInt(process.env.AGENT_RECURSION_LIMIT ?? '30', 10);

/**
 * Terminal-guidance responses an agent may receive before the factory withholds
 * tools from the next model call, forcing the ReAct loop to end (Plan 22, A4).
 *
 * The pacmanclaude run burned 3–4 further ~10k-token turns per generation after
 * the budget was gone, because nothing stopped the loop.
 */
export const MAX_POST_EXHAUSTION_CALLS =
    parseInt(process.env.MAX_POST_EXHAUSTION_CALLS ?? '2', 10);

/** Max file-change entries injected into the dev context prompt.
 *  Lowered from 60 to 25 — summariseFileChanges now groups by directory
 *  so fewer entries convey the same information. */
export const DEV_CONTEXT_FILE_CHANGES_LIMIT =
    parseInt(process.env.DEV_CONTEXT_FILE_CHANGES_LIMIT ?? '25', 10);

/** Max parallel developer agents during fan-out. */
export const MAX_CONCURRENT_DEVS =
    parseInt(process.env.MAX_CONCURRENT_DEVS ?? '2', 10);

/** Delay (ms) between dispatching batches of branches to avoid rate limits. */
export const INTER_BATCH_DELAY_MS =
    parseInt(process.env.INTER_BATCH_DELAY_MS ?? '5000', 10);

// ─── Paths ──────────────────────────────────────────────────────────────────

import * as path from 'path';

/** Root directory for generated products. */
export const GENERATED_PROJECTS_DIR =
    path.resolve(process.env.GENERATED_PROJECTS_DIR ?? './generated-projects');

/** Root directory for run outputs (logs, state, test reports). */
export const OUTPUTS_DIR =
    path.resolve(process.env.OUTPUTS_DIR ?? './outputs');

// ─── Docker ─────────────────────────────────────────────────────────────────

/** Docker Engine host (defaults to local socket). */
export const DOCKER_HOST =
    process.env.DOCKER_HOST ?? undefined;

// ─── DevOps Verification ────────────────────────────────────────────────────

/** Actually build/run Docker artifacts and health-check them after the DevOps agent finishes. */
export const DEVOPS_VERIFY_ENABLED =
    (process.env.DEVOPS_VERIFY_ENABLED ?? 'true') === 'true';

/** Timeout (ms) for each shell step during deployment verification. */
export const DEVOPS_VERIFY_TIMEOUT_MS =
    parseInt(process.env.DEVOPS_VERIFY_TIMEOUT_MS ?? '600000', 10);

/** First host port for mapping container EXPOSE ports during Dockerfile-mode verification. */
export const DEVOPS_VERIFY_BASE_PORT =
    parseInt(process.env.DEVOPS_VERIFY_BASE_PORT ?? '18080', 10);

/** Number of retries for each health-check URL. */
export const DEVOPS_HEALTH_RETRIES =
    parseInt(process.env.DEVOPS_HEALTH_RETRIES ?? '5', 10);

/** Delay (ms) between health-check retries. */
export const DEVOPS_HEALTH_DELAY_MS =
    parseInt(process.env.DEVOPS_HEALTH_DELAY_MS ?? '3000', 10);

/** Tear down containers started by verifyDeployment during finalize. */
export const DEVOPS_TEARDOWN =
    (process.env.DEVOPS_TEARDOWN ?? 'true') === 'true';

/** Allow E2E test failures to trigger a bugfix loop.
 *  Was false — flipped to true because E2E never ran in either post-mortem run,
 *  so the cost concern was hypothetical. With Sub-Plan 03's early-halt and the
 *  run budget, an E2E failure is worth spending a bugfix iteration on. */
export const E2E_BUGFIX_ENABLED =
    (process.env.E2E_BUGFIX_ENABLED ?? 'true') === 'true';

// ─── Run Budget ─────────────────────────────────────────────────────────────

/** Max total tokens for a run. 0 = unlimited (default). All three limits are checked; the closest one binds. */
export const MAX_RUN_TOKENS =
    parseInt(process.env.MAX_RUN_TOKENS ?? '0', 10);

/** Max estimated USD cost for a run.  Was 0 (unlimited) — set to 150 now that
 *  raised budgets make individual agents more expensive.  Sub-Plan 03's early-halt
 *  on unrecoverability is what makes this safe: money goes to runs that can still
 *  succeed, and failing runs stop early. */
export const MAX_RUN_COST_USD =
    parseFloat(process.env.MAX_RUN_COST_USD ?? '150');

/** Max wall-clock time (ms) for a run.  Was 0 (unlimited) — set to 5 hours. */
export const MAX_RUN_WALL_MS =
    parseInt(process.env.MAX_RUN_WALL_MS ?? '18000000', 10);

/** Utilisation threshold for budget warning level (default: 0.70). */
export const BUDGET_WARN_AT =
    parseFloat(process.env.BUDGET_WARN_AT ?? '0.70');

/** Utilisation threshold for budget degrade level (default: 0.90). */
export const BUDGET_DEGRADE_AT =
    parseFloat(process.env.BUDGET_DEGRADE_AT ?? '0.90');

// ─── LLM Output Limits ──────────────────────────────────────────────────────

/** Hard output-token ceiling for all agents (default 16 000). */
export const LLM_MAX_OUTPUT_TOKENS =
    parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? '16000', 10);

/** Output-token ceiling for planning agents (architect, PM, DBA, team-leader). Default 32 000. */
export const PLANNING_MAX_OUTPUT_TOKENS =
    parseInt(process.env.PLANNING_MAX_OUTPUT_TOKENS ?? '32000', 10);

/** Per-request LLM timeout (ms). The hardcoded 120 000 was too short for long planning generations. */
export const LLM_REQUEST_TIMEOUT_MS =
    parseInt(process.env.LLM_REQUEST_TIMEOUT_MS ?? '300000', 10);

// ─── Agent Output Validation ────────────────────────────────────────────────

/** Number of repair attempts when agent output fails schema validation (0 disables). */
export const AGENT_OUTPUT_REPAIR_ATTEMPTS =
    parseInt(process.env.AGENT_OUTPUT_REPAIR_ATTEMPTS ?? '2', 10);

/** Continuation attempts when an agent's JSON output is truncated mid-array. */
export const AGENT_OUTPUT_CONTINUATION_ATTEMPTS =
    parseInt(process.env.AGENT_OUTPUT_CONTINUATION_ATTEMPTS ?? '3', 10);

// ─── Context Budget ─────────────────────────────────────────────────────────

/** Hard character budget for assembled context per agent prompt. */
export const CONTEXT_MAX_CHARS =
    parseInt(process.env.CONTEXT_MAX_CHARS ?? '24000', 10);

/** Max characters for clipped descriptions in architecture summaries. */
export const CONTEXT_MAX_DESC_CHARS =
    parseInt(process.env.CONTEXT_MAX_DESC_CHARS ?? '200', 10);

/** Strip deep description fields from injected JSON Schema to save tokens (default: true). */
export const RESPONSE_SCHEMA_COMPACT =
    (process.env.RESPONSE_SCHEMA_COMPACT ?? 'true') === 'true';

/** Strip ALL descriptions and noise from injected JSON Schema (default: true).
 *  Field names are self-documenting; full descriptions are only useful the first
 *  time a developer sees the schema but are re-billed on every LLM call. */
export const RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS =
    (process.env.RESPONSE_SCHEMA_STRIP_ALL_DESCRIPTIONS ?? 'true') === 'true';

/** Request JSON mode from the LLM API when a responseFormat schema is set (default: true).
 *  Sets `response_format: { type: "json_object" }` on the model, which constrains
 *  the model to always output valid JSON. Requires an OpenAI-compatible API that
 *  supports JSON mode. Disable with LLM_JSON_MODE=false if the API doesn't support it. */
export const LLM_JSON_MODE =
    (process.env.LLM_JSON_MODE ?? 'true') === 'true';

// ─── Context Compaction ─────────────────────────────────────────────────────

/** Max characters any single tool result may contribute to agent history.
 *  Was 6000 — raised to 10000 because a 4,210-char source file read was
 *  being truncated, so agents re-read with offsets (costing more tokens). */
export const MAX_TOOL_RESULT_CHARS =
    parseInt(process.env.MAX_TOOL_RESULT_CHARS ?? '10000', 10);

/** Number of most-recent tool results kept verbatim in ReAct history.
 *  Was 2 — raised to 4 because agents re-read files they had already read
 *  since the result had been stubbed out of history. */
export const HISTORY_KEEP_RECENT_TOOL_RESULTS =
    parseInt(process.env.HISTORY_KEEP_RECENT_TOOL_RESULTS ?? '4', 10);

/** Number of most-recent *model turns* whose tool results are kept verbatim
 *  (Plan 22, B4). This is the primary recent-window control;
 *  HISTORY_KEEP_RECENT_TOOL_RESULTS acts as a lower bound.
 *
 *  Counting individual tool results is wrong for models that batch calls: with
 *  8–11 parallel calls per turn, "keep the last 4 results" put the compaction
 *  boundary *inside* the turn the model was about to reason over, so it re-read
 *  files it had just read and exhausted its tool budget doing it. */
export const HISTORY_KEEP_RECENT_TURNS =
    parseInt(process.env.HISTORY_KEEP_RECENT_TURNS ?? '3', 10);

/** Number of most-recent write turns whose tool-call arguments are NEVER elided
 *  (Plan 22, B3). The model needs its last writes verbatim to diff against, and
 *  this is the window where placeholder imitation was observed. */
export const HISTORY_KEEP_RECENT_WRITE_ARGS =
    parseInt(process.env.HISTORY_KEEP_RECENT_WRITE_ARGS ?? '2', 10);

/** Enable the middleware that compacts ReAct history before each LLM call. */
export const HISTORY_COMPACTION_ENABLED =
    (process.env.HISTORY_COMPACTION_ENABLED ?? 'true') === 'true';

/** Strip streaming residue (`*_delta` blocks, id-less `tool_use` blocks) from
 *  AIMessage content before every LLM call. Guards against the Anthropic
 *  `tool_use.id: Field required` 400 (Plan 21, E1), including on checkpoint resume. */
export const SANITIZE_STREAM_BLOCKS =
    (process.env.SANITIZE_STREAM_BLOCKS ?? 'true') === 'true';

/** Hard character ceiling for the assembled ReAct history passed to the LLM.
 *  Was 30000 — raised to 60000.  With `growth 1.88x` observed, over-aggressive
 *  compaction caused re-reads that cost *more* tokens than the saved context. */
export const HISTORY_MAX_CHARS =
    parseInt(process.env.HISTORY_MAX_CHARS ?? '60000', 10);

/** Inject a distilled conventions digest in the prompt instead of making agents read_file them. */
export const CONVENTIONS_INLINE_DIGEST =
    (process.env.CONVENTIONS_INLINE_DIGEST ?? 'true') === 'true';

/** Give developer agents git tools. The PR workflow already commits/pushes for them. */
export const DEV_GIT_TOOLS_ENABLED =
    (process.env.DEV_GIT_TOOLS_ENABLED ?? 'false') === 'true';

/** Use the short persona variant for developer agents. */
export const PERSONA_COMPACT =
    (process.env.PERSONA_COMPACT ?? 'true') === 'true';

/** Respawn a dev agent with a summarised handoff instead of poisoning tools at the ceiling. */
export const AGENT_RESPAWN_ENABLED =
    (process.env.AGENT_RESPAWN_ENABLED ?? 'true') === 'true';

/** Max respawn generations per logical dev task.
 *  Was 2 — raised to 4 because with a real handoff respawn becomes productive. */
export const AGENT_RESPAWN_MAX_GENERATIONS =
    parseInt(process.env.AGENT_RESPAWN_MAX_GENERATIONS ?? '4', 10);

/** Input-token threshold that triggers a respawn on the next step. */
export const AGENT_RESPAWN_TOKEN_THRESHOLD =
    parseInt(process.env.AGENT_RESPAWN_TOKEN_THRESHOLD ?? '14000', 10);

// ─── Quality Gates ──────────────────────────────────────────────────────────

/** Enable multi-language quality gates (install/build/lint/test) in PR workflow and QA. */
export const QUALITY_GATES_ENABLED =
    (process.env.QUALITY_GATES_ENABLED ?? 'true') === 'true';

/** Which gate steps to run (comma-separated). */
export const QUALITY_GATE_STEPS =
    (process.env.QUALITY_GATE_STEPS ?? 'install,typecheck,build,lint,test').split(',') as ('install' | 'typecheck' | 'build' | 'lint' | 'test')[];

/** Timeout (ms) for each quality gate step (default 5 min). */
export const QUALITY_GATE_TIMEOUT_MS =
    parseInt(process.env.QUALITY_GATE_TIMEOUT_MS ?? '300000', 10);

/** Fail the gate when a stack's toolchain is missing (default: true — missing tools fail the gate). */
export const QUALITY_GATE_STRICT_TOOLCHAIN =
    (process.env.QUALITY_GATE_STRICT_TOOLCHAIN ?? 'true') === 'true';

/** Max directory depth scanned when detecting stack roots (monorepo packages). */
export const QUALITY_GATE_SCAN_DEPTH =
    parseInt(process.env.QUALITY_GATE_SCAN_DEPTH ?? '3', 10);

/** Max stack roots gated per run (guards pathological trees). */
export const QUALITY_GATE_MAX_ROOTS =
    parseInt(process.env.QUALITY_GATE_MAX_ROOTS ?? '8', 10);

// ─── Product Verification ───────────────────────────────────────────────────

/** Enable artifact / import-resolution / smoke verification of the generated product. */
export const PRODUCT_VERIFY_ENABLED =
    (process.env.PRODUCT_VERIFY_ENABLED ?? 'true') === 'true';

/** Minimum total bytes a build must emit before it counts as a real build. */
export const PRODUCT_MIN_ARTIFACT_BYTES =
    parseInt(process.env.PRODUCT_MIN_ARTIFACT_BYTES ?? '2048', 10);

/** Max source files scanned by the import-resolution check. */
export const PRODUCT_RESOLVE_MAX_FILES =
    parseInt(process.env.PRODUCT_RESOLVE_MAX_FILES ?? '2000', 10);

/** First host port used by the smoke server (probes upward when busy). */
export const PRODUCT_SMOKE_BASE_PORT =
    parseInt(process.env.PRODUCT_SMOKE_BASE_PORT ?? '18190', 10);

/** Timeout (ms) for the smoke server to become ready and answer. */
export const PRODUCT_SMOKE_TIMEOUT_MS =
    parseInt(process.env.PRODUCT_SMOKE_TIMEOUT_MS ?? '60000', 10);

// ─── Gate Integrity ─────────────────────────────────────────────────────────

/** Baseline-diff enforcement for gate tampering: 'off' | 'warn' | 'enforce'. */
export const GATE_INTEGRITY_MODE =
    (process.env.GATE_INTEGRITY_MODE ?? 'enforce') as 'off' | 'warn' | 'enforce';

/**
 * Delete test files the integrity gate flags as trivial (Plan 22, F3).
 *
 * Default `false`. Trivial-test detection is a heuristic over an import graph and
 * deleting source code on a heuristic is not proportionate: in the pacmanclaude
 * run it removed four legitimate Playwright e2e specs plus one unit test, pushed
 * the deletion, and the reviewer then filed `[MAJOR] No test files exist`.
 *
 * When `false`, findings are still recorded and surfaced to reviewers so the
 * author fixes them. When `true`, only `critical` findings are deletable and every
 * body is archived to `outputs/<run>/deleted-tests/` first.
 */
export const GATE_INTEGRITY_DELETE_TRIVIAL_TESTS =
    (process.env.GATE_INTEGRITY_DELETE_TRIVIAL_TESTS ?? 'false') === 'true';

/** Protect configuration files from agent writes: 'off' | 'warn' | 'deny'. Per-agent overrides apply. */
export const FS_CONFIG_PROTECTION =
    (process.env.FS_CONFIG_PROTECTION ?? 'deny') as 'off' | 'warn' | 'deny';

/** Reject test files whose subject is not reachable from an application entry point. */
export const REJECT_TRIVIAL_TESTS =
    (process.env.REJECT_TRIVIAL_TESTS ?? 'true') === 'true';

// ─── Run Acceptance ─────────────────────────────────────────────────────────

/**
 * What happens when the product does not satisfy the acceptance gate.
 *  'halt'     — stop the pipeline as soon as the outcome is unrecoverable; terminal status 'failed'.
 *  'finalize' — always run to finalize, but the terminal status reflects the gate ('failed'|'partial'|'inconclusive').
 *  'legacy'   — pre-Plan-19 behaviour: always 'completed'. For regression comparison only.
 */
export const RUN_FAIL_POLICY =
    (process.env.RUN_FAIL_POLICY ?? 'halt') as 'halt' | 'finalize' | 'legacy';

/** Minimum number of really-executed tests for the TESTS acceptance criterion. */
export const ACCEPT_MIN_TESTS =
    parseInt(process.env.ACCEPT_MIN_TESTS ?? '1', 10);

/** Treat the SMOKE criterion as required for web products. */
export const ACCEPT_REQUIRE_SMOKE =
    (process.env.ACCEPT_REQUIRE_SMOKE ?? 'true') === 'true';

/** Consecutive zero-output dispatch rounds that mark a run unrecoverable. */
export const UNRECOVERABLE_ZERO_ROUNDS =
    parseInt(process.env.UNRECOVERABLE_ZERO_ROUNDS ?? '2', 10);

// ─── Security Gates ─────────────────────────────────────────────────────────

/** Enable security gates (secret scan, dependency audit, licence check) in QA. */
export const SECURITY_GATES_ENABLED =
    (process.env.SECURITY_GATES_ENABLED ?? 'true') === 'true';

/** When true, critical security findings become Bugs that feed the bug-fix loop. */
export const SECURITY_GATE_BLOCKING =
    (process.env.SECURITY_GATE_BLOCKING ?? 'false') === 'true';

/** Run scanForSecrets on PR worktrees before opening PRs. A critical secret blocks the merge. */
export const SECURITY_GATE_IN_PR =
    (process.env.SECURITY_GATE_IN_PR ?? 'false') === 'true';

/** Enable deep dependency audit (e.g. OWASP dependency-check for Maven). Downloads large CVE DB. */
export const SECURITY_DEEP_AUDIT =
    (process.env.SECURITY_DEEP_AUDIT ?? 'false') === 'true';

/** Comma-separated SPDX licence IDs to deny (e.g. GPL-3.0,AGPL-3.0). Empty = no licence check. */
export const LICENCE_DENYLIST =
    (process.env.LICENCE_DENYLIST ?? '').split(',').map(s => s.trim()).filter(Boolean);

// ─── Shell Tool ─────────────────────────────────────────────────────────────

/** Allow agents to run shell commands on the host (default: true).
 *  Set to false to disable all host shell execution. */
export const SHELL_ALLOW_HOST =
    (process.env.SHELL_ALLOW_HOST ?? 'true') === 'true';

/** Default timeout (seconds) for shell commands when none is specified. */
export const SHELL_DEFAULT_TIMEOUT_S =
    parseInt(process.env.SHELL_DEFAULT_TIMEOUT_S ?? '60', 10);

/** Maximum timeout (seconds) for shell commands — agent-requested values are clamped to this. */
export const SHELL_MAX_TIMEOUT_S =
    parseInt(process.env.SHELL_MAX_TIMEOUT_S ?? '900', 10);

// ─── Playwright MCP ─────────────────────────────────────────────────────────

/** Command to launch the Playwright MCP server. */
export const PLAYWRIGHT_MCP_CMD =
    process.env.PLAYWRIGHT_MCP_CMD ?? 'npx';

/** Arguments for the Playwright MCP server command. */
export const PLAYWRIGHT_MCP_ARGS =
    (process.env.PLAYWRIGHT_MCP_ARGS ?? '@playwright/mcp@latest --headless').split(' ');

// ─── GitHub ──────────────────────────────────────────────────────────────────

/** GitHub Personal Access Token (or app token) for PR operations. */
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

/** GitHub repository owner (org or user). */
export const GITHUB_OWNER = process.env.GITHUB_OWNER ?? '';

/** GitHub repository name. */
export const GITHUB_REPO = process.env.GITHUB_REPO ?? '';

/** The main/master branch name to merge PRs into. */
export const GIT_DEFAULT_BRANCH = process.env.GIT_DEFAULT_BRANCH ?? 'main';

/** Git committer identity used when GIT_CONFIG_GLOBAL is suppressed. */
export const GIT_USER_NAME = process.env.GIT_USER_NAME ?? 'AgenticDevTeam';
export const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL ?? 'agenticdevteam@noreply.github.com';

/** Max PR review iterations before force-merging or escalating. */
export const MAX_REVIEW_ITERATIONS =
    parseInt(process.env.MAX_REVIEW_ITERATIONS ?? '5', 10);

/** Timeout (ms) for `npm install` inside a PR worktree (default 5 min). */
export const PR_TEST_INSTALL_TIMEOUT_MS =
    parseInt(process.env.PR_TEST_INSTALL_TIMEOUT_MS ?? '300000', 10);

/** Timeout (ms) for `npm test` inside a PR worktree (default 3 min). */
export const PR_TEST_TIMEOUT_MS =
    parseInt(process.env.PR_TEST_TIMEOUT_MS ?? '180000', 10);

/** Number of automated repair attempts when pre-PR tests fail (0 disables). */
export const PR_TEST_REPAIR_ATTEMPTS =
    parseInt(process.env.PR_TEST_REPAIR_ATTEMPTS ?? '1', 10);

// ─── GitHub Project (multi-repo targeting) ──────────────────────────────────

/** Separate PAT for project-specific repos (falls back to GITHUB_TOKEN). */
export const GITHUB_PROJECT_TOKEN = process.env.GITHUB_PROJECT_TOKEN ?? '';

/** Owner for project-specific repos (falls back to GITHUB_OWNER). */
export const GITHUB_PROJECT_OWNER = process.env.GITHUB_PROJECT_OWNER ?? '';

// ─── HITL / Checkpointing ───────────────────────────────────────────────────

/** Persist graph checkpoints to disk so a HITL or crashed run can survive a server restart. */
export const CHECKPOINT_PERSIST =
    (process.env.CHECKPOINT_PERSIST ?? 'false') === 'true';

// ─── Observability (Sub-Plan 12) ────────────────────────────────────────────

/** Events kept in the ring buffer (was 500 — both post-mortem runs saturated it). */
export const EVENT_BUFFER_SIZE =
    parseInt(process.env.EVENT_BUFFER_SIZE ?? '5000', 10);

/** High-severity events retained regardless of ring eviction. */
export const EVENT_PRIORITY_BUFFER_SIZE =
    parseInt(process.env.EVENT_PRIORITY_BUFFER_SIZE ?? '500', 10);

/** Write outputs/<run>/ledger.jsonl and run-report.md. */
export const RUN_LEDGER_ENABLED =
    (process.env.RUN_LEDGER_ENABLED ?? 'true') === 'true';

/** Dump every agent's full LangGraph result to outputs/<run>/full-responses/.
 *  This is the only record of what a model actually returned — without it an
 *  unexpected response shape shows up as silently empty phase output. */
export const FULL_RESPONSE_LOG_ENABLED =
    (process.env.FULL_RESPONSE_LOG_ENABLED ?? 'true') === 'true';

/** Directory name (under the run output dir) for full-response dumps. */
export const FULL_RESPONSE_LOG_DIR_NAME =
    process.env.FULL_RESPONSE_LOG_DIR_NAME ?? 'full-responses';

/** Max characters per full-response dump file (0 = unlimited). */
export const FULL_RESPONSE_LOG_MAX_CHARS =
    parseInt(process.env.FULL_RESPONSE_LOG_MAX_CHARS ?? '0', 10);

/** Run-invariant enforcement: 'off' | 'warn' | 'strict'. */
export const RUN_INVARIANTS_MODE =
    (process.env.RUN_INVARIANTS_MODE ?? 'warn') as 'off' | 'warn' | 'strict';

// ─── Requirements Traceability (Sub-Plan 10) ────────────────────────────────

/** Minimum verified AC coverage % for the AC_COVERAGE acceptance criterion.
 *  Was 0 (off) — now 70.  The metric is meaningful after Sub-Plan 10:
 *  only source:'executed' test reports count, claimed reports are excluded. */
export const MIN_AC_COVERAGE_PCT =
    parseInt(process.env.MIN_AC_COVERAGE_PCT ?? '70', 10);

/** Minimum implemented (merged code exists) AC % — a weaker but mandatory bar. 0 = off. */
export const MIN_AC_IMPLEMENTED_PCT =
    parseInt(process.env.MIN_AC_IMPLEMENTED_PCT ?? '90', 10);

/** Max bugs synthesised for uncovered criteria.
 *  Was 10 — raised to 25 so the bugfix loop gets enough specifics. */
export const MIN_AC_COVERAGE_MAX_BUGS =
    parseInt(process.env.MIN_AC_COVERAGE_MAX_BUGS ?? '25', 10);

/** Write outputs/<run>/traceability.json alongside the markdown. */
export const TRACEABILITY_JSON =
    (process.env.TRACEABILITY_JSON ?? 'true') === 'true';

// ─── LLM Cassettes ──────────────────────────────────────────────────────────

/** Cassette mode: 'off' (default), 'record', or 'replay'. */
export const LLM_CASSETTE_MODE =
    process.env.LLM_CASSETTE_MODE ?? 'off';

/** Name of the cassette file (without extension). Used in record and replay modes. */
export const CASSETTE_NAME =
    process.env.CASSETTE_NAME ?? '';

/** Behaviour on a replay miss: 'strict' (throws) or 'passthrough' (calls real LLM). */
export const LLM_CASSETTE_ON_MISS =
    process.env.LLM_CASSETTE_ON_MISS ?? 'strict';

/** Warn when a cassette file exceeds this size (MB). */
export const CASSETTE_MAX_MB =
    parseInt(process.env.CASSETTE_MAX_MB ?? '25', 10);

/** GitHub mode: 'live' (default) or 'local' (offline, bare-repo backed). */
export const GITHUB_MODE_CONFIG =
    process.env.GITHUB_MODE ?? 'live';

// ─── Dashboard ──────────────────────────────────────────────────────────────

/** Port for the Express + WebSocket server. */
export const DASHBOARD_PORT =
    parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);

// ─── Plan Coverage (Sub-Plan 04) ────────────────────────────────────────────

/** Plan coverage enforcement: 'off' | 'warn' | 'enforce'. */
export const PLAN_COVERAGE_MODE =
    (process.env.PLAN_COVERAGE_MODE ?? 'enforce') as 'off' | 'warn' | 'enforce';

/** Gap-repair attempts when the plan does not cover every story/task. */
export const PLAN_COVERAGE_REPAIR_ATTEMPTS =
    parseInt(process.env.PLAN_COVERAGE_REPAIR_ATTEMPTS ?? '2', 10);

/** Context char budget for the Team Leader (it now receives full acceptance criteria). */
export const TEAM_LEADER_CONTEXT_MAX_CHARS =
    parseInt(process.env.TEAM_LEADER_CONTEXT_MAX_CHARS ?? '48000', 10);

// ─── Architecture Contract (Sub-Plan 05) ────────────────────────────────────

/** Enforce the Architect's repo contract: 'off' | 'warn' | 'enforce'. */
export const REPO_CONTRACT_MODE =
    (process.env.REPO_CONTRACT_MODE ?? 'enforce') as 'off' | 'warn' | 'enforce';

/** Cap on declared modules (keeps the contract proportional). */
export const REPO_CONTRACT_MAX_MODULES =
    parseInt(process.env.REPO_CONTRACT_MAX_MODULES ?? '60', 10);

/** Create typed interface stubs for every declared module during scaffolding. */
export const CONTRACT_STUB_SCAFFOLD =
    (process.env.CONTRACT_STUB_SCAFFOLD ?? 'true') === 'true';

/** Char budget for the contract section injected into agent prompts. */
export const CONTRACT_PROMPT_MAX_CHARS =
    parseInt(process.env.CONTRACT_PROMPT_MAX_CHARS ?? '6000', 10);

// ─── PR Workflow / Work Preservation (Sub-Plan 06) ──────────────────────────

/** Max failed worktrees retained under .worktrees-failed/ for salvage. */
export const WORKTREE_SALVAGE_MAX =
    parseInt(process.env.WORKTREE_SALVAGE_MAX ?? '10', 10);

/** Export `git format-patch` bundles for every branch that fails to merge. */
export const PR_SALVAGE_PATCHES =
    (process.env.PR_SALVAGE_PATCHES ?? 'true') === 'true';

/** Dev-agent attempts at resolving a merge conflict before the branch is reported blocked. */
export const MERGE_CONFLICT_FIX_ATTEMPTS =
    parseInt(process.env.MERGE_CONFLICT_FIX_ATTEMPTS ?? '1', 10);

/** Max times a single assignment may be re-dispatched. */
export const ASSIGNMENT_MAX_ATTEMPTS =
    parseInt(process.env.ASSIGNMENT_MAX_ATTEMPTS ?? '3', 10);

/** Only the scaffold branch may modify shared root config files. */
export const CONFIG_OWNERSHIP_SCAFFOLD_ONLY =
    (process.env.CONFIG_OWNERSHIP_SCAFFOLD_ONLY ?? 'true') === 'true';

// ─── Review & Merge Policy (Sub-Plan 07) ────────────────────────────────────

/** Merge policy: 'strict' (evidence required) | 'permissive' | 'legacy' (pre-Plan-19). */
export const REVIEW_MERGE_POLICY =
    (process.env.REVIEW_MERGE_POLICY ?? 'strict') as 'strict' | 'permissive' | 'legacy';

/** Genuine approvals required to merge (abstentions do not count). */
export const REVIEW_QUORUM =
    parseInt(process.env.REVIEW_QUORUM ?? '1', 10);

/** Retries when every reviewer abstained (schema error / recursion limit / empty output). */
export const REVIEW_ABSTAIN_RETRIES =
    parseInt(process.env.REVIEW_ABSTAIN_RETRIES ?? '1', 10);

/** Extra tool calls granted to an escalated developer. */
export const ESCALATION_TOOL_CALL_BONUS =
    parseInt(process.env.ESCALATION_TOOL_CALL_BONUS ?? '10', 10);

/** Convert unresolved major review comments into Bugs for the bugfix loop. */
export const REVIEW_MAJORS_TO_BUGS =
    (process.env.REVIEW_MAJORS_TO_BUGS ?? 'true') === 'true';

// ─── Strong Model PR Fixer (Sub-Plan 20) ────────────────────────────────────

/** Model to use for the strong fixer agent (e.g. 'claude-opus-4.6', 'gpt-4o').
 *  Empty string (default) falls back to PRINCIPAL_DEV_MODEL. */
export const STRONG_FIXER_MODEL =
    process.env.STRONG_FIXER_MODEL ?? '';

/** Enable/disable the strong fixer (default: true). */
export const STRONG_FIXER_ENABLED =
    (process.env.STRONG_FIXER_ENABLED ?? 'true') === 'true';

/** Turn ceiling for the strong fixer agent (default: 40).
 *
 *  Plan 22 A2 changed the unit: this now bounds *model turns*, not individual
 *  tool calls. Read/write/shell pools come from the principal budgets plus
 *  headroom (see `buildStrongFixerAgent`). Under the old call-based ceiling a
 *  Claude fixer that batched 9 reads into one turn spent 40 units in 5 turns. */
export const STRONG_FIXER_MAX_TOOL_CALLS =
    parseInt(process.env.STRONG_FIXER_MAX_TOOL_CALLS ?? '40', 10);

/**
 * PR exhaustion strategy — controls what happens when max review iterations are reached:
 * - 'escalate-then-fix' (default): Run existing rank-based escalation first, then strong fixer if still unresolved.
 * - 'fix-only': Skip rank-based escalation entirely, go straight to strong fixer.
 * - 'escalate-only': Keep existing escalation behaviour only, no strong fixer (backward-compatible).
 */
export const PR_EXHAUSTION_STRATEGY =
    (process.env.PR_EXHAUSTION_STRATEGY ?? 'escalate-then-fix') as 'escalate-then-fix' | 'fix-only' | 'escalate-only';

// ─── Agent Budgets & Context (Sub-Plan 08) ──────────────────────────────────

/** Max files listed in the injected workspace snapshot. */
export const SNAPSHOT_MAX_FILES =
    parseInt(process.env.SNAPSHOT_MAX_FILES ?? '400', 10);

/**
 * Write agent mission reports and the architecture contract into the generated
 * project repo (Plan 22, G4).
 *
 * Default `false`: they go to `outputs/<run>/agents/` instead, and `docs/agents/`
 * + `.agent/` are gitignored in the product repo. Mission reports are pipeline
 * telemetry — committing them produced six `chore: pipeline artifacts` commits on
 * a single feature branch in the pacmanclaude run and put them in every PR diff.
 */
export const AGENT_ARTIFACTS_IN_REPO =
    (process.env.AGENT_ARTIFACTS_IN_REPO ?? 'false') === 'true';

/** Char budget for the injected workspace snapshot. */
export const SNAPSHOT_MAX_CHARS =
    parseInt(process.env.SNAPSHOT_MAX_CHARS ?? '8000', 10);

/** Extra read calls granted when an agent is making verified progress (writes). */
export const LOOP_GUARD_PROGRESS_BONUS =
    parseInt(process.env.LOOP_GUARD_PROGRESS_BONUS ?? '10', 10);

/** Absolute per-invocation tool-call ceiling.
 *  Was 80 — raised to 140 in Plan 22 because the per-category and per-turn
 *  ceilings are now the binding constraints and 80 calls is only ~8 turns for a
 *  model that batches 9–11 tool calls per turn. */
export const LOOP_GUARD_HARD_CEILING =
    parseInt(process.env.LOOP_GUARD_HARD_CEILING ?? '140', 10);

/**
 * Per-rank read/write/shell/turn budgets for developer agents, as a JSON object
 * keyed by rank. A partial entry is merged over the built-in defaults, so
 * `{"junior":{"turns":26}}` changes only the junior turn ceiling.
 *
 * Built-in defaults (see `tool-loop-guard.ts`):
 *   principal { reads: 60, writes: 30, shell: 14, turns: 28 }
 *   senior    { reads: 50, writes: 25, shell: 12, turns: 24 }
 *   junior    { reads: 40, writes: 20, shell: 12, turns: 20 }
 *
 * Until Plan 22 this variable — and the whole budget system it configures —
 * was dead: `buildAgent()` always passed a single flat call ceiling to
 * `withLoopGuard`, which selected the legacy code path.
 */
export const TOOL_BUDGETS_JSON =
    process.env.TOOL_BUDGETS_JSON ?? '';

/** Invocation-level retries for transient LLM/network failures. */
export const AGENT_INVOKE_RETRIES =
    parseInt(process.env.AGENT_INVOKE_RETRIES ?? '1', 10);

/** Reconcile agent-claimed fileChanges against the worktree and drop phantoms. */
export const RECONCILE_FILE_CHANGES =
    (process.env.RECONCILE_FILE_CHANGES ?? 'true') === 'true';

// ─── QA Real Execution (Sub-Plan 09) ────────────────────────────────────────

/** Enforce test-sufficiency rules (min counts, coverage floor, per-story coverage). */
export const QA_ENFORCE_SUFFICIENCY =
    (process.env.QA_ENFORCE_SUFFICIENCY ?? 'true') === 'true';

/** Minimum total non-trivial executed tests. 0 = derive as max(5, storyCount). */
export const QA_MIN_TOTAL_TESTS =
    parseInt(process.env.QA_MIN_TOTAL_TESTS ?? '0', 10);

/** Minimum tagged passing tests per user story. */
export const QA_MIN_TESTS_PER_STORY =
    parseInt(process.env.QA_MIN_TESTS_PER_STORY ?? '1', 10);

/** Minimum line-coverage percentage. 0 = off. */
export const QA_MIN_COVERAGE_PCT =
    parseInt(process.env.QA_MIN_COVERAGE_PCT ?? '40', 10);

/** Timeout (ms) for a single test-runner invocation. */
export const QA_TEST_TIMEOUT_MS =
    parseInt(process.env.QA_TEST_TIMEOUT_MS ?? '600000', 10);

/** Max qa-unit invocations per QA phase (one per story/module). */
export const QA_MAX_INVOCATIONS =
    parseInt(process.env.QA_MAX_INVOCATIONS ?? '12', 10);

/** Route QA-authored tests through the PR workflow on a dedicated test branch. */
export const QA_TESTS_VIA_PR =
    (process.env.QA_TESTS_VIA_PR ?? 'true') === 'true';

// ─── DevOps & E2E Hardening (Sub-Plan 11) ───────────────────────────────────

/** Serve the built product locally for E2E when no Docker services are available. */
export const E2E_ALLOW_LOCAL_SERVER =
    (process.env.E2E_ALLOW_LOCAL_SERVER ?? 'true') === 'true';

/** Make the E2E acceptance criterion required. */
export const ACCEPT_REQUIRE_E2E =
    (process.env.ACCEPT_REQUIRE_E2E ?? 'false') === 'true';

/** Playwright MCP startup budget (ms). */
export const PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS =
    parseInt(process.env.PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS ?? '60000', 10);

/** Connection retries for the Playwright MCP server. */
export const PLAYWRIGHT_MCP_CONNECT_RETRIES =
    parseInt(process.env.PLAYWRIGHT_MCP_CONNECT_RETRIES ?? '2', 10);

/** Run `npx playwright install chromium --with-deps` when browsers are missing. */
export const PLAYWRIGHT_AUTO_INSTALL =
    (process.env.PLAYWRIGHT_AUTO_INSTALL ?? 'true') === 'true';

/** Generate a deterministic Dockerfile/compose when the DevOps agent fails or produces none. */
export const DEVOPS_FALLBACK_ENABLED =
    (process.env.DEVOPS_FALLBACK_ENABLED ?? 'true') === 'true';
