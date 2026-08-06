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
    process.env.PRODUCT_MANAGER_MODEL ?? 'llama-3-3-70b-instruct';

/** DBA agent model. */
export const DBA_MODEL =
    process.env.DBA_MODEL ?? 'llama-3-3-70b-instruct';

/** Team Leader agent model. */
export const TEAM_LEADER_MODEL =
    process.env.TEAM_LEADER_MODEL ?? 'gemma-3-27b-it';

/** DevOps agent model. */
export const DEVOPS_MODEL =
    process.env.DEVOPS_MODEL ?? 'mistral-small-3-1-24b-instruct-2503';

/** Codebase Analyzer agent model. */
export const CODEBASE_ANALYZER_MODEL =
    process.env.CODEBASE_ANALYZER_MODEL ?? process.env.ARCHITECT_MODEL;

/** Principal Developer agent model (frontend & backend). */
export const PRINCIPAL_DEV_MODEL =
    process.env.PRINCIPAL_DEV_MODEL ?? 'llama-3-3-70b-instruct';

/** Senior Developer agent model (frontend & backend). */
export const SENIOR_DEV_MODEL =
    process.env.SENIOR_DEV_MODEL ?? 'mistral-small-3-1-24b-instruct-2503';

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
    // Merge env-based overrides if provided
    ...(process.env.MODEL_PRICING_OVERRIDES
        ? JSON.parse(process.env.MODEL_PRICING_OVERRIDES) as Record<string, { inputPer1k: number; outputPer1k: number }>
        : {}),
};

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

/**
 * LangGraph recursion limits per agent type.
 *
 * Pipeline agents (architect, PM, DBA, TL, QA) need very few tool calls (1-5).
 * Developer agents may need 15-25 tool calls (read, edit, git add, commit,
 * push — per file), so their limit must accommodate multi-file changes.
 * LangGraph counts 2 steps per tool call (LLM + tool), so limit ÷ 2 ≈ max calls.
 * Reviewer agents need 2-5 (diff, log, produce JSON).
 *
 * Lower limits prevent poisoned/looping agents from burning tokens until
 * the global ceiling (150). Per-type env vars override the global fallback.
 */
export const PIPELINE_RECURSION_LIMIT =
    parseInt(process.env.PIPELINE_RECURSION_LIMIT ?? process.env.AGENT_RECURSION_LIMIT ?? '15', 10);

export const DEV_RECURSION_LIMIT =
    parseInt(process.env.DEV_RECURSION_LIMIT ?? process.env.AGENT_RECURSION_LIMIT ?? '50', 10);

export const REVIEWER_RECURSION_LIMIT =
    parseInt(process.env.REVIEWER_RECURSION_LIMIT ?? process.env.AGENT_RECURSION_LIMIT ?? '26', 10);

/**
 * Recursion limit for pipeline agents that USE TOOLS (codebase-analyzer,
 * qa-unit, qa-e2e, devops). These agents explore the workspace, write files
 * and run commands, so 15 (PIPELINE_RECURSION_LIMIT) is far too low — it
 * killed the whole run at the QA phase in runs 5 and 6.
 */
export const TOOL_PIPELINE_RECURSION_LIMIT =
    parseInt(process.env.TOOL_PIPELINE_RECURSION_LIMIT ?? '60', 10);

/** Loop-guard ceiling (total tool calls) for tool-using pipeline agents. */
export const TOOL_PIPELINE_MAX_TOOL_CALLS =
    parseInt(process.env.TOOL_PIPELINE_MAX_TOOL_CALLS ?? '25', 10);

/** Loop-guard ceiling for reviewer agents (must be < REVIEWER_RECURSION_LIMIT / 2). */
export const REVIEWER_MAX_TOOL_CALLS =
    parseInt(process.env.REVIEWER_MAX_TOOL_CALLS ?? '8', 10);

/** @deprecated Use per-type limits (PIPELINE_RECURSION_LIMIT, DEV_RECURSION_LIMIT, REVIEWER_RECURSION_LIMIT). */
export const AGENT_RECURSION_LIMIT =
    parseInt(process.env.AGENT_RECURSION_LIMIT ?? '30', 10);

/** Max file-change entries injected into the dev context prompt. */
export const DEV_CONTEXT_FILE_CHANGES_LIMIT =
    parseInt(process.env.DEV_CONTEXT_FILE_CHANGES_LIMIT ?? '60', 10);

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

/** Allow E2E test failures to trigger a bugfix loop (default: false to preserve cost profile). */
export const E2E_BUGFIX_ENABLED =
    (process.env.E2E_BUGFIX_ENABLED ?? 'false') === 'true';

// ─── Run Budget ─────────────────────────────────────────────────────────────

/** Max total tokens for a run. 0 = unlimited (default). All three limits are checked; the closest one binds. */
export const MAX_RUN_TOKENS =
    parseInt(process.env.MAX_RUN_TOKENS ?? '0', 10);

/** Max estimated USD cost for a run. 0 = unlimited (default). */
export const MAX_RUN_COST_USD =
    parseFloat(process.env.MAX_RUN_COST_USD ?? '0');

/** Max wall-clock time (ms) for a run. 0 = unlimited (default). */
export const MAX_RUN_WALL_MS =
    parseInt(process.env.MAX_RUN_WALL_MS ?? '0', 10);

/** Utilisation threshold for budget warning level (default: 0.70). */
export const BUDGET_WARN_AT =
    parseFloat(process.env.BUDGET_WARN_AT ?? '0.70');

/** Utilisation threshold for budget degrade level (default: 0.90). */
export const BUDGET_DEGRADE_AT =
    parseFloat(process.env.BUDGET_DEGRADE_AT ?? '0.90');

// ─── Agent Output Validation ────────────────────────────────────────────────

/** Number of repair attempts when agent output fails schema validation (0 disables). */
export const AGENT_OUTPUT_REPAIR_ATTEMPTS =
    parseInt(process.env.AGENT_OUTPUT_REPAIR_ATTEMPTS ?? '1', 10);

// ─── Context Budget ─────────────────────────────────────────────────────────

/** Use compact summarisers instead of raw JSON.stringify dumps (default: true).
 *  Set to false to restore the old verbatim behaviour for A/B testing. */
export const CONTEXT_COMPACT =
    (process.env.CONTEXT_COMPACT ?? 'true') === 'true';

/** Hard character budget for assembled context per agent prompt. */
export const CONTEXT_MAX_CHARS =
    parseInt(process.env.CONTEXT_MAX_CHARS ?? '24000', 10);

/** Max characters for clipped descriptions in architecture summaries. */
export const CONTEXT_MAX_DESC_CHARS =
    parseInt(process.env.CONTEXT_MAX_DESC_CHARS ?? '200', 10);

/** Strip deep description fields from injected JSON Schema to save tokens (default: true). */
export const RESPONSE_SCHEMA_COMPACT =
    (process.env.RESPONSE_SCHEMA_COMPACT ?? 'true') === 'true';

// ─── Quality Gates ──────────────────────────────────────────────────────────

/** Enable multi-language quality gates (install/build/lint/test) in PR workflow and QA. */
export const QUALITY_GATES_ENABLED =
    (process.env.QUALITY_GATES_ENABLED ?? 'true') === 'true';

/** Which gate steps to run (comma-separated). */
export const QUALITY_GATE_STEPS =
    (process.env.QUALITY_GATE_STEPS ?? 'install,build,lint,test').split(',') as ('install' | 'build' | 'lint' | 'test')[];

/** Timeout (ms) for each quality gate step (default 5 min). */
export const QUALITY_GATE_TIMEOUT_MS =
    parseInt(process.env.QUALITY_GATE_TIMEOUT_MS ?? '300000', 10);

/** Fail the gate when a stack's toolchain is missing (default: false — missing tools produce 'skipped'). */
export const QUALITY_GATE_STRICT_TOOLCHAIN =
    (process.env.QUALITY_GATE_STRICT_TOOLCHAIN ?? 'false') === 'true';

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

// ─── Observability ──────────────────────────────────────────────────────────

/** Max events kept in the ring buffer for backfilling reconnecting dashboards. */
export const EVENT_BUFFER_SIZE =
    parseInt(process.env.EVENT_BUFFER_SIZE ?? '500', 10);

// ─── Requirements Traceability ──────────────────────────────────────────────

/** Minimum AC coverage percentage to pass the QA gate (0 = off). */
export const MIN_AC_COVERAGE_PCT =
    parseInt(process.env.MIN_AC_COVERAGE_PCT ?? '0', 10);

/** Max bugs synthesised when AC coverage is below the gate threshold. */
export const MIN_AC_COVERAGE_MAX_BUGS =
    parseInt(process.env.MIN_AC_COVERAGE_MAX_BUGS ?? '10', 10);

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
