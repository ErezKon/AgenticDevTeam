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

/** Default chat model name. */
export const LLM_MODEL =
    process.env.LLM_MODEL ?? 'gpt-oss-120b';

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

/** LangGraph recursion limit per agent invocation. */
export const AGENT_RECURSION_LIMIT =
    parseInt(process.env.AGENT_RECURSION_LIMIT ?? '150', 10);

/** Max parallel developer agents during fan-out. */
export const MAX_CONCURRENT_DEVS =
    parseInt(process.env.MAX_CONCURRENT_DEVS ?? '2', 10);

/** Delay (ms) between dispatching batches of branches to avoid rate limits. */
export const INTER_BATCH_DELAY_MS =
    parseInt(process.env.INTER_BATCH_DELAY_MS ?? '2000', 10);

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

// ─── Dashboard ──────────────────────────────────────────────────────────────

/** Port for the Express + WebSocket server. */
export const DASHBOARD_PORT =
    parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);
