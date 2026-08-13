# Architect Mission Report

**Agent**: architect  
**Generated**: 2026-08-13T01:35:38.543Z

---

## Architecture Style

modular monolith (single backend service with clear internal modules) + SPA frontend

## Components

- **Frontend SPA** (ui): React single‑page application that provides dashboards, chart builder, and tenant management UI.
- **Backend API** (service): NestJS HTTP API that authenticates requests, routes to ingestion, query, dashboard, and user management modules.
- **Auth Service** (service): Issues and validates JWTs, enforces tenant isolation, and provides role‑based access control.
- **API Key Service** (service): Generates, revokes and validates per‑tenant API keys used for event ingestion.
- **Rate Limiter** (service): Enforces per‑API‑key request quotas (token‑bucket) to protect ingestion endpoint.
- **Ingestion Service** (service): Validates incoming event payloads, applies rate limiting, and persists events.
- **Query Service** (service): Executes ad‑hoc aggregation queries over stored events and returns chart data.
- **Dashboard Service** (service): Manages saved dashboards, charts, and sharing links within a tenant.
- **Database** (database): PostgreSQL with TimescaleDB extension stores tenant metadata, user accounts, API keys, and time‑series events.

## Tech Stack

- **frontend**: React + Vite (TypeScript) — React has the largest ecosystem, component model matches dashboard UI, Vite gives fast dev server and simple build. Angular adds unnecessary ceremony for a small SPA; Svelte is great but has a smaller talent pool.
- **backend**: NestJS (Node.js, TypeScript) — NestJS provides a modular architecture, built‑in DI, and easy integration with TypeORM/Prisma, which aligns with the modular‑monolith approach. Express would require manual wiring; Fastify is performant but lacks the opinionated module system that speeds up multi‑team development.
- **database**: PostgreSQL 15 with TimescaleDB extension — PostgreSQL is mature, ACID‑compliant for user/tenant metadata, and TimescaleDB adds efficient time‑series storage and hypertable partitioning for event data. ClickHouse is faster for analytics but adds operational complexity; MongoDB lacks strong relational guarantees needed for tenant isolation.
- **infra**: Docker Compose (single‑environment) — Docker Compose gives reproducible local/dev environments and simple single‑node production deployment, matching the modest initial scale. Kubernetes is overkill now; plain VMs lose the container‑level parity.
- **auth**: JWT + Passport‑JWT (NestJS strategy) — Self‑contained JWT fits the SaaS model, avoids third‑party cost, and integrates directly with NestJS. Auth0/Firebase add external dependency and recurring fees, unnecessary for MVP.
- **messaging**: None (synchronous HTTP) — Current requirements are simple request/response; adding a broker would add operational overhead without clear benefit.
- **caching**: None (in‑process rate limiter) — Single‑instance deployment means an in‑process limiter suffices. Redis would be introduced only when scaling to multiple API nodes.
- **testing**: Jest (backend) + Vitest (frontend) — Jest is the de‑facto standard for Node/TS testing; Vitest offers Vite‑native fast unit tests for React components. Mocha requires more configuration; Cypress is great for e2e but not needed for unit coverage now.
- **ci/cd**: GitHub Actions — Repository is hosted on GitHub; Actions integrates natively, supports Docker builds, and is free for public/open‑source. GitLab CI would require migration; CircleCI adds external service complexity.

## Epics

- **EPIC-001** Tenant & User Management: Implement tenant sign‑up, email‑based login, role‑based user invitations, and admin UI for managing users and API keys.
- **EPIC-002** Event Ingestion Pipeline: Expose a secure `/api/events` endpoint, validate payloads, enforce per‑key rate limits, and persist events to TimescaleDB.
- **EPIC-003** Pre‑Built Dashboards: Provide out‑of‑the‑box dashboards (event volume, active users, top events) for each project, with read‑only sharing links inside the tenant.
- **EPIC-004** Ad‑Hoc Query Builder: Allow users to construct custom queries (filter by event name, properties, time range, aggregation) and render results as charts or tables.
- **EPIC-005** Dashboard Saving & Sharing: Enable users to save custom charts to a dashboard and generate tenant‑scoped read‑only share links.
- **EPIC-006** Observability & Monitoring: Add structured logging, health‑check endpoint, and basic Prometheus metrics for API latency and ingestion rate.

## Architecture Diagram

```mermaid
graph LR
    subgraph Frontend
        FE[React SPA]
    end
    subgraph Backend
        API["Backend API (NestJS)"]
        AUTH[Auth Service]
        KEY[API Key Service]
        RL[Rate Limiter]
        ING[Ingestion Service]
        QRY[Query Service]
        DASH[Dashboard Service]
    end
    subgraph DB[Database]
        PG[PostgreSQL + TimescaleDB]
    end
    FE -->|HTTPS (JWT)| API
    API --> AUTH
    API --> KEY
    API --> ING
    API --> QRY
    API --> DASH
    ING --> RL
    ING --> PG
    QRY --> PG
    DASH --> PG
    AUTH --> PG
    KEY --> PG
    style FE fill:#f9f,stroke:#333,stroke-width:2px
    style API fill:#bbf,stroke:#333,stroke-width:2px
    style PG fill:#dfd,stroke:#333,stroke-width:2px
```
