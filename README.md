# AgenticDevTeam — Multi-Agent Software Delivery System

A LangGraph-orchestrated team of specialized AI agents that ingests a requirements document and autonomously (or with human-in-the-loop) designs, builds, tests, and containerizes a complete software product.

## Architecture

The system is composed of **19 specialized agents** organized in a pipeline:

| Phase | Agent(s) | Responsibility |
|-------|----------|----------------|
| Design | Architect | System design, tech selection |
| Planning | Product Manager | Epics → user stories & tasks |
| Data | DBA | Database design, schema, indexing |
| Assignment | Team Leader | Estimation, story assignment, bugs |
| Implementation | Developer Pool (11 agents) | Write code by rank & specialty |
| Quality | QA Lead + Unit + E2E (Playwright) | Test suites, bug reporting |
| Delivery | DevOps | Docker/K8s, build, run, health-check |

## Run Modes

- **Autonomous**: the full pipeline runs start-to-finish without stopping.
- **Human-in-the-loop**: pauses after each phase for approve / deny / enhance.

## Prerequisites

- **Node.js** 20+
- **npm**
- **Docker** & **Docker Compose**
- **OAuth2 credentials** in `.env` (see `.env.example`)

## Quick Start

```bash
# 1. Clone & install
git clone <repository-url>
cd AgenticDevTeam
cp .env.example .env
# Edit .env with your credentials
npm install

# 2a. Interactive CLI
npm run cli

# 2b. REST + Dashboard server
npm start
# Dashboard at http://localhost:3000

# 3. Docker
docker compose up --build
```

## Project Structure

```
src/
├── cli.ts              # Interactive CLI entry point
├── index.ts            # REST + WebSocket server (dashboard backend)
├── config.ts           # Env-driven configuration
├── conductor/          # LangGraph orchestration engine
├── agents/             # All 19 agent modules
├── tools/              # Shared tools (fs, shell, docker, mcp, etc.)
├── executor/           # Docker build/run/test subsystem
└── utils/              # Logging, auth, workspace helpers
```

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Purpose |
|----------|---------|
| `LLM_BASE_URL` | OpenAI-compatible LLM endpoint |
| `OAUTH_TOKEN_URL` | OAuth2 token endpoint |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Client credentials |
| `RUN_MODE` | `autonomous` or `human` (default) |
| `MAX_BUGFIX_ITERATIONS` | Bug-loop bound (default 3) |

## Output

Each run produces:
- **Generated project** in `generated-projects/<system-name>/` — a self-contained, Dockerized product with code, tests, K8s manifests, and agent design docs.
- **Run logs** in `outputs/<system-name>-<timestamp>/` — `run.log`, state snapshots, test reports.
