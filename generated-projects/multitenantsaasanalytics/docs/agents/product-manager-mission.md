# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-08-13T08:51:24.691Z

---

## User Stories (18)

### US-001: As a Tenant admin, I want to sign up a new tenant with email and password
- So that: the tenant can start using the platform
- AC: POST /api/tenants returns 201 and a tenantId when provided a unique email and a valid password; The new tenant record is persisted in PostgreSQL and can be retrieved via GET /api/tenants/:tenantId
### US-002: As a Tenant user, I want to log in with email and password
- So that: I receive a JWT to authenticate subsequent requests
- AC: POST /api/auth/login with correct credentials returns 200 and a signed JWT; The JWT contains the tenantId and user role claims and can be validated by the Auth module
### US-003: As a Tenant admin, I want to invite a new user by email and assign a role
- So that: the invited user can accept the invitation and gain access
- AC: POST /api/tenants/:tenantId/invite creates an invitation token and sends a mock email response; The invited user can accept the invitation via POST /api/auth/accept-invite and is created with the assigned role
### US-004: As a Tenant admin, I want to remove a user from my tenant
- So that: the user can no longer access any resources
- AC: DELETE /api/tenants/:tenantId/users/:userId returns 204 and removes the user record; After deletion, any request using the removed user's JWT is rejected with 401
### US-005: As a Tenant admin, I want to generate an API key for my tenant
- So that: my services can ingest events without user credentials
- AC: POST /api/tenants/:tenantId/api-keys returns 201 with a newly generated secret key; The key is stored encrypted in the database and is scoped to the tenant
### US-006: As a Tenant admin, I want to revoke an existing API key
- So that: the compromised key can no longer be used for ingestion
- AC: DELETE /api/tenants/:tenantId/api-keys/:keyId returns 204 and marks the key as revoked; Subsequent ingestion attempts with the revoked key receive a 403 response
### US-007: As a External service, I want to POST events to /api/events with a valid API key
- So that: my event data is stored for analytics
- AC: POST /api/events with a valid API key and well‑formed payload returns 202; Events are persisted in the TimescaleDB hypertable and are queryable by tenantId
### US-008: As a Tenant admin, I want default dashboards to be created automatically for each new tenant
- So that: my team has immediate insight without manual setup
- AC: After tenant creation, three default dashboards (Event Volume, Active Users, Top Events) exist in the database; GET /api/tenants/:tenantId/dashboards returns these dashboards with a read‑only flag
### US-009: As a Tenant member, I want to view the pre‑built dashboards
- So that: I can quickly understand my product usage
- AC: Navigating to /dashboards displays the list of default dashboards; Each dashboard renders its charts with data from the last 7 days within 3 seconds
### US-010: As a Tenant member, I want to build ad‑hoc queries via a visual builder
- So that: I can explore custom slices of my event data
- AC: The Query Builder UI allows selection of event name, property filters, time range, and aggregation type; Submitting a query calls POST /api/analytics/query and renders the result as a chart and a data table
### US-011: As a Tenant member, I want to save a custom chart to a dashboard
- So that: I can reuse the visualization later
- AC: Clicking 'Save to Dashboard' on a chart opens a dialog to select a dashboard and persists the chart config; The saved chart appears on the chosen dashboard page after refresh
### US-012: As a Tenant member, I want to generate a read‑only share link for a dashboard
- So that: colleagues can view the dashboard without editing permissions
- AC: GET /api/dashboards/:dashboardId/share returns a short URL containing a signed token; Visiting the share URL displays the dashboard in view‑only mode and denies edit actions
### US-013: As a Site reliability engineer, I want structured JSON logs for every API request
- So that: I can aggregate and search logs in a log platform
- AC: Each incoming request is logged by pino with fields: timestamp, method, path, tenantId, userId, status; Log output is written to stdout in JSON format and can be parsed by log aggregation tools
### US-014: As a Operations engineer, I want health and readiness endpoints
- So that: orchestrators can detect when the service is up or needs a restart
- AC: GET /health returns 200 with {status:"ok"} when the server can accept traffic; GET /ready returns 200 only after successful DB and Redis connections
### US-015: As a Tenant admin, I want per‑tenant rate limiting on event ingestion
- So that: no single tenant can overload the system
- AC: Each tenant is allowed 1000 events per minute; exceeding this returns 429 Too Many Requests; Rate‑limit counters are stored in Redis and reset correctly after the time window
### US-016: As a Developer, I want a CI pipeline that lints, tests, builds and creates Docker images
- So that: code quality is enforced and artifacts are ready for deployment
- AC: GitHub Actions runs on every push and fails if eslint or jest reports errors; Successful runs produce two Docker images: api-server and frontend, tagged with the commit SHA
### US-017: As a Developer, I want a Docker Compose file that starts the full stack locally
- So that: I can develop and test end‑to‑end without manual setup
- AC: `docker compose up` starts containers for api, frontend, postgres, and redis without errors; The frontend is reachable at http://localhost:5173 and can successfully call the API
### US-999: As a User, I want all application components (auth, tenant, ingestion, analytics, dashboards, UI) to be wired together in the main application loop
- So that: the SaaS analytics platform is fully functional and interactive end‑to‑end
- AC: Starting the stack with `docker compose up` launches a working SPA that can log in, view pre‑built dashboards, run ad‑hoc queries, and save charts; All API routes are reachable, protected by JWT or API key, and return expected responses in an integrated environment

## Tasks (45)

- **TASK-001** [infra/npm, Node.js] Initialize monorepo and root package.json
- **TASK-002** [backend/TypeScript, Node.js, Express] Setup backend TypeScript project
- **TASK-003** [frontend/Vite, React 18, TypeScript] Setup frontend Vite React project
- **TASK-004** [db/Prisma, PostgreSQL] Initialize Prisma schema and generate client
- **TASK-005** [infra/Docker Compose] Create Docker Compose configuration
- **TASK-006** [infra/GitHub Actions] Configure GitHub Actions CI pipeline
- **TASK-010** [backend/Express, TypeScript] Implement tenant sign‑up endpoint
- **TASK-011** [db/Prisma] Add Tenant model to Prisma schema
- **TASK-012** [testing/Jest, supertest] Write unit tests for tenant sign‑up
- **TASK-013** [backend/Express, jsonwebtoken, bcrypt] Implement login endpoint using AuthService
- **TASK-014** [db/Prisma] Add User model to Prisma schema
- **TASK-015** [testing/Jest, supertest] Write integration test for login flow
- **TASK-016** [backend/Express, TypeScript] Implement user invitation endpoint
- **TASK-017** [frontend/React, TypeScript] Create InviteUserForm React component
- **TASK-018** [testing/Jest, React Testing Library] Write tests for invitation flow
- **TASK-019** [backend/Express, TypeScript] Implement user removal endpoint
- **TASK-020** [frontend/React, TypeScript] Create UserManagementTable component
- **TASK-021** [backend/Express, crypto] Implement API key generation endpoint
- **TASK-022** [db/Prisma] Add ApiKey model to Prisma schema
- **TASK-023** [backend/Express, TypeScript] Implement API key revocation endpoint
- **TASK-024** [backend/Express, Redis, Prisma, Joi (or Zod) for validation] Implement event ingestion controller with validation and rate limiting
- **TASK-025** [db/Prisma, TimescaleDB] Add Event model to Prisma schema with Timescale hypertable
- **TASK-026** [testing/Jest, supertest, ioredis-mock] Write unit tests for ingestion validation and rate limiting
- **TASK-027** [backend/TypeScript, Prisma] Seed default dashboards on tenant creation
- **TASK-028** [db/Prisma] Add Dashboard and Chart models to Prisma schema
- **TASK-029** [frontend/React, Recharts (or similar)] Create DashboardPage component to list and render dashboards
- **TASK-030** [backend/Express, TypeScript] Add GET /api/tenants/:tenantId/dashboards endpoint
- **TASK-031** [frontend/React, TypeScript] Enhance QueryBuilder component for full ad‑hoc query UI
- **TASK-032** [backend/TypeScript, Prisma, PostgreSQL] Implement AnalyticsService executeQuery method
- **TASK-033** [backend/Express, TypeScript] Create POST /api/analytics/query endpoint
- **TASK-034** [frontend/React, Fetch API, Recharts] Integrate QueryBuilder with analytics endpoint and render results
- **TASK-035** [backend/Express, TypeScript] Add endpoint to save chart config to a dashboard
- **TASK-036** [frontend/React, TypeScript] Create UI for adding a chart to a dashboard
- **TASK-037** [backend/Express, jsonwebtoken] Implement share‑link generation endpoint
- **TASK-038** [frontend/React, TypeScript] Create ShareLinkModal component
- **TASK-039** [backend/pino, Express] Add pino logger middleware to Express
- **TASK-040** [backend/Express, TypeScript] Create health and readiness endpoints
- **TASK-041** [backend/ioredis, Express] Implement Redis‑based per‑tenant rate limiter middleware
- **TASK-042** [infra/GitHub Actions] Create GitHub Actions workflow for CI/CD
- **TASK-043** [infra/Docker Compose] Finalize Docker Compose services and environment variables
- **TASK-060** [backend/Express, TypeScript] Wire all backend routers and middleware in server entry point
- **TASK-061** [frontend/React, React Router, Vite] Configure frontend entry point and routing
- **TASK-062** [testing/Cypress] Create end‑to‑end test suite for core user journey
- **TASK-050** [testing/Jest, React Testing Library] Write React Testing Library tests for DashboardPage
- **TASK-051** [testing/Jest, React Testing Library] Write tests for QueryBuilder component
