# AgenticDevTeam

> A LangGraph-orchestrated multi-agent system that ingests a requirements document and autonomously designs, builds, tests, and containerizes a complete software product — or maintains, extends, and fixes an existing one.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Pipeline Flow](#pipeline-flow)
- [Maintaining Existing Projects](#maintaining-existing-projects)
- [Agent Roster](#agent-roster)
- [Run Modes](#run-modes)
- [Bug-Fix Loop](#bug-fix-loop)
- [Git Branching & PR Workflow](#git-branching--pr-workflow)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Usage](#usage)
- [REST API](#rest-api)
- [Angular Dashboard](#angular-dashboard)
- [Environment Variables](#environment-variables)
- [Output & Artifacts](#output--artifacts)
- [Technology Stack](#technology-stack)
- [License](#license)

---

## Overview

AgenticDevTeam is a **fully autonomous software delivery pipeline** powered by 20 specialized AI agents. It supports two run types:

- **Greenfield** — build a new project from scratch given a requirements document
- **Maintain** — analyze an existing codebase and apply changes, fixes, or new features

Given a requirements document (Markdown, TXT, PDF, or DOCX), the system will:

1. **Design** the architecture, select the tech stack, and produce component diagrams
2. **Plan** epics, user stories, acceptance criteria, and granular tasks
3. **Model** the database — entities, relationships, indexes, migrations, and ERD
4. **Assign** tasks to the right developers based on rank, specialty, and dependency order
5. **Implement** the full codebase with concurrent developer agents writing real files
6. **Test** with unit/integration suites and Playwright MCP-driven end-to-end browser tests
7. **Deploy** via auto-generated Dockerfiles, docker-compose, and Kubernetes manifests
8. **Iterate** through a bug-fix loop until quality gates pass or the iteration limit is reached

All orchestration runs on a **LangGraph state machine** with typed state, reducers, and conditional edges — supporting both fully autonomous execution and human-in-the-loop stepwise approvals.

---

## Architecture

```mermaid
graph TB
    subgraph Interfaces
        CLI[Interactive CLI]
        API[REST + WebSocket Server]
        DASH[Angular Dashboard]
    end

    subgraph Orchestration
        COND[Conductor Graph<br/>LangGraph StateGraph]
        STATE[(ProjectState<br/>Typed + Reducers)]
    end

    subgraph Design Phase
        ARCH[Architect Agent]
        PM[Product Manager Agent]
        DBA[DBA Agent]
        TL[Team Leader Agent]
    end

    subgraph Development Phase
        DISP[Dispatcher<br/>Topo-sort + Concurrency]
        PFE[Principal FE]
        PBE[Principal BE]
        SFE[Senior FE]
        SBE[Senior BE]
        JA[Junior Angular]
        JR[Junior React]
        JV[Junior Vue]
        JCS[Junior C#]
        JJ[Junior Java]
        JG[Junior Go]
        JP[Junior Python]
    end

    subgraph QA Phase
        QAL[QA Lead]
        QAU[QA Unit/Integration]
        QAE[QA E2E<br/>Playwright MCP]
    end

    subgraph Delivery Phase
        DEVOPS[DevOps Agent]
        DOCKER[Docker Runner<br/>Dockerode]
    end

    CLI --> COND
    API --> COND
    DASH --> API

    COND --> STATE
    COND --> ARCH --> PM --> DBA --> TL
    TL --> DISP
    DISP --> PFE & PBE & SFE & SBE & JA & JR & JV & JCS & JJ & JG & JP
    DISP --> QAL --> QAU --> QAE
    QAE --> DEVOPS --> DOCKER
```

### Core Components

| Component | Path | Purpose |
|-----------|------|---------|
| **Conductor** | `src/conductor/` | LangGraph state machine — nodes, graph, run modes |
| **ProjectState** | `src/conductor/state.ts` | Single source of truth with typed annotations and merge reducers |
| **Agent Factory** | `src/agents/_shared/agent-factory.ts` | Builds LangGraph `createReactAgent` instances with OAuth, tools, and checkpointers |
| **Agent Registry** | `src/agents/registry.ts` | 20-agent lookup table with IDs, display tags, and color codes |
| **Tools** | `src/tools/` | Workspace filesystem, sandboxed shell, Mermaid diagrams, requirements parser, Playwright MCP |
| **Docker Runner** | `src/executor/docker-runner.ts` | Dockerode-based image build, container run, and health checks |
| **CLI** | `src/cli.ts` | Interactive terminal interface |
| **Server** | `src/index.ts` | Express REST API + WebSocket for real-time updates |
| **Dashboard** | `dashboard/` | Angular 19 standalone web UI |

---

## Pipeline Flow

```mermaid
flowchart LR
    START([Requirements<br/>Document]) --> INTAKE[Intake]
    INTAKE --> ARCH[Architect]
    ARCH --> PM[Product<br/>Manager]
    PM --> DBA[DBA]
    DBA --> TL[Team<br/>Leader]
    TL --> DEV[Development<br/>Fan-out]
    DEV --> QA[QA<br/>Lead + Unit + E2E]
    QA -->|All tests pass| DEVOPS[DevOps]
    QA -->|Failures & iterations left| BUG[Bug-fix<br/>Triage]
    BUG --> DEV
    DEVOPS --> FIN([Finalize<br/>Reports & Artifacts])

    style START fill:#22c55e,color:#fff
    style FIN fill:#3b82f6,color:#fff
    style BUG fill:#ef4444,color:#fff
```

### Phase Details

| # | Phase | Node | What Happens |
|---|-------|------|-------------|
| 1 | **Intake** | `intakeNode` | Parse requirements document, create workspace and output directories, set run log path |
| 2 | **Architect** | `architectNode` | Analyze requirements → produce architecture doc, component list, tech stack, and architecture diagram |
| 3 | **Product Manager** | `productManagerNode` | Convert architecture + epics into user stories with acceptance criteria and granular tasks |
| 4 | **DBA** | `dbaNode` | Design database — entities, relationships, indexes, migration scripts, and ERD diagram |
| 5 | **Team Leader** | `teamLeaderNode` | Assign tasks to developers based on rank, specialty, dependencies, and complexity |
| 6 | **Development** | `developmentNode` | Fan-out assignments to developer agents with topological sorting and concurrency control |
| 7 | **QA** | `qaNode` | QA Lead creates test plan → QA Unit writes & runs tests → QA E2E drives Playwright browser tests |
| 8 | **Bug-fix Triage** | `bugfixTriageNode` | Team Leader re-assigns critical/major bugs to developers (loops back to Development) |
| 9 | **DevOps** | `devopsNode` | Generate Dockerfiles, docker-compose, K8s manifests; build images; run containers; health-check |
| 10 | **Finalize** | `finalizeNode` | Write final mission report with summary, stats, and Mermaid diagrams; close run |

### Maintain-Mode Pipeline

When targeting an existing codebase, a **Codebase Analyzer** step is inserted before the Architect:

```mermaid
flowchart LR
    START([Specs / Demands<br/>Document]) --> INTAKE[Intake<br/>set workspace to<br/>existing project]
    INTAKE --> ANALYZER[Codebase<br/>Analyzer]
    ANALYZER --> ARCH[Architect<br/>plan changes]
    ARCH --> PM[Product<br/>Manager]
    PM --> DBA[DBA<br/>migration changes]
    DBA --> TL[Team<br/>Leader]
    TL --> DEV[Development<br/>modify existing code]
    DEV --> QA[QA<br/>extend tests]
    QA -->|All pass| DEVOPS[DevOps<br/>update configs]
    QA -->|Failures| BUG[Bug-fix<br/>Triage]
    BUG --> DEV
    DEVOPS --> FIN([Finalize])

    style START fill:#f59e0b,color:#fff
    style ANALYZER fill:#8b5cf6,color:#fff
    style FIN fill:#3b82f6,color:#fff
    style BUG fill:#ef4444,color:#fff
```

---

## Maintaining Existing Projects

In **maintain mode**, agents operate on an existing codebase rather than generating a new one:

1. **Intake** validates the existing project path and uses it as the workspace (no new directory created)
2. **Codebase Analyzer** scans the project — file tree, architecture, modules, DB, tests, build tooling — producing a structured `CodebaseAnalysis` and a persistent `docs/codebase-analysis.md`
3. **Architect** receives the analysis + your specs and designs **incremental changes** (not a full redesign)
4. **Product Manager** creates stories/tasks focused on the **delta** — what to add, modify, or fix
5. **DBA** produces only the schema **migrations** needed, not a full schema from scratch
6. **Team Leader** assigns work, noting which existing files to modify
7. **Developers** use `edit_file` for surgical changes, preserving existing code style and conventions
8. **QA** extends existing test suites and adds regression tests
9. **DevOps** updates existing Docker/K8s configs rather than recreating them

### Codebase Analysis File

The analyzer writes `docs/codebase-analysis.md` **inside the target project** (persistent across runs) and a snapshot in the run's `outputs/` directory. On subsequent runs, the analyzer reads the existing file as a baseline and only updates changed sections — making re-analysis faster.

---

## Agent Roster

### Analysis Agents

| Agent | ID | Specialty |
|-------|----|----------|
| Codebase Analyzer | `codebase-analyzer` | Scans and documents existing codebases for the maintenance pipeline |

### Management Agents

| Agent | ID | Specialty |
|-------|----|-----------|
| Architect | `architect` | System design, component architecture, tech stack selection |
| Product Manager | `product-manager` | Epics → user stories → tasks with acceptance criteria |
| DBA | `dba` | Database design, ERD, migrations, indexing strategy |
| Team Leader | `team-leader` | Task estimation, developer assignment, bug triage |

### Developer Agents (11)

| Agent | ID | Rank | Domain | Languages |
|-------|----|------|--------|-----------|
| Principal Frontend | `principal-frontend` | Principal | Frontend | Angular, React, Vue, Svelte, TypeScript, HTML/CSS, Tailwind |
| Principal Backend | `principal-backend` | Principal | Backend | C#/.NET, Java/Spring, Go, Python/FastAPI, Node.js/Express |
| Senior Frontend | `senior-frontend` | Senior | Frontend | Angular, React, Vue |
| Senior Backend | `senior-backend` | Senior | Backend | C#/.NET, Java/Spring, Python, Go |
| Junior Angular | `junior-angular` | Junior | Frontend | Angular |
| Junior React | `junior-react` | Junior | Frontend | React |
| Junior Vue | `junior-vue` | Junior | Frontend | Vue.js |
| Junior C# | `junior-csharp` | Junior | Backend | C#/.NET |
| Junior Java | `junior-java` | Junior | Backend | Java/Spring |
| Junior Go | `junior-go` | Junior | Backend | Go |
| Junior Python | `junior-python` | Junior | Backend | Python |

### QA Agents

| Agent | ID | Specialty |
|-------|----|-----------|
| QA Lead | `qa-lead` | Test strategy, test plan creation |
| QA Unit | `qa-unit` | Write & run unit/integration test suites |
| QA E2E | `qa-e2e` | Playwright MCP browser-driven end-to-end testing |

### Operations Agents

| Agent | ID | Specialty |
|-------|----|-----------|
| DevOps | `devops` | Dockerfiles, docker-compose, K8s manifests, build, deploy, health-check |

---

## Run Modes

### Autonomous Mode

The full pipeline executes start-to-finish without human intervention. Set `RUN_MODE=autonomous` in `.env` or select it in the CLI/dashboard.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Conductor
    participant A as Agents

    U->>C: Start run (requirements)
    loop Each phase
        C->>A: Invoke agent(s)
        A-->>C: Return structured output
        C->>C: Merge into ProjectState
    end
    C-->>U: Final report + generated project
```

### Human-in-the-Loop Mode

The pipeline pauses before each major phase. The user can **approve**, **deny**, or **enhance** (provide feedback) before continuing.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Conductor
    participant A as Agents

    U->>C: Start HITL run
    loop Each phase
        C->>A: Invoke agent(s)
        A-->>C: Return structured output
        C-->>U: Show results, request approval
        U->>C: Approve / Deny / Enhance
        alt Approved
            C->>C: Advance to next phase
        else Denied
            C-->>U: Run stopped
        end
    end
    C-->>U: Final report
```

**HITL interrupt points:** Codebase Analyzer (maintain mode), Architect, Product Manager, DBA, Team Leader, Development, QA, DevOps

---

## Bug-Fix Loop

After QA completes, if there are test failures:

```mermaid
flowchart TD
    QA{QA Results} -->|All pass| DEVOPS[DevOps]
    QA -->|Failures found| CHECK{Iteration < MAX?}
    CHECK -->|Yes| TRIAGE[Bug-fix Triage<br/>TL reassigns bugs]
    CHECK -->|No| DEVOPS
    TRIAGE --> DEV[Development<br/>Fix bugs]
    DEV --> QA
```

- The Team Leader creates new assignments targeting the specific bugs
- Only critical and major severity bugs trigger the loop
- Bounded by `MAX_BUGFIX_ITERATIONS` (default: 3) to prevent infinite loops

---

## Git Branching & PR Workflow

All developer code changes go through a structured **Git branching + GitHub PR + code review** workflow:

```mermaid
flowchart LR
    TL[Team Leader<br/>assigns branch + reviewers] --> BRANCH[Create Feature<br/>Branch]
    BRANCH --> DEV[Developer Agent<br/>TDD: tests first]
    DEV --> COMMIT[Commit & Push<br/>conventional commits]
    COMMIT --> PR[Create GitHub PR<br/>title + description]
    PR --> REVIEW[Reviewer Agents<br/>code review]
    REVIEW -->|Approved| MERGE[Squash Merge<br/>to main]
    REVIEW -->|Changes Requested| FIX[Fix & Push]
    FIX --> REVIEW

    style BRANCH fill:#22c55e,color:#fff
    style MERGE fill:#3b82f6,color:#fff
    style FIX fill:#ef4444,color:#fff
```

### Key Features

- **No direct commits to main/master** — all changes go through feature branches
- **Meaningful commits** — conventional commit format (`feat:`, `fix:`, `test:`, `refactor:`)
- **PR descriptions** — auto-generated with task summary, changes made, and current state (for bugs/fixes)
- **Rank-based reviewers** — Junior → 2 Seniors review; Senior → 2 Principals; Principal → 2 other Principals
- **Iterative review** — reviewers can request changes, developers fix, re-review up to `MAX_REVIEW_ITERATIONS`
- **Shared branches** — multiple agents on the same feature share one branch
- **TDD enforcement** — developers write tests first (red), implement (green), then refactor

### Review Rules

| Developer Rank | Reviewed By |
|---------------|-------------|
| Junior | 2 Senior developers |
| Senior | 2 Principal developers |
| Principal | 2 other Principal developers |

### Required Configuration

Set these environment variables in `.env` to enable the PR workflow:

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope |
| `GITHUB_OWNER` | Yes | Repository owner (org or user) |
| `GITHUB_REPO` | Yes | Repository name |
| `GIT_DEFAULT_BRANCH` | No | Default branch (default: `main`) |
| `MAX_REVIEW_ITERATIONS` | No | Max review rounds (default: `5`) |

> **Note:** The workspace must be an initialized Git repository with a GitHub remote.

---

## Project Structure

```
AgenticDevTeam/
├── src/
│   ├── cli.ts                              # Interactive CLI entry point
│   ├── index.ts                            # Express REST + WebSocket server
│   ├── config.ts                           # Environment-driven configuration
│   │
│   ├── conductor/                          # LangGraph orchestration
│   │   ├── state.ts                        # ProjectState (Annotation + reducers)
│   │   ├── nodes.ts                        # 10 phase node functions
│   │   ├── graph.ts                        # StateGraph wiring + HITL interrupts
│   │   ├── pr-workflow.ts                  # PR lifecycle orchestrator (branch → review → merge)
│   │   └── run.ts                          # Autonomous & HITL run helpers
│   │
│   ├── agents/
│   │   ├── _shared/
│   │   │   ├── agent-factory.ts            # createReactAgent wrapper
│   │   │   ├── base-schemas.ts             # 20+ Zod schemas for all domain entities
│   │   │   ├── persona.ts                  # Developer persona prompt builder
│   │   │   └── artifact.ts                 # Mission report writer
│   │   ├── registry.ts                     # Master 20-agent registry
│   │   ├── codebase-analyzer/              # Codebase Analyzer agent (maintain mode)
│   │   ├── architect/                      # Architect agent (prompt, schema, agent)
│   │   ├── product-manager/                # PM agent
│   │   ├── dba/                            # DBA agent
│   │   ├── team-leader/                    # TL agent
│   │   ├── developers/
│   │   │   ├── registry.ts                 # 11 developer agent definitions
│   │   │   ├── dev-agent.builder.ts        # Dev agent constructor (+ git tools)
│   │   │   ├── reviewer-agent.builder.ts   # Code reviewer agent constructor
│   │   │   ├── dispatcher.ts               # Branch-grouped fan-out with PR workflow
│   │   │   └── schemas/
│   │   │       ├── dev-output.schema.ts    # Developer agent output schema
│   │   │       └── review-output.schema.ts # Reviewer agent output schema
│   │   ├── qa/                             # QA Lead, Unit, E2E agents
│   │   └── devops/                         # DevOps agent
│   │
│   ├── tools/
│   │   ├── fs/workspace-tools.ts           # Sandboxed read/write/edit/list/search
│   │   ├── git/git-tools.ts               # Git CLI tools (branch, commit, push, diff)
│   │   ├── git/github-tools.ts            # GitHub API tools (PR, review, merge)
│   │   ├── shell/shell-tools.ts            # Command execution in workspace
│   │   ├── diagram/diagram-tools.ts        # Mermaid diagram emission
│   │   ├── requirements/parse-requirements.ts  # .md/.txt/.pdf/.docx parser
│   │   └── mcp/playwright-mcp.ts           # Playwright MCP client
│   │
│   ├── executor/
│   │   └── docker-runner.ts                # Dockerode build/run/healthcheck
│   │
│   ├── utils/
│   │   ├── logger.ts                       # Per-agent colored console + file logger
│   │   ├── log-colors.util.ts              # ANSI 256-color codes
│   │   ├── log-capture.util.ts             # Stdout/stderr capture for log files
│   │   ├── oauth-auth.util.ts              # OAuth2 client-credentials token cache
│   │   ├── workspace.ts                    # Project workspace + output dir creation
│   │   └── codebase-analysis-writer.ts     # Write analysis markdown to project + outputs
│   │
│   ├── templates/
│   │   └── codebase-analysis.template.ts   # Markdown renderer for CodebaseAnalysis
│   │
│   └── types/
│       └── shims.d.ts                      # Module declarations (pdf-parse, mammoth)
│
├── dashboard/                              # Angular 19 standalone web UI
│   ├── src/
│   │   ├── app/
│   │   │   ├── app.component.ts            # Root component + nav
│   │   │   ├── app.routes.ts               # Dashboard + New Run routes
│   │   │   ├── pages/
│   │   │   │   ├── dashboard/              # Agent roster + live event feed
│   │   │   │   └── new-run/                # Start run form
│   │   │   └── services/
│   │   │       └── api.service.ts          # HTTP + WebSocket client
│   │   ├── styles.css                      # Dark theme global styles
│   │   ├── index.html                      # Shell HTML
│   │   └── main.ts                         # Bootstrap
│   ├── angular.json
│   ├── tsconfig.json / tsconfig.app.json
│   ├── proxy.conf.json                     # Dev proxy → backend :3000
│   └── package.json
│
├── package.json                            # Backend dependencies & scripts
├── tsconfig.json                           # TypeScript config
├── Dockerfile                              # Orchestrator container
├── docker-compose.yml                      # Orchestrator + Playwright MCP
├── .env.example                            # Environment variable template
├── .gitignore
├── .dockerignore
└── README.md
```

---

## Prerequisites

- **Node.js** 20+
- **npm** 9+
- **Docker** & **Docker Compose** (for DevOps agent and containerized builds)
- **An OpenAI-compatible LLM endpoint** (set via `LLM_BASE_URL`)
- **OAuth2 client credentials** (if your LLM endpoint requires authentication)

---

## Installation & Setup

```bash
# 1. Clone the repository
git clone https://github.com/ErezKon/AgenticDevTeam.git
cd AgenticDevTeam

# 2. Install backend dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — set LLM_BASE_URL, OAuth credentials, and other settings

# 4. (Optional) Install Angular dashboard
cd dashboard
npm install
npm run build
cd ..
```

---

## Usage

### Interactive CLI

```bash
npm run cli
```

The CLI presents a menu:

```
╔══════════════════════════════════════════════════════════════╗
║              AgenticDevTeam — Multi-Agent System             ║
║          Autonomous Software Delivery Pipeline               ║
╚══════════════════════════════════════════════════════════════╝

Commands:
  1) Start new run (autonomous)
  2) Start new run (human-in-the-loop)
  3) Maintain existing project
  4) Show agent roster
  5) Exit
```

- **Options 1-2:** Greenfield — provide a **system name** and **requirements** (file path or inline text)
- **Option 3:** Maintain — provide the **existing project path**, a name, specs/demands, and run mode
- In HITL mode, you'll approve/deny/enhance each phase interactively (including Codebase Analyzer)

### REST + Dashboard Server

```bash
npm start
# Server at http://localhost:3000
# WebSocket at ws://localhost:3000/ws
```

### Docker Compose

```bash
docker compose up --build
```

Starts the orchestrator and Playwright MCP server in containers.

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all 20 agents with metadata |
| `POST` | `/api/run` | Start a new run (body: see below) |
| `GET` | `/api/run/:id` | Get current state of a run |
| `GET` | `/api/run/:id/prs` | List all pull requests for a run |
| `POST` | `/api/run/:id/approve` | Approve/deny a HITL phase (body: `{ approved, feedback? }`) |

#### `POST /api/run` Body

```json
{
  "systemName": "My App",
  "requirementsText": "...",
  "mode": "human",
  "runType": "greenfield",
  "existingProjectPath": null
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `systemName` | Yes | Name of the system |
| `requirementsText` | Yes* | Full requirements text (*or provide `requirementsDocPath`) |
| `requirementsDocPath` | No | Path to a .md/.txt/.pdf/.docx file |
| `mode` | No | `"autonomous"` or `"human"` (default: `"human"`) |
| `runType` | No | `"greenfield"` (default) or `"maintain"` |
| `existingProjectPath` | Maintain only | Absolute path to the existing project directory |

### WebSocket Events

Connect to `ws://localhost:3000/ws` for real-time updates:

| Event | Payload | When |
|-------|---------|------|
| `run:started` | `{ systemName, mode, threadId? }` | Run begins |
| `run:phase-complete` | `{ threadId, phase }` | A phase finishes |
| `run:complete` | `{ systemName, state }` | Run finishes successfully |
| `run:error` | `{ systemName, error }` | Run fails |

---

## Angular Dashboard

A modern dark-themed Angular 19 standalone app with:

- **Dashboard page** — agent roster grid with color-coded tags + live WebSocket event feed
- **New Run page** — form to start autonomous or HITL runs
- **Real-time updates** — WebSocket connection auto-reconnects

### Development

```bash
cd dashboard
npm start
# Proxied to backend at localhost:3000
```

### Production

```bash
cd dashboard
npm run build
# Static build output: dashboard/dist/dashboard/browser/
# Automatically served by the Express server
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | — | OpenAI-compatible API base URL |
| `LLM_MODEL` | `gpt-oss-120b` | Model identifier |
| `OAUTH_TOKEN_URL` | — | OAuth2 token endpoint URL |
| `OAUTH_CLIENT_ID` | — | OAuth2 client ID |
| `OAUTH_CLIENT_SECRET` | — | OAuth2 client secret |
| `RUN_MODE` | `human` | Default run mode: `autonomous` or `human` |
| `MAX_BUGFIX_ITERATIONS` | `3` | Max QA → bugfix → dev cycles |
| `MAX_CONCURRENT_DEVS` | `3` | Max parallel developer agents |
| `GENERATED_PROJECTS_DIR` | `./generated-projects` | Where generated codebases are written |
| `OUTPUTS_DIR` | `./outputs` | Where run logs and artifacts are saved |
| `DOCKER_HOST` | — | Docker daemon URL (default: local socket) |
| `PLAYWRIGHT_MCP_CMD` | `npx` | Playwright MCP server command |
| `PLAYWRIGHT_MCP_ARGS` | `@playwright/mcp@latest` | Playwright MCP server arguments |
| `GITHUB_TOKEN` | — | GitHub PAT for PR operations (requires `repo` scope) |
| `GITHUB_OWNER` | — | GitHub repository owner (org or user) |
| `GITHUB_REPO` | — | GitHub repository name |
| `GIT_DEFAULT_BRANCH` | `main` | Default branch name for merging PRs |
| `MAX_REVIEW_ITERATIONS` | `5` | Max PR review rounds before escalation |
| `DASHBOARD_PORT` | `3000` | HTTP/WS server port |

See [`.env.example`](.env.example) for the full template.

---

## Output & Artifacts

Each run produces two output directories:

### Generated Project

```
generated-projects/<system-name>/    # (or the existing project in maintain mode)
├── src/                    # Application source code
├── tests/                  # Unit + integration test suites
├── docs/
│   ├── codebase-analysis.md          # (maintain mode) Persistent codebase analysis
│   ├── agents/
│   │   ├── architect-mission.md
│   │   ├── product-manager-mission.md
│   │   ├── dba-mission.md
│   │   ├── team-leader-mission.md
│   │   ├── codebase-analyzer-mission.md  # (maintain mode)
│   │   ├── qa-lead-mission.md
│   │   ├── devops-mission.md
│   │   └── [developer]-mission.md    # One per developer agent
├── Dockerfile
├── docker-compose.yml
├── k8s/                    # Kubernetes manifests
└── package.json            # (or equivalent for the chosen stack)
```

### Run Logs

```
outputs/<system-name>-<timestamp>/
├── run.log                 # Full console log (ANSI stripped)
├── codebase-analysis.md    # (maintain mode) Snapshot of the analysis for this run
├── state.json              # Final ProjectState snapshot
└── artifacts/              # Mission reports + diagrams
```

### Mission Reports

Every agent writes a detailed Markdown mission report including:
- Agent identity and role
- Input context received
- Decisions made and reasoning
- Output produced
- Mermaid diagrams (architecture, ERD, data-flow, sequence)

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Orchestration** | LangGraph (StateGraph, Annotations, conditional edges, HITL interrupts) |
| **Agent Framework** | LangChain (`createReactAgent`, `ChatOpenAI`, structured output) |
| **GitHub Integration** | Octokit REST (PR creation, code reviews, merge) |
| **Schema Validation** | Zod (20+ schemas for all domain entities) |
| **Runtime** | Node.js 20+ with TypeScript (tsx) |
| **Container Management** | Dockerode + Docker Compose |
| **E2E Testing** | Playwright MCP (Model Context Protocol) |
| **Server** | Express + WebSocket (ws) |
| **Dashboard** | Angular 19 (standalone components) |
| **Authentication** | OAuth2 client-credentials flow with token caching |
| **Logging** | ANSI 256-color per-agent console logging + file capture |

---

## License

MIT
