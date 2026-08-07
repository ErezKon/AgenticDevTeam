# AgenticDevTeam: LangGraph Multi-Agent Architecture Deep Dive

## Table of Contents

1. [Overview](#1-overview)
2. [Core Communication Mechanism: Shared State](#2-core-communication-mechanism-shared-state)
3. [The LangGraph Conductor Graph](#3-the-langgraph-conductor-graph)
4. [Agent Roster & Roles](#4-agent-roster--roles)
5. [Data Flow: How One Agent's Output Becomes Another's Input](#5-data-flow-how-one-agents-output-becomes-anothers-input)
6. [Detailed Phase-by-Phase Data Flow](#6-detailed-phase-by-phase-data-flow)
7. [Fan-Out / Fan-In: Parallel Developer Execution](#7-fan-out--fan-in-parallel-developer-execution)
8. [The Bug-Fix Feedback Loop](#8-the-bug-fix-feedback-loop)
9. [The PR Workflow & Code Review Loop](#9-the-pr-workflow--code-review-loop)
10. [Human-in-the-Loop (HITL) Interrupts](#10-human-in-the-loop-hitl-interrupts)
11. [Event Bus: Real-Time Observability](#11-event-bus-real-time-observability)
12. [Schema Traceability Chain](#12-schema-traceability-chain)
13. [Context Building: State-to-Prompt Translation](#13-context-building-state-to-prompt-translation)
14. [Quality & Security Gates](#14-quality--security-gates)
15. [Summary](#15-summary)

---

## 1. Overview

AgenticDevTeam is a **LangGraph-based multi-agent system** that simulates a complete software development team. It orchestrates specialized AI agents -- Architect, Product Manager, DBA, Team Leader, Developers, QA Engineers, and DevOps -- through a structured graph pipeline to transform requirements into a fully built, tested, and deployed software project.

The agents do **not** communicate directly with each other. Instead, they communicate through a **shared state object** managed by the LangGraph runtime. Each agent reads from the shared state, performs its work, and writes its output back to the shared state. The next agent in the graph then reads that updated state as its input.

```mermaid
graph LR
    subgraph "Communication Model"
        A["Agent A"] -->|writes to| S[("Shared State<br/>(ProjectState)")]
        S -->|reads from| B["Agent B"]
        B -->|writes to| S
        S -->|reads from| C["Agent C"]
    end

    style S fill:#f9a825,stroke:#f57f17,stroke-width:3px,color:#000
    style A fill:#1565c0,stroke:#0d47a1,color:#fff
    style B fill:#2e7d32,stroke:#1b5e20,color:#fff
    style C fill:#6a1b9a,stroke:#4a148c,color:#fff
```

---

## 2. Core Communication Mechanism: Shared State

### How It Works

The entire system revolves around a single **`ProjectState`** object defined as a LangGraph `Annotation.Root`. This is not a simple object -- it uses **reducers** to control how updates are merged:

- **Append Reducers** (arrays): New items are concatenated onto existing arrays. Multiple agents can contribute to the same list across phases without overwriting each other.
- **Replace Reducers** (scalars/objects): Last-write-wins. Used for singular artifacts like `architecture` or control flags like `phase`.
- **Deep-Merge Reducer**: Used for `phaseFeedback` (a `Record<string, string[]>`) where feedback arrays are concatenated per phase key.

```mermaid
graph TB
    subgraph "State Update Flow"
        direction TB
        N1["architectNode()"] -->|"returns Partial&lt;State&gt;"| R["LangGraph Runtime<br/>Reducer Engine"]
        R -->|"append: epics[] += new epics"| S[("ProjectState")]
        R -->|"replace: architecture = new doc"| S
        S -->|"full accumulated state"| N2["productManagerNode()"]
        N2 -->|"returns Partial&lt;State&gt;"| R2["LangGraph Runtime<br/>Reducer Engine"]
        R2 -->|"append: userStories[] += new stories"| S
        R2 -->|"append: tasks[] += new tasks"| S
    end

    style S fill:#f9a825,stroke:#f57f17,stroke-width:3px,color:#000
    style R fill:#e65100,stroke:#bf360c,color:#fff
    style R2 fill:#e65100,stroke:#bf360c,color:#fff
    style N1 fill:#1565c0,stroke:#0d47a1,color:#fff
    style N2 fill:#2e7d32,stroke:#1b5e20,color:#fff
```

### The Complete Shared State Schema

| Field | Type | Reducer | Written By | Read By |
|---|---|---|---|---|
| `input` | `RunInput` | replace | intake | all nodes |
| `workspacePath` | `string` | replace | intake | all nodes |
| `outputPath` | `string` | replace | intake | finalize, crash handlers |
| `systemBranch` | `string` | replace | intake | development, QA, devops |
| `gitContext` | `GitContext` | replace | intake | all git-touching nodes |
| `codebaseAnalysis` | `CodebaseAnalysis` | replace | codebase-analyzer | architect, PM, DBA, TL, dev, QA, devops |
| `architecture` | `ArchitectureDoc` | replace | architect | PM, DBA, TL, dev, QA, devops, finalize |
| `epics` | `Epic[]` | **append** | architect | PM |
| `techStack` | `TechDecision[]` | **append** | architect | PM, DBA, TL, dev, QA, devops |
| `dbDesign` | `DbDesign` | replace | DBA | TL, dev, QA, devops |
| `userStories` | `UserStory[]` | **append** | PM | TL, dev, QA, finalize |
| `tasks` | `Task[]` | **append** | PM | TL |
| `assignments` | `Assignment[]` | **append** | TL, bugfix-triage | development |
| `completedAssignmentIds` | `string[]` | **append** | development | development, bugfix-triage |
| `fileChanges` | `FileChange[]` | **append** | dev, QA, devops | dev, devops, finalize |
| `testPlan` | `TestPlan` | replace | QA-lead | QA-unit, QA-e2e, finalize |
| `testReports` | `TestReport[]` | **append** | QA, e2e | afterQaRouter, afterE2eRouter |
| `bugs` | `Bug[]` | **append** | QA, e2e, quality/security gates | bugfix-triage |
| `fixedBugIds` | `string[]` | **append** | bugfix-triage | bugfix-triage |
| `devopsPlan` | `DevOpsPlan` | replace | devops | e2e |
| `runningContainers` | `string[]` | replace | devops | finalize (teardown) |
| `pullRequests` | `PullRequest[]` | **append** | development | finalize |
| `phase` | `PhaseName` | replace | every node | HITL, routers |
| `iteration` | `{bugfix: number}` | replace | bugfix-triage | routers |
| `approvals` | `Approval[]` | **append** | HITL | -- |
| `pendingRerun` | `PhaseName` | replace | HITL | rerunRouter |
| `phaseFeedback` | `Record<string,string[]>` | **deep-merge** | HITL | every node |
| `cancelled` | `boolean` | replace | HITL | all routers |
| `artifacts` | `ArtifactRef[]` | **append** | every node | finalize |
| `transcript` | `TranscriptMessage[]` | **append** | every node | -- |
| `tokenUsage` | `TokenCallRecord[]` | **append** | every node | finalize |

---

## 3. The LangGraph Conductor Graph

The graph is built by `buildConductorGraph()` and uses **conditional edges** and **routers** to control flow based on runtime state.

### Full Graph Topology

```mermaid
flowchart TD
    START(("__start__")) --> intake

    intake --> afterIntakeRouter{"afterIntakeRouter"}

    afterIntakeRouter -->|"runType = maintain"| codebase-analyzer["Codebase Analyzer"]
    afterIntakeRouter -->|"runType = greenfield"| architect["Architect"]

    codebase-analyzer --> rerun1{"rerunRouter"}
    rerun1 -->|"enhance (self-loop)"| codebase-analyzer
    rerun1 -->|"next"| architect
    rerun1 -->|"cancelled"| finalize

    architect --> rerun2{"rerunRouter"}
    rerun2 -->|"enhance"| architect
    rerun2 -->|"next"| pm["Product Manager"]
    rerun2 -->|"cancelled"| finalize

    pm --> rerun3{"rerunRouter"}
    rerun3 -->|"enhance"| pm
    rerun3 -->|"next"| dba["DBA"]
    rerun3 -->|"cancelled"| finalize

    dba --> rerun4{"rerunRouter"}
    rerun4 -->|"enhance"| dba
    rerun4 -->|"next"| tl["Team Leader"]
    rerun4 -->|"cancelled"| finalize

    tl --> rerun5{"rerunRouter"}
    rerun5 -->|"enhance"| tl
    rerun5 -->|"next"| dev["Development"]
    rerun5 -->|"cancelled"| finalize

    dev --> rerun6{"rerunRouter"}
    rerun6 -->|"enhance"| dev
    rerun6 -->|"next"| qa["QA"]
    rerun6 -->|"cancelled"| finalize

    qa --> afterQaRouter{"afterQaRouter"}
    afterQaRouter -->|"failures + budget"| bugfix["Bugfix Triage"]
    afterQaRouter -->|"all pass"| devops["DevOps"]
    afterQaRouter -->|"cancelled"| finalize

    bugfix -->|"always"| dev

    devops --> rerun7{"rerunRouter"}
    rerun7 -->|"enhance"| devops
    rerun7 -->|"next"| e2e["E2E Testing"]
    rerun7 -->|"cancelled"| finalize

    e2e --> afterE2eRouter{"afterE2eRouter"}
    afterE2eRouter -->|"E2E bugfix enabled + failures"| bugfix
    afterE2eRouter -->|"pass / no E2E bugfix"| finalize
    afterE2eRouter -->|"cancelled"| finalize

    finalize --> END(("END"))

    style START fill:#424242,stroke:#212121,color:#fff
    style END fill:#424242,stroke:#212121,color:#fff
    style intake fill:#546e7a,stroke:#37474f,color:#fff
    style codebase-analyzer fill:#00838f,stroke:#006064,color:#fff
    style architect fill:#1565c0,stroke:#0d47a1,color:#fff
    style pm fill:#2e7d32,stroke:#1b5e20,color:#fff
    style dba fill:#6a1b9a,stroke:#4a148c,color:#fff
    style tl fill:#d84315,stroke:#bf360c,color:#fff
    style dev fill:#f9a825,stroke:#f57f17,color:#000
    style qa fill:#00695c,stroke:#004d40,color:#fff
    style bugfix fill:#c62828,stroke:#b71c1c,color:#fff
    style devops fill:#283593,stroke:#1a237e,color:#fff
    style e2e fill:#00838f,stroke:#006064,color:#fff
    style finalize fill:#424242,stroke:#212121,color:#fff

    style afterIntakeRouter fill:#fff3e0,stroke:#e65100,color:#000
    style rerun1 fill:#fff3e0,stroke:#e65100,color:#000
    style rerun2 fill:#fff3e0,stroke:#e65100,color:#000
    style rerun3 fill:#fff3e0,stroke:#e65100,color:#000
    style rerun4 fill:#fff3e0,stroke:#e65100,color:#000
    style rerun5 fill:#fff3e0,stroke:#e65100,color:#000
    style rerun6 fill:#fff3e0,stroke:#e65100,color:#000
    style rerun7 fill:#fff3e0,stroke:#e65100,color:#000
    style afterQaRouter fill:#fff3e0,stroke:#e65100,color:#000
    style afterE2eRouter fill:#fff3e0,stroke:#e65100,color:#000
```

### Router Logic Summary

| Router | Conditions | Targets |
|--------|-----------|---------|
| `afterIntakeRouter` | `runType === 'maintain'` vs `'greenfield'` | codebase-analyzer vs architect |
| `rerunRouter(phase)` | `pendingRerun === phase` / `cancelled` / normal | self-loop / finalize / next node |
| `afterQaRouter` | test failures + budget remaining / cancelled | bugfix-triage / devops / finalize |
| `afterBugfixRouter` | (unconditional) | development |
| `afterE2eRouter` | `E2E_BUGFIX_ENABLED` + failures / cancelled | bugfix-triage / finalize |

---

## 4. Agent Roster & Roles

```mermaid
graph TB
    subgraph "Analysis"
        CA["Codebase Analyzer<br/><i>Reverse-engineers existing code</i>"]
    end

    subgraph "Management & Planning"
        AR["Architect<br/><i>System design, tech stack, epics</i>"]
        PM["Product Manager<br/><i>User stories & tasks</i>"]
        DBA["DBA<br/><i>Database design</i>"]
        TL["Team Leader<br/><i>Task assignments</i>"]
    end

    subgraph "Development (11 Agents)"
        PF["Principal Frontend"]
        PB["Principal Backend"]
        SF["Senior Frontend"]
        SB["Senior Backend"]
        JA["Junior Angular"]
        JR["Junior React"]
        JV["Junior Vue"]
        JCS["Junior C#"]
        JJ["Junior Java"]
        JG["Junior Go"]
        JP["Junior Python"]
    end

    subgraph "Code Review (Same 11 Agents)"
        RV["Reviewer Mode<br/><i>Read-only git tools</i>"]
    end

    subgraph "Quality Assurance"
        QL["QA Lead<br/><i>Test strategy & plan</i>"]
        QU["QA Unit/Integration<br/><i>Write & run tests</i>"]
        QE["QA E2E<br/><i>Playwright browser tests</i>"]
    end

    subgraph "Operations"
        DO["DevOps Engineer<br/><i>Docker, CI/CD, deploy</i>"]
    end

    style CA fill:#00838f,stroke:#006064,color:#fff
    style AR fill:#1565c0,stroke:#0d47a1,color:#fff
    style PM fill:#2e7d32,stroke:#1b5e20,color:#fff
    style DBA fill:#6a1b9a,stroke:#4a148c,color:#fff
    style TL fill:#d84315,stroke:#bf360c,color:#fff
    style PF fill:#f9a825,stroke:#f57f17,color:#000
    style PB fill:#f9a825,stroke:#f57f17,color:#000
    style SF fill:#fbc02d,stroke:#f9a825,color:#000
    style SB fill:#fbc02d,stroke:#f9a825,color:#000
    style JA fill:#fff176,stroke:#fbc02d,color:#000
    style JR fill:#fff176,stroke:#fbc02d,color:#000
    style JV fill:#fff176,stroke:#fbc02d,color:#000
    style JCS fill:#fff176,stroke:#fbc02d,color:#000
    style JJ fill:#fff176,stroke:#fbc02d,color:#000
    style JG fill:#fff176,stroke:#fbc02d,color:#000
    style JP fill:#fff176,stroke:#fbc02d,color:#000
    style RV fill:#ff8a65,stroke:#e64a19,color:#000
    style QL fill:#00695c,stroke:#004d40,color:#fff
    style QU fill:#00897b,stroke:#00695c,color:#fff
    style QE fill:#26a69a,stroke:#00897b,color:#fff
    style DO fill:#283593,stroke:#1a237e,color:#fff
```

### Agent Capabilities

| Agent | Has Tools | Structured Output Schema | Temperature |
|-------|-----------|------------------------|-------------|
| Codebase Analyzer | `read_file`, `list_dir`, `search_code` | `CodebaseAnalysisSchema` | 0.1 |
| Architect | `emitMermaidTool` | `ArchitectOutputSchema` | 0.3 |
| Product Manager | None | `PMOutputSchema` | 0.3 |
| DBA | None | `DbaOutputSchema` | 0.2 |
| Team Leader | None | `TLOutputSchema` | 0.2 |
| Developer (x11) | `read_file`, `list_dir`, `search_code`, `write_file`, `edit_file`, `git_*`, `run_command` | `DeveloperOutputSchema` | 0.2-0.3 |
| Reviewer (x11) | Read-only git (6 tools) | `ReviewOutputSchema` | 0.1 |
| QA Lead | None | `QaLeadOutputSchema` | 0.2 |
| QA Unit | `read_file`, `list_dir`, `search_code`, `write_file`, `edit_file`, `run_command` | `QaUnitOutputSchema` | 0.2 |
| QA E2E | Playwright MCP tools | `QaE2eOutputSchema` | 0.1 |
| DevOps | `read_file`, `list_dir`, `search_code`, `write_file`, `edit_file`, `run_command` | `DevOpsOutputSchema` | 0.2 |

---

## 5. Data Flow: How One Agent's Output Becomes Another's Input

Agents do **not** call each other directly. The communication flow is:

1. **Node function** reads relevant fields from the accumulated `ProjectState`
2. **Context builder** (`context-builder.ts`) transforms raw state data into compact, prioritized text summaries
3. The text summary becomes the **user message** passed to the LLM agent
4. The LLM agent produces a **structured JSON output** (enforced via Zod schema injected into the system prompt)
5. The node function **parses** the JSON output and returns a `Partial<ProjectState>` update
6. The **LangGraph reducer** merges the partial update into the accumulated state
7. The next node in the graph receives the **full updated state**

```mermaid
sequenceDiagram
    participant S as ProjectState
    participant NF as Node Function
    participant CB as Context Builder
    participant LLM as LLM Agent
    participant R as Reducer

    S->>NF: Full accumulated state
    NF->>CB: Extract relevant fields
    CB->>CB: Summarize & budget-clip
    CB-->>NF: Compact text context
    NF->>LLM: System prompt + context + schema
    LLM->>LLM: Reason + use tools (if any)
    LLM-->>NF: Structured JSON output
    NF->>NF: Parse & validate output
    NF->>R: Return Partial<ProjectState>
    R->>S: Merge (append arrays / replace scalars)
    Note over S: State grows with each phase
    S->>NF: Next node reads updated state
```

### Concrete Example: Architect to Product Manager

```mermaid
sequenceDiagram
    participant AS as Architect State Output
    participant ST as ProjectState
    participant PMN as PM Node Function
    participant PMC as PM Context Builder
    participant PMA as PM LLM Agent

    AS->>ST: architecture (replace)<br/>techStack[] (append)<br/>epics[] (append)

    ST->>PMN: Read: architecture,<br/>techStack, epics,<br/>input, codebaseAnalysis

    PMN->>PMC: summariseArchitecture(arch)<br/>summariseTechStack(stack)<br/>+ epics + requirements

    PMC-->>PMN: "## Architecture\nStyle: microservices\n..."<br/>"## Tech Stack\nFrontend: React..."<br/>"## Epics\nEPIC-001: User Auth..."

    PMN->>PMA: "Given this architecture and epics,<br/>produce user stories and tasks"

    PMA-->>PMN: { userStories: [...], tasks: [...] }

    PMN->>ST: userStories[] (append)<br/>tasks[] (append)
```

---

## 6. Detailed Phase-by-Phase Data Flow

```mermaid
flowchart LR
    subgraph "Phase 1: Intake"
        I_IN["Requirements Doc"] --> I["intake"]
        I --> I_OUT["workspacePath<br/>outputPath<br/>systemBranch<br/>gitContext"]
    end

    subgraph "Phase 1b: Analysis (maintain only)"
        I_OUT -.-> CA["Codebase<br/>Analyzer"]
        CA --> CA_OUT["codebaseAnalysis"]
    end

    subgraph "Phase 2: Architecture"
        I_OUT --> AR["Architect"]
        CA_OUT -.-> AR
        AR --> AR_OUT["architecture<br/>techStack[]<br/>epics[]"]
    end

    subgraph "Phase 3: Product Management"
        AR_OUT --> PM["Product<br/>Manager"]
        PM --> PM_OUT["userStories[]<br/>tasks[]"]
    end

    subgraph "Phase 4: Database Design"
        AR_OUT --> DBA["DBA"]
        PM_OUT --> DBA
        DBA --> DBA_OUT["dbDesign"]
    end

    subgraph "Phase 5: Task Assignment"
        AR_OUT --> TL["Team<br/>Leader"]
        PM_OUT --> TL
        DBA_OUT --> TL
        TL --> TL_OUT["assignments[]"]
    end

    subgraph "Phase 6: Development"
        TL_OUT --> DEV["Developer<br/>Agents"]
        DEV --> DEV_OUT["fileChanges[]<br/>pullRequests[]<br/>completedAssignmentIds[]"]
    end

    subgraph "Phase 7: QA"
        DEV_OUT --> QA["QA<br/>Pipeline"]
        QA --> QA_OUT["testPlan<br/>testReports[]<br/>bugs[]"]
    end

    subgraph "Phase 8: DevOps"
        DEV_OUT --> DO["DevOps"]
        DO --> DO_OUT["devopsPlan<br/>runningContainers[]"]
    end

    subgraph "Phase 9: E2E"
        DO_OUT --> E2E["E2E<br/>Testing"]
        QA_OUT -.-> E2E
        E2E --> E2E_OUT["testReports[]<br/>bugs[]"]
    end

    subgraph "Phase 10: Finalize"
        E2E_OUT --> FIN["Finalize"]
        FIN --> FIN_OUT["Summary<br/>Token Report<br/>Traceability Matrix"]
    end

    style I fill:#546e7a,stroke:#37474f,color:#fff
    style CA fill:#00838f,stroke:#006064,color:#fff
    style AR fill:#1565c0,stroke:#0d47a1,color:#fff
    style PM fill:#2e7d32,stroke:#1b5e20,color:#fff
    style DBA fill:#6a1b9a,stroke:#4a148c,color:#fff
    style TL fill:#d84315,stroke:#bf360c,color:#fff
    style DEV fill:#f9a825,stroke:#f57f17,color:#000
    style QA fill:#00695c,stroke:#004d40,color:#fff
    style DO fill:#283593,stroke:#1a237e,color:#fff
    style E2E fill:#00838f,stroke:#006064,color:#fff
    style FIN fill:#424242,stroke:#212121,color:#fff

    style I_OUT fill:#eceff1,stroke:#90a4ae,color:#000
    style CA_OUT fill:#e0f7fa,stroke:#00838f,color:#000
    style AR_OUT fill:#e3f2fd,stroke:#1565c0,color:#000
    style PM_OUT fill:#e8f5e9,stroke:#2e7d32,color:#000
    style DBA_OUT fill:#f3e5f5,stroke:#6a1b9a,color:#000
    style TL_OUT fill:#fbe9e7,stroke:#d84315,color:#000
    style DEV_OUT fill:#fffde7,stroke:#f9a825,color:#000
    style QA_OUT fill:#e0f2f1,stroke:#00695c,color:#000
    style DO_OUT fill:#e8eaf6,stroke:#283593,color:#000
    style E2E_OUT fill:#e0f7fa,stroke:#00838f,color:#000
    style FIN_OUT fill:#fafafa,stroke:#424242,color:#000
```

### What Each Agent Reads and Writes

```mermaid
graph LR
    subgraph "State Field Flow"
        direction LR

        R["requirements"] -->|intake| WS["workspacePath"]

        WS -->|codebase-analyzer| CBA["codebaseAnalysis"]
        CBA -->|architect reads| ARCH["architecture"]
        CBA -->|architect reads| TS["techStack[]"]
        CBA -->|architect reads| EP["epics[]"]

        ARCH -->|PM reads| US["userStories[]"]
        TS -->|PM reads| US
        EP -->|PM reads| US
        ARCH -->|PM reads| TK["tasks[]"]

        ARCH -->|DBA reads| DB["dbDesign"]
        US -->|DBA reads| DB
        TK -->|DBA reads| DB

        US -->|TL reads| ASG["assignments[]"]
        TK -->|TL reads| ASG
        DB -->|TL reads| ASG
        ARCH -->|TL reads| ASG

        ASG -->|dev reads| FC["fileChanges[]"]
        ASG -->|dev reads| PR["pullRequests[]"]

        FC -->|QA reads| TP["testPlan"]
        FC -->|QA reads| TR["testReports[]"]
        FC -->|QA reads| BG["bugs[]"]

        FC -->|devops reads| DP["devopsPlan"]

        DP -->|e2e reads| TR2["testReports[]"]
        TP -->|e2e reads| TR2
    end

    style R fill:#78909c,color:#fff
    style CBA fill:#00838f,color:#fff
    style ARCH fill:#1565c0,color:#fff
    style TS fill:#1976d2,color:#fff
    style EP fill:#1e88e5,color:#fff
    style US fill:#2e7d32,color:#fff
    style TK fill:#388e3c,color:#fff
    style DB fill:#6a1b9a,color:#fff
    style ASG fill:#d84315,color:#fff
    style FC fill:#f9a825,color:#000
    style PR fill:#fbc02d,color:#000
    style TP fill:#00695c,color:#fff
    style TR fill:#00897b,color:#fff
    style BG fill:#c62828,color:#fff
    style DP fill:#283593,color:#fff
    style TR2 fill:#00838f,color:#fff
    style WS fill:#546e7a,color:#fff
```

---

## 7. Fan-Out / Fan-In: Parallel Developer Execution

The **Development** phase is the only true fan-out point in the graph. The `dispatcher.ts` module orchestrates parallel execution of developer agents:

```mermaid
flowchart TB
    TL_OUT["assignments[]<br/>from Team Leader"] --> FILTER["selectPendingAssignments()<br/><i>Filter out completed</i>"]

    FILTER --> TOPO["topoSort(assignments)<br/><i>Dependency ordering</i>"]

    TOPO --> L1["Layer 1<br/><i>No dependencies</i>"]
    TOPO --> L2["Layer 2<br/><i>Depends on Layer 1</i>"]
    TOPO --> L3["Layer 3<br/><i>Depends on Layer 2</i>"]

    L1 --> GB1["groupByBranch()<br/><i>One branch per user story</i>"]

    GB1 --> B1["Branch: feat/US-001<br/>ASSIGN-001, ASSIGN-002"]
    GB1 --> B2["Branch: feat/US-002<br/>ASSIGN-003"]
    GB1 --> B3["Branch: feat/US-003<br/>ASSIGN-004, ASSIGN-005"]

    subgraph "Parallel Batch (MAX_CONCURRENT_DEVS = 2)"
        B1 --> PR1["PR Workflow #1"]
        B2 --> PR2["PR Workflow #2"]
    end

    subgraph "Next Batch"
        B3 --> PR3["PR Workflow #3"]
    end

    PR1 --> COLLECT["Promise.allSettled()<br/><i>Fan-In: Aggregate Results</i>"]
    PR2 --> COLLECT
    PR3 --> COLLECT

    COLLECT --> SYNC["syncWorkspaceToBranch()<br/><i>Pull merged changes</i>"]

    SYNC --> RESULT["DispatchResult<br/>fileChanges[]<br/>pullRequests[]<br/>completedAssignmentIds[]<br/>artifacts[]<br/>tokenUsage[]"]

    style TL_OUT fill:#fbe9e7,stroke:#d84315,color:#000
    style FILTER fill:#fff3e0,stroke:#e65100,color:#000
    style TOPO fill:#fff3e0,stroke:#e65100,color:#000
    style L1 fill:#e8eaf6,stroke:#3949ab,color:#000
    style L2 fill:#e8eaf6,stroke:#3949ab,color:#000
    style L3 fill:#e8eaf6,stroke:#3949ab,color:#000
    style GB1 fill:#fff3e0,stroke:#e65100,color:#000
    style B1 fill:#f9a825,stroke:#f57f17,color:#000
    style B2 fill:#f9a825,stroke:#f57f17,color:#000
    style B3 fill:#f9a825,stroke:#f57f17,color:#000
    style PR1 fill:#1565c0,stroke:#0d47a1,color:#fff
    style PR2 fill:#2e7d32,stroke:#1b5e20,color:#fff
    style PR3 fill:#6a1b9a,stroke:#4a148c,color:#fff
    style COLLECT fill:#e65100,stroke:#bf360c,color:#fff
    style SYNC fill:#546e7a,stroke:#37474f,color:#fff
    style RESULT fill:#fffde7,stroke:#f9a825,color:#000
```

### Key Design Decisions

- **One branch per user story**: All assignments sharing a `storyId` are grouped onto the same feature branch via `canonicalBranchName()`
- **Git worktree isolation**: Each branch gets its own git worktree directory, so parallel dev agents never conflict on `git checkout`
- **Concurrency limit**: `MAX_CONCURRENT_DEVS` (default 2) prevents API rate-limit storms
- **Inter-batch delay**: `INTER_BATCH_DELAY_MS` (default 5s) adds breathing room between batches
- **Budget guard**: `getEffectiveLimits().allowNewBranchWorkflows` stops dispatching when token/cost/time budget is exhausted

---

## 8. The Bug-Fix Feedback Loop

When QA discovers bugs, the system enters a **bounded feedback loop** that routes bugs back through development:

```mermaid
flowchart LR
    QA["QA Node"] -->|"testReports with failures"| ROUTER{"afterQaRouter"}

    ROUTER -->|"failures + budget left"| BF["Bugfix Triage"]
    ROUTER -->|"all pass"| DEVOPS["DevOps"]
    ROUTER -->|"budget exhausted"| DEVOPS

    BF -->|"1. Deduplicate bugs<br/>2. Filter already-fixed<br/>3. Create new assignments<br/>4. Namespace IDs (BUGFIX-N-...)"| DEV["Development"]

    DEV -->|"Fix code<br/>Create PRs"| QA

    subgraph "Loop Bounds"
        ITER["iteration.bugfix < MAX_BUGFIX_ITERATIONS (3)"]
    end

    style QA fill:#00695c,stroke:#004d40,color:#fff
    style BF fill:#c62828,stroke:#b71c1c,color:#fff
    style DEV fill:#f9a825,stroke:#f57f17,color:#000
    style DEVOPS fill:#283593,stroke:#1a237e,color:#fff
    style ROUTER fill:#fff3e0,stroke:#e65100,color:#000
    style ITER fill:#ffebee,stroke:#c62828,color:#000
```

### Anti-Duplication Mechanisms

| Mechanism | Purpose |
|-----------|---------|
| `namespaceBugfixAssignments()` | Prefixes bug-fix assignment IDs (`BUGFIX-2-ASSIGN-003`) to avoid collisions with original assignments |
| `selectPendingAssignments()` | Filters out assignments whose IDs are already in `completedAssignmentIds` |
| `dedupeBugs()` | Deduplicates bugs by ID |
| `fixedBugIds[]` | Tracks which bugs are being addressed across iterations |

### E2E Bug-Fix Loop

An optional second loop exists after E2E testing, gated by the `E2E_BUGFIX_ENABLED` config flag. It follows the same pattern: `e2e` -> `bugfix-triage` -> `development` -> `qa` -> `devops` -> `e2e`.

---

## 9. The PR Workflow & Code Review Loop

Inside each branch during the Development phase, a full PR lifecycle runs with its own internal loop:

```mermaid
flowchart TB
    START["Branch Assignments"] --> WT["Create Git Worktree<br/><i>Isolated workspace</i>"]
    WT --> DEV["Developer Agent<br/><i>Write code (TDD)</i>"]

    DEV --> QG["Quality Gates<br/><i>install/build/lint/test</i>"]
    QG --> SEC["Secret Scan<br/><i>Regex-based detection</i>"]
    SEC --> PR["Create GitHub PR"]

    PR --> REV{"Review Loop"}

    REV --> R1["Reviewer 1<br/><i>Code review</i>"]
    R1 -->|"approved"| CHECK{"All Approved?"}
    R1 -->|"changes_requested"| FIX1["Developer Fix"]
    FIX1 --> R1

    CHECK -->|"yes"| MERGE
    CHECK -->|"no, more reviewers"| R2["Reviewer 2<br/><i>Code review</i>"]
    R2 -->|"approved"| MERGE
    R2 -->|"changes_requested"| FIX2["Developer Fix"]
    FIX2 --> R2

    REV -->|"maxReviewIterations<br/>reached"| ESC{"Escalation?"}
    ESC -->|"CRITICALs persist"| HIGHERRANK["Higher-Rank Dev<br/>+ Reviewer"]
    ESC -->|"no CRITICALs"| MERGE

    HIGHERRANK --> MERGE["Squash Merge PR"]
    MERGE --> CLEAN["Cleanup Worktree"]

    style START fill:#fbe9e7,stroke:#d84315,color:#000
    style WT fill:#546e7a,stroke:#37474f,color:#fff
    style DEV fill:#f9a825,stroke:#f57f17,color:#000
    style QG fill:#00695c,stroke:#004d40,color:#fff
    style SEC fill:#c62828,stroke:#b71c1c,color:#fff
    style PR fill:#1565c0,stroke:#0d47a1,color:#fff
    style REV fill:#fff3e0,stroke:#e65100,color:#000
    style R1 fill:#ff8a65,stroke:#e64a19,color:#000
    style R2 fill:#ff8a65,stroke:#e64a19,color:#000
    style FIX1 fill:#fbc02d,stroke:#f9a825,color:#000
    style FIX2 fill:#fbc02d,stroke:#f9a825,color:#000
    style CHECK fill:#fff3e0,stroke:#e65100,color:#000
    style ESC fill:#ffebee,stroke:#c62828,color:#000
    style HIGHERRANK fill:#d84315,stroke:#bf360c,color:#fff
    style MERGE fill:#2e7d32,stroke:#1b5e20,color:#fff
    style CLEAN fill:#78909c,stroke:#546e7a,color:#fff
```

### Review Loop Termination Conditions

1. All reviewers approved
2. `MAX_REVIEW_ITERATIONS` (default 5) reached -- force merge with warning
3. `MAX_NO_PROGRESS_ITERATIONS` (2) consecutive iterations with no new commits
4. Rate-limit retries exhausted

### Review Severity Discipline

Only `critical` and `major` severity comments block merge. `minor` and `suggestion` comments are recorded but don't trigger another dev+review round trip.

---

## 10. Human-in-the-Loop (HITL) Interrupts

In `human` mode, the graph pauses before each major phase for human approval:

```mermaid
sequenceDiagram
    participant G as LangGraph Runtime
    participant H as Human (CLI/Dashboard)
    participant N as Node Function

    G->>G: Reach HITL interrupt point
    G-->>H: Pause & show state summary

    alt Approve
        H->>G: decision: "approve"
        G->>G: Add Approval to state
        G->>N: Resume to next node
    else Deny
        H->>G: decision: "deny"
        G->>G: Set cancelled = true
        G->>N: Route to finalize
    else Enhance
        H->>G: decision: "enhance" + feedback text
        G->>G: Set pendingRerun = currentPhase
        G->>G: Append phaseFeedback[phase]
        G->>N: Re-run same node with feedback
        N->>N: Read feedback, incorporate into prompt
        N->>G: Return enhanced output
        G-->>H: Pause again for approval
    end
```

### HITL Interrupt Points

Interrupts are placed **before** each of these nodes: `codebase-analyzer`, `architect`, `product-manager`, `dba`, `team-leader`, `development`, `qa`, `devops`, `e2e`.

The `enhance` option creates a **one-shot self-loop**: the node re-runs with the user's feedback injected into the prompt via `buildFeedbackSection()`. After re-execution, the graph pauses again at the same HITL point, allowing the user to approve, deny, or enhance again.

---

## 11. Event Bus: Real-Time Observability

The event bus provides a **parallel communication channel** for observability. It does **not** affect agent behavior -- it is purely for real-time monitoring via the dashboard WebSocket.

```mermaid
flowchart LR
    subgraph "Event Producers"
        N["Node Functions"]
        PW["PR Workflow"]
        QG["Quality Gates"]
        TT["Token Tracker"]
        RB["Run Budget"]
    end

    N -->|"phase:start<br/>phase:end<br/>agent:start<br/>agent:end<br/>agent:respawn<br/>transcript"| EB[("Event Bus<br/>(Ring Buffer)<br/>500 events")]

    PW -->|"pr:opened<br/>pr:reviewed<br/>pr:merged"| EB
    QG -->|"gate:result"| EB
    TT -->|"tokens:update"| EB
    RB -->|"budget:level"| EB

    EB -->|"onRunEvent()"| WS["WebSocket<br/>Broadcast"]
    WS --> DASH["Angular Dashboard"]
    WS --> CLI["CLI Display"]

    EB -->|"getRecentEvents()"| BACKFILL["Reconnecting<br/>Clients"]

    style EB fill:#f9a825,stroke:#f57f17,stroke-width:3px,color:#000
    style N fill:#1565c0,stroke:#0d47a1,color:#fff
    style PW fill:#2e7d32,stroke:#1b5e20,color:#fff
    style QG fill:#00695c,stroke:#004d40,color:#fff
    style TT fill:#6a1b9a,stroke:#4a148c,color:#fff
    style RB fill:#c62828,stroke:#b71c1c,color:#fff
    style WS fill:#283593,stroke:#1a237e,color:#fff
    style DASH fill:#e8eaf6,stroke:#283593,color:#000
    style CLI fill:#e8eaf6,stroke:#283593,color:#000
    style BACKFILL fill:#e8eaf6,stroke:#283593,color:#000
```

### Event Types

| Event | Emitted By | Purpose |
|-------|-----------|---------|
| `phase:start` | All node functions | Signal phase entry |
| `phase:end` | All node functions | Signal phase completion |
| `agent:start` | Node functions | LLM agent invocation begins |
| `agent:end` | Node functions | LLM agent invocation completes |
| `agent:respawn` | PR workflow | Dev agent ceiling-hit triggers fresh-context respawn with handoff |
| `pr:opened` | PR workflow | GitHub PR created |
| `pr:reviewed` | PR workflow | Code review completed |
| `pr:merged` | PR workflow | PR squash-merged |
| `gate:result` | Quality gates | Build/lint/test results |
| `tokens:update` | Token tracker | Token usage per LLM call |
| `budget:level` | Run budget | Budget utilization alerts |
| `transcript` | Node functions | Human-readable progress messages |

---

## 12. Schema Traceability Chain

One of the most important design decisions is **end-to-end traceability**. Every artifact traces back to the original requirement through a chain of IDs:

```mermaid
flowchart TD
    REQ["Requirements Document"] --> EPIC["Epic<br/>id: EPIC-001"]

    EPIC -->|epicId| US["User Story<br/>id: US-001<br/>epicId: EPIC-001<br/>acceptanceCriteria[]"]

    US -->|storyId| TASK["Task<br/>id: TASK-001<br/>storyId: US-001"]

    US -->|storyId| ASSIGN["Assignment<br/>id: ASSIGN-001<br/>storyId: US-001<br/>devAgentId: senior-frontend"]

    ASSIGN -->|dependsOn| ASSIGN2["Assignment<br/>id: ASSIGN-002<br/>dependsOn: [ASSIGN-001]"]

    ASSIGN -->|storyId + agentId| FC["FileChange<br/>path: src/auth/login.tsx<br/>storyId: US-001<br/>agentId: senior-frontend"]

    ASSIGN -->|assignmentIds| PROBJ["PullRequest<br/>assignmentIds: [ASSIGN-001]<br/>branchName: feat/US-001"]

    US -->|storyId + acIndex| TP["TestPlan Item<br/>storyId: US-001<br/>acIndex: 0"]

    TP -->|storyId + acIndex| TR["TestReport Case<br/>storyId: US-001<br/>acIndex: 0<br/>status: pass"]

    TR -->|failingTestId| BUG["Bug<br/>id: BUG-001<br/>failingTestId: test-123<br/>suggestedAssignee: senior-frontend"]

    style REQ fill:#424242,stroke:#212121,color:#fff
    style EPIC fill:#1565c0,stroke:#0d47a1,color:#fff
    style US fill:#2e7d32,stroke:#1b5e20,color:#fff
    style TASK fill:#388e3c,stroke:#2e7d32,color:#fff
    style ASSIGN fill:#d84315,stroke:#bf360c,color:#fff
    style ASSIGN2 fill:#e64a19,stroke:#d84315,color:#fff
    style FC fill:#f9a825,stroke:#f57f17,color:#000
    style PROBJ fill:#1565c0,stroke:#0d47a1,color:#fff
    style TP fill:#00695c,stroke:#004d40,color:#fff
    style TR fill:#00897b,stroke:#00695c,color:#fff
    style BUG fill:#c62828,stroke:#b71c1c,color:#fff
```

This traceability enables the **finalize** node to generate a traceability matrix mapping every requirement to its code, tests, and deployment artifacts.

---

## 13. Context Building: State-to-Prompt Translation

Raw state objects can be very large. The **context builder** (`context-builder.ts`) solves this by transforming state into compact, LLM-friendly text summaries with a priority-based character budget:

```mermaid
flowchart TD
    subgraph "Raw State (can be very large)"
        ARCH_RAW["architecture object<br/>(deep JSON)"]
        TS_RAW["techStack array<br/>(N decisions)"]
        US_RAW["userStories array<br/>(N stories with AC)"]
        FC_RAW["fileChanges array<br/>(60+ changes)"]
    end

    ARCH_RAW --> SA["summariseArchitecture()"]
    TS_RAW --> ST["summariseTechStack()"]
    US_RAW --> SU["summariseStories()"]
    FC_RAW --> SF["summariseFileChanges()"]

    SA --> BC["buildContext(sections, maxChars=24000)"]
    ST --> BC
    SU --> BC
    SF --> BC

    BC --> PRIO["Priority-Based Clipping<br/><i>Lowest priority sections<br/>dropped first when over budget</i>"]

    PRIO --> PROMPT["Final User Message<br/><i>Compact, budget-constrained<br/>text for LLM prompt</i>"]

    style ARCH_RAW fill:#e3f2fd,stroke:#1565c0,color:#000
    style TS_RAW fill:#e3f2fd,stroke:#1565c0,color:#000
    style US_RAW fill:#e8f5e9,stroke:#2e7d32,color:#000
    style FC_RAW fill:#fffde7,stroke:#f9a825,color:#000
    style SA fill:#1565c0,stroke:#0d47a1,color:#fff
    style ST fill:#1976d2,stroke:#1565c0,color:#fff
    style SU fill:#2e7d32,stroke:#1b5e20,color:#fff
    style SF fill:#f9a825,stroke:#f57f17,color:#000
    style BC fill:#e65100,stroke:#bf360c,color:#fff
    style PRIO fill:#fff3e0,stroke:#e65100,color:#000
    style PROMPT fill:#4caf50,stroke:#388e3c,color:#fff
```

### How Context Sections Work

Each context section has a **priority level**. When the total context exceeds `CONTEXT_MAX_CHARS` (default 24,000), the builder clips sections starting from the lowest priority. This ensures the most important context (e.g., architecture, current task description) is always preserved, while less critical context (e.g., full file change history) can be trimmed.

---

## 14. Quality & Security Gates

These are **deterministic verification steps** (no LLM involved) that validate agent work:

```mermaid
flowchart TB
    subgraph "Quality Gates (per detected stack)"
        QG_IN["Generated Code"] --> DETECT["detectStacks()<br/><i>Node, Maven, Gradle,<br/>Go, Python, .NET, Rust</i>"]

        DETECT --> INSTALL["npm install<br/>go mod download<br/>pip install<br/>..."]
        INSTALL --> BUILD["npm run build<br/>go build<br/>mvn compile<br/>..."]
        BUILD --> LINT["npm run lint<br/>golangci-lint<br/>flake8<br/>..."]
        LINT --> TEST["npm test<br/>go test<br/>pytest<br/>..."]

        TEST -->|"failures"| BUGS["Synthesize Bug[]<br/>objects for state"]
        TEST -->|"success"| PASS["Gate Passed"]
    end

    subgraph "Security Gates"
        SG_IN["Generated Code"] --> SECRET["scanForSecrets()<br/><i>Regex patterns for<br/>API keys, tokens, passwords</i>"]
        SG_IN --> AUDIT["auditDependencies()<br/><i>npm audit, pip-audit,<br/>go vuln check</i>"]
        SG_IN --> LIC["checkLicences()<br/><i>Deny-list check</i>"]

        SECRET -->|"findings"| SBUGS["Synthesize Bug[]<br/>objects for state"]
        AUDIT -->|"vulnerabilities"| SBUGS
        LIC -->|"violations"| SBUGS
    end

    BUGS --> STATE[("bugs[] in ProjectState<br/>(feeds bugfix-triage loop)")]
    SBUGS --> STATE

    style QG_IN fill:#fffde7,stroke:#f9a825,color:#000
    style SG_IN fill:#fffde7,stroke:#f9a825,color:#000
    style DETECT fill:#e65100,stroke:#bf360c,color:#fff
    style INSTALL fill:#1565c0,stroke:#0d47a1,color:#fff
    style BUILD fill:#1565c0,stroke:#0d47a1,color:#fff
    style LINT fill:#1565c0,stroke:#0d47a1,color:#fff
    style TEST fill:#1565c0,stroke:#0d47a1,color:#fff
    style BUGS fill:#c62828,stroke:#b71c1c,color:#fff
    style PASS fill:#2e7d32,stroke:#1b5e20,color:#fff
    style SECRET fill:#c62828,stroke:#b71c1c,color:#fff
    style AUDIT fill:#d84315,stroke:#bf360c,color:#fff
    style LIC fill:#6a1b9a,stroke:#4a148c,color:#fff
    style SBUGS fill:#c62828,stroke:#b71c1c,color:#fff
    style STATE fill:#f9a825,stroke:#f57f17,stroke-width:3px,color:#000
```

---

## 15. Summary

### Communication Model

The AgenticDevTeam uses a **shared-state blackboard pattern** powered by LangGraph:

| Aspect | Mechanism |
|--------|-----------|
| **Agent-to-Agent Communication** | Indirect, via shared `ProjectState`. No agent calls another directly. |
| **Data Format** | Zod schemas define strict JSON contracts. Each agent's output schema is injected into its system prompt. |
| **State Updates** | LangGraph reducers merge partial state updates (append for arrays, replace for scalars). |
| **Flow Control** | Conditional edge routers examine state fields (`phase`, `testReports`, `cancelled`, etc.) to determine the next node. |
| **Context Translation** | `context-builder.ts` summarizes raw state into budget-constrained text prompts for each agent. |
| **Parallel Execution** | Developer dispatcher fans out across git worktrees with concurrency limits and topological dependency ordering. |
| **Feedback Loops** | Bug-fix loop (QA -> bugfix-triage -> dev -> QA) and review loop (dev -> reviewer -> fix -> reviewer) are bounded by configurable iteration limits. |
| **Human Oversight** | HITL interrupts pause the graph before each phase for approve/deny/enhance decisions. |
| **Observability** | Event bus broadcasts real-time events to WebSocket clients (dashboard/CLI) without affecting agent behavior. |
| **Crash Recovery** | `FileCheckpointer` persists graph state to disk, enabling `resumeRun()` after failures. |

### The Key Insight

> **Agents never talk to each other.** They talk to the **shared state**, and the **LangGraph runtime** orchestrates which agent runs next based on the current state. The state grows monotonically through the pipeline -- each agent adds its contribution, and downstream agents read the accumulated work of all upstream agents. This is a **blackboard architecture** where the state is the blackboard, agents are knowledge sources, and the graph topology is the control strategy.

```mermaid
graph TB
    subgraph "The Blackboard Pattern"
        A1["Architect"] -->|writes| BB[("ProjectState<br/>(Blackboard)")]
        A2["Product Manager"] -->|writes| BB
        A3["DBA"] -->|writes| BB
        A4["Team Leader"] -->|writes| BB
        A5["Developers"] -->|writes| BB
        A6["QA Engineers"] -->|writes| BB
        A7["DevOps"] -->|writes| BB

        BB -->|reads| A1
        BB -->|reads| A2
        BB -->|reads| A3
        BB -->|reads| A4
        BB -->|reads| A5
        BB -->|reads| A6
        BB -->|reads| A7

        GR["Graph Router<br/>(Control Strategy)"] -->|"decides who<br/>runs next"| BB
    end

    style BB fill:#f9a825,stroke:#f57f17,stroke-width:4px,color:#000
    style GR fill:#e65100,stroke:#bf360c,stroke-width:2px,color:#fff
    style A1 fill:#1565c0,stroke:#0d47a1,color:#fff
    style A2 fill:#2e7d32,stroke:#1b5e20,color:#fff
    style A3 fill:#6a1b9a,stroke:#4a148c,color:#fff
    style A4 fill:#d84315,stroke:#bf360c,color:#fff
    style A5 fill:#f9a825,stroke:#f57f17,color:#000
    style A6 fill:#00695c,stroke:#004d40,color:#fff
    style A7 fill:#283593,stroke:#1a237e,color:#fff
```
