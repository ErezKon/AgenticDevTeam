# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-08-13T09:25:02.041Z

---

## Test Plan

{
  "scope": "",
  "unit": [
    {
      "target": "src/auth/auth.service.ts",
      "description": "Validates signup creates tenant and returns JWT",
      "framework": "jest",
      "storyId": "US-001",
      "acIndex": 0,
      "moduleId": "AuthService"
    },
    {
      "target": "src/auth/auth.service.ts",
      "description": "Handles duplicate email during signup with error",
      "framework": "jest",
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "AuthService"
    },
    {
      "target": "src/auth/auth.service.ts",
      "description": "Validates login returns JWT for correct credentials",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": 0,
      "moduleId": "AuthService"
    },
    {
      "target": "src/auth/auth.service.ts",
      "description": "Returns 401 for invalid login credentials",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": 1,
      "moduleId": "AuthService"
    },
    {
      "target": "src/invitations/invitation.service.ts",
      "description": "Generates invitation token and triggers SendGrid email",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 0,
      "moduleId": "InvitationService"
    },
    {
      "target": "src/invitations/invitation.service.ts",
      "description": "Accepts invitation, creates user with role, enables login",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 1,
      "moduleId": "InvitationService"
    },
    {
      "target": "src/api-keys/api-key.service.ts",
      "description": "Creates a new API key scoped to tenant",
      "framework": "jest",
      "storyId": "US-003",
      "acIndex": 0,
      "moduleId": "ApiKeyService"
    },
    {
      "target": "src/api-keys/api-key.service.ts",
      "description": "Revokes an existing API key and marks it inactive",
      "framework": "jest",
      "storyId": "US-003",
      "acIndex": 1,
      "moduleId": "ApiKeyService"
    },
    {
      "target": "src/ingestion/ingestion.service.ts",
      "description": "Persists well‑formed event when API key is valid",
      "framework": "jest",
      "storyId": "US-005",
      "acIndex": 0,
      "moduleId": "IngestionService"
    },
    {
      "target": "src/ingestion/ingestion.service.ts",
      "description": "Rejects event when API key is invalid or revoked",
      "framework": "jest",
      "storyId": "US-005",
      "acIndex": 1,
      "moduleId": "IngestionService"
    },
    {
      "target": "src/rate-limiter/rate-limiter.service.ts",
      "description": "Returns 429 when quota exceeded",
      "framework": "jest",
      "storyId": "US-006",
      "acIndex": 0,
      "moduleId": "RateLimiterService"
    },
    {
      "target": "src/rate-limiter/rate-limiter.service.ts",
      "description": "Allows ingestion when request rate is below quota",
      "framework": "jest",
      "storyId": "US-006",
      "acIndex": 1,
      "moduleId": "RateLimiterService"
    },
    {
      "target": "src/dashboards/dashboard.service.ts",
      "description": "Returns three default dashboards with up‑to‑date charts",
      "framework": "jest",
      "storyId": "US-007",
      "acIndex": 0,
      "moduleId": "DashboardService"
    },
    {
      "target": "src/dashboards/dashboard.service.ts",
      "description": "Ensures charts are filtered by tenantId",
      "framework": "jest",
      "storyId": "US-007",
      "acIndex": 1,
      "moduleId": "DashboardService"
    },
    {
      "target": "src/queries/query.builder.ts",
      "description": "Validates query parameters and produces correct result set",
      "framework": "jest",
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "QueryBuilder"
    },
    {
      "target": "src/queries/query.builder.ts",
      "description": "Detects invalid query parameters and throws validation error",
      "framework": "jest",
      "storyId": "US-008",
      "acIndex": 1,
      "moduleId": "QueryBuilder"
    },
    {
      "target": "src/dashboards/dashboard.service.ts",
      "description": "Persists chart configuration when saved to a dashboard",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 0,
      "moduleId": "DashboardService"
    },
    {
      "target": "src/share-links/share-link.service.ts",
      "description": "Generates read‑only share link scoped to tenant",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 1,
      "moduleId": "ShareLinkService"
    },
    {
      "target": "src/health/health.controller.ts",
      "description": "Returns 200 with JSON status payload on /health",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 0,
      "moduleId": "HealthController"
    },
    {
      "target": "src/metrics/metrics.controller.ts",
      "description": "Exposes Prometheus‑compatible metrics on /metrics",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 1,
      "moduleId": "MetricsController"
    },
    {
      "target": "src/app.module.ts",
      "description": "Ensures all controllers and services are registered at startup",
      "framework": "jest",
      "storyId": "US-011",
      "acIndex": 0,
      "moduleId": "AppModule"
    }
  ],
  "integration": [
    {
      "target": "test/e2e/auth/signup.e2e-spec.ts",
      "description": "POST /auth/signup creates tenant and returns JWT for valid data",
      "framework": "jest",
      "storyId": "US-001",
      "acIndex": 0,
      "moduleId": "AuthController"
    },
    {
      "target": "test/e2e/auth/signup-duplicate.e2e-spec.ts",
      "description": "POST /auth/signup with existing email returns 400",
      "framework": "jest",
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "AuthController"
    },
    {
      "target": "test/e2e/invitations/create.e2e-spec.ts",
      "description": "POST /invitations generates token and triggers SendGrid email",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 0,
      "moduleId": "InvitationController"
    },
    {
      "target": "test/e2e/invitations/accept.e2e-spec.ts",
      "description": "POST /invitations/accept creates user with role and allows login",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 1,
      "moduleId": "InvitationController"
    },
    {
      "target": "test/e2e/api-keys/create-revoke.e2e-spec.ts",
      "description": "POST /api-keys creates scoped key; DELETE /api-keys/:id revokes it",
      "framework": "jest",
      "storyId": "US-003",
      "acIndex": -1,
      "moduleId": "ApiKeyController"
    },
    {
      "target": "test/e2e/auth/login.e2e-spec.ts",
      "description": "POST /auth/login returns JWT for valid credentials and 401 for invalid",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": -1,
      "moduleId": "AuthController"
    },
    {
      "target": "test/e2e/events/ingest-success.e2e-spec.ts",
      "description": "POST /api/events with valid payload and API key persists event and returns 201",
      "framework": "jest",
      "storyId": "US-005",
      "acIndex": 0,
      "moduleId": "EventsController"
    },
    {
      "target": "test/e2e/events/ingest-invalid-key.e2e-spec.ts",
      "description": "POST /api/events with revoked/invalid API key returns 403",
      "framework": "jest",
      "storyId": "US-005",
      "acIndex": 1,
      "moduleId": "EventsController"
    },
    {
      "target": "test/e2e/rate-limiter/quota.e2e-spec.ts",
      "description": "Exceeds per‑key quota on /api/events and receives 429; subsequent drop below quota resumes normal ingestion",
      "framework": "jest",
      "storyId": "US-006",
      "acIndex": -1,
      "moduleId": "RateLimiterMiddleware"
    },
    {
      "target": "test/e2e/dashboards/default.e2e-spec.ts",
      "description": "GET /dashboards/default returns three pre‑built dashboards with tenant‑isolated charts",
      "framework": "jest",
      "storyId": "US-007",
      "acIndex": -1,
      "moduleId": "DashboardController"
    },
    {
      "target": "test/e2e/queries/run-valid.e2e-spec.ts",
      "description": "POST /queries/run with valid parameters returns correct chart data",
      "framework": "jest",
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "QueryController"
    },
    {
      "target": "test/e2e/queries/run-invalid.e2e-spec.ts",
      "description": "POST /queries/run with invalid parameters returns validation error before execution",
      "framework": "jest",
      "storyId": "US-008",
      "acIndex": 1,
      "moduleId": "QueryController"
    },
    {
      "target": "test/e2e/dashboards/save-chart.e2e-spec.ts",
      "description": "POST /dashboards/:id/charts persists chart config and appears on dashboard",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 0,
      "moduleId": "DashboardController"
    },
    {
      "target": "test/e2e/dashboards/share-link.e2e-spec.ts",
      "description": "POST /dashboards/:id/share creates tenant‑scoped read‑only link",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 1,
      "moduleId": "ShareLinkController"
    },
    {
      "target": "test/e2e/monitoring/health.e2e-spec.ts",
      "description": "GET /health returns 200 with JSON status",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 0,
      "moduleId": "HealthController"
    },
    {
      "target": "test/e2e/monitoring/metrics.e2e-spec.ts",
      "description": "GET /metrics returns Prometheus‑compatible metrics payload",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 1,
      "moduleId": "MetricsController"
    },
    {
      "target": "test/e2e/full-flow/full-app.e2e-spec.ts",
      "description": "Full start‑up verification: all controllers/services registered, frontend routes load without error, user can login, view dashboard, run query, save chart",
      "framework": "jest",
      "storyId": "US-011",
      "acIndex": -1,
      "moduleId": "AppIntegration"
    }
  ],
  "e2e": [
    {
      "scenario": "Sign up a new tenant and receive JWT",
      "description": "User fills signup form with valid email/password, submits, sees JWT stored, and is redirected to dashboard",
      "criticalPath": true,
      "storyId": "US-001",
      "acIndex": 0,
      "moduleId": "SignupPage"
    },
    {
      "scenario": "Attempt signup with already used email shows error",
      "description": "User tries to sign up with an email that exists, UI displays 400 error message",
      "criticalPath": true,
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "SignupPage"
    },
    {
      "scenario": "Admin invites a member, member accepts invitation and logs in",
      "description": "Admin sends invitation, receives email (mocked), member clicks link, sets password, role assigned, logs in successfully",
      "criticalPath": true,
      "storyId": "US-002",
      "acIndex": -1,
      "moduleId": "InvitationFlow"
    },
    {
      "scenario": "Admin generates and revokes an API key",
      "description": "Admin creates API key via UI, sees key value, revokes it, then attempts ingestion which fails",
      "criticalPath": true,
      "storyId": "US-003",
      "acIndex": -1,
      "moduleId": "ApiKeyManagementPage"
    },
    {
      "scenario": "Member logs in and views default dashboards",
      "description": "User logs in, navigates to Dashboard page, sees three pre‑built dashboards with correct tenant data",
      "criticalPath": true,
      "storyId": "US-007",
      "acIndex": -1,
      "moduleId": "DashboardPage"
    },
    {
      "scenario": "Member builds a custom query and sees correct results",
      "description": "User opens visual query builder, selects valid parameters, runs query, chart renders with expected data",
      "criticalPath": true,
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "QueryBuilderPage"
    },
    {
      "scenario": "Invalid query parameters trigger UI validation error",
      "description": "User enters unknown event name, UI shows validation error before request is sent",
      "criticalPath": true,
      "storyId": "US-008",
      "acIndex": 1,
      "moduleId": "QueryBuilderPage"
    },
    {
      "scenario": "Save custom chart to a dashboard and verify persistence",
      "description": "After running a query, user clicks 'Save to Dashboard', selects a dashboard, returns to dashboard view and sees the new chart listed",
      "criticalPath": true,
      "storyId": "US-009",
      "acIndex": 0,
      "moduleId": "ChartSaveFlow"
    },
    {
      "scenario": "Generate a share link and access dashboard in read‑only mode",
      "description": "User creates share link for a dashboard, opens link in another browser session within same tenant, sees dashboard without edit controls",
      "criticalPath": true,
      "storyId": "US-009",
      "acIndex": 1,
      "moduleId": "ShareLinkFlow"
    },
    {
      "scenario": "Health and metrics endpoints are reachable",
      "description": "Automated Playwright request to /health returns 200 JSON; request to /metrics returns Prometheus format",
      "criticalPath": true,
      "storyId": "US-010",
      "acIndex": -1,
      "moduleId": "MonitoringEndpoints"
    },
    {
      "scenario": "Full end‑to‑end user journey",
      "description": "Login, navigate to pre‑built dashboard, run ad‑hoc query, save chart, generate share link, and verify all steps succeed without errors",
      "criticalPath": true,
      "storyId": "US-011",
      "acIndex": -1,
      "moduleId": "FullE2EFlow"
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
