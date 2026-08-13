# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-08-13T01:36:28.430Z

---

## User Stories (11)

### US-001: As a Admin, I want to sign up a new tenant with email and password
- So that: the tenant can start using the platform
- AC: Given a valid email and password, when I call the signup endpoint, then a new tenant record is created and a JWT is returned; When the signup request contains an already used email, then the API responds with a 400 error and an appropriate message
### US-002: As a Admin, I want to invite members via email and assign them a role
- So that: they can access the tenant's dashboards
- AC: When I send an invitation to a valid email, then an invitation token is generated and an email is sent via SendGrid; When the invited user clicks the invitation link and sets a password, then a user record with the specified role is created and can log in
### US-003: As a Admin, I want to generate and revoke API keys for my tenant
- So that: event producers can securely ingest data
- AC: When I request a new API key, then a key scoped to my tenant is created and returned; When I revoke an existing API key, then the key is marked inactive and subsequent ingestion requests using it are rejected
### US-004: As a Member, I want to log in with my email and password
- So that: I can access dashboards and query builder
- AC: Given valid credentials, when I call the login endpoint, then I receive a JWT that can be used for authenticated requests; Given invalid credentials, when I call the login endpoint, then I receive a 401 Unauthorized response
### US-005: As a Event Producer, I want to POST events to /api/events using my API key
- So that: my product usage data is stored for analysis
- AC: When I send a well‑formed event payload with a valid API key, then the event is persisted in TimescaleDB and the API returns 201 Created; When I send an event with an invalid or revoked API key, then the API returns 403 Forbidden
### US-006: As a System, I want to enforce per‑API‑key rate limits on the ingestion endpoint
- So that: no tenant can overload the service
- AC: When an API key exceeds its configured quota, then further requests within the time window receive a 429 Too Many Requests response; When the request rate falls below the quota, then ingestion proceeds normally
### US-007: As a Member, I want to view pre‑built dashboards for event volume, active users, and top events
- So that: I get quick insights without building queries
- AC: When I navigate to the Dashboard page, then the three default dashboards are displayed with up‑to‑date charts; Each chart respects the tenant’s data isolation and shows only events belonging to my tenant
### US-008: As a Member, I want to construct custom queries via a visual query builder
- So that: I can explore my event data in any dimension I need
- AC: Given a set of query parameters (event name, property filters, time range, aggregation), when I run the query, then a chart or table with the correct results is rendered; When I provide invalid query parameters (e.g., unknown event name), then the UI shows a validation error before sending the request
### US-009: As a Member, I want to save custom charts to a dashboard and generate read‑only share links
- So that: my team can reuse and share insights safely
- AC: When I click “Save to Dashboard” on a chart, then the chart configuration is persisted and appears on the selected dashboard; When I generate a share link for a dashboard, then anyone with the link inside the same tenant can view the dashboard in read‑only mode
### US-010: As a Operator, I want structured logs, a health‑check endpoint, and Prometheus metrics
- So that: I can monitor the service’s health and performance
- AC: When I query /health, then the endpoint returns 200 OK with a JSON status payload; When I scrape /metrics, then I receive Prometheus‑compatible metrics for request latency and ingestion rate
### US-011: As a User, I want all components (auth, API keys, ingestion, query, dashboards, UI) wired together in the main application
- So that: the SaaS product is fully functional end‑to‑end
- AC: When the application starts, the backend registers all controllers and services and the frontend routing loads the login, dashboard, and query pages without errors; A logged‑in user can navigate from login to a pre‑built dashboard, run an ad‑hoc query, save the chart, and see it appear on a custom dashboard

## Tasks (37)

- **TASK-001** [infra/npm, TypeScript, Yarn workspaces] Project scaffolding: initialize monorepo with backend and frontend
- **TASK-002** [infra/Docker Compose] Docker Compose setup
- **TASK-003** [infra/GitHub Actions] CI/CD pipeline configuration
- **TASK-004** [backend/NestJS, TypeORM, bcrypt, jsonwebtoken] AuthService: tenant sign‑up and login logic
- **TASK-005** [backend/NestJS] AuthController: expose /auth/signup and /auth/login endpoints
- **TASK-006** [testing/Jest] AuthService unit tests
- **TASK-007** [backend/NestJS, @sendgrid/mail] User invitation endpoint
- **TASK-008** [testing/Jest] Invitation flow unit tests
- **TASK-009** [backend/NestJS, TypeORM, uuid] ApiKeyService: generate, list, revoke API keys
- **TASK-010** [backend/NestJS] ApiKeyController: CRUD endpoints for API keys
- **TASK-011** [testing/Jest] ApiKeyService unit tests
- **TASK-012** [backend/NestJS] RateLimiter service implementation
- **TASK-013** [testing/Jest] RateLimiter unit tests
- **TASK-014** [backend/NestJS, class-validator, TypeORM] IngestionController: POST /api/events endpoint
- **TASK-015** [backend/TypeORM, PostgreSQL, TimescaleDB] Event entity and TimescaleDB hypertable setup
- **TASK-016** [testing/Jest, supertest] Ingestion endpoint integration tests
- **TASK-017** [backend/NestJS, TypeORM, raw SQL] QueryService: ad‑hoc aggregation logic
- **TASK-018** [backend/NestJS] QueryController: POST /api/query endpoint
- **TASK-019** [testing/Jest] QueryService unit tests
- **TASK-020** [backend/NestJS, TypeORM, uuid] DashboardService: CRUD and share link generation
- **TASK-021** [backend/NestJS] DashboardController: endpoints for dashboards and charts
- **TASK-022** [testing/Jest] DashboardService unit tests
- **TASK-023** [frontend/Vite, React, TypeScript] Initialize React SPA with Vite and TypeScript
- **TASK-024** [frontend/React, axios, React Router] Login and signup pages
- **TASK-025** [frontend/React, axios] Admin user management UI
- **TASK-026** [frontend/React, axios] API key management UI
- **TASK-027** [frontend/React, axios] DashboardPage: render pre‑built dashboards
- **TASK-028** [frontend/React, axios] QueryBuilder UI enhancements
- **TASK-029** [frontend/React, axios] Save chart to dashboard from QueryBuilder
- **TASK-030** [testing/Vitest, @testing-library/react] Chart component unit tests
- **TASK-031** [testing/Vitest, @testing-library/react] QueryBuilder component tests
- **TASK-032** [testing/Cypress] End‑to‑end tests for login and dashboard flow
- **TASK-033** [backend/NestJS] Backend main.ts: import and register all modules
- **TASK-034** [frontend/React Router v6] Frontend entry: configure routing for all pages
- **TASK-035** [backend/NestJS Terminus] Health‑check endpoint
- **TASK-036** [backend/Winston, nest-winston] Structured logging with Winston
- **TASK-037** [backend/prom-client, NestJS] Prometheus metrics exporter
