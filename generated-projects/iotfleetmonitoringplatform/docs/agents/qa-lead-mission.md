# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-08-13T08:58:31.016Z

---

## Test Plan

{
  "scope": "",
  "unit": [
    {
      "target": "src/device/device.service.ts",
      "description": "creates a device record and returns the created entity",
      "framework": "jest",
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "DeviceService"
    },
    {
      "target": "src/device/device.service.ts",
      "description": "updates device metadata and returns the updated entity",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 1,
      "moduleId": "DeviceService"
    },
    {
      "target": "src/device/device.service.ts",
      "description": "deactivates a device and sets status to inactive",
      "framework": "jest",
      "storyId": "US-003",
      "acIndex": 1,
      "moduleId": "DeviceService"
    },
    {
      "target": "src/telemetry/telemetry.service.ts",
      "description": "validates a correct telemetry payload and returns true",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": 0,
      "moduleId": "TelemetryService"
    },
    {
      "target": "src/telemetry/telemetry.service.ts",
      "description": "rejects an invalid telemetry payload with a ValidationError",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": 1,
      "moduleId": "TelemetryService"
    },
    {
      "target": "src/telemetry/telemetry.service.ts",
      "description": "retrieves the latest telemetry point for a device",
      "framework": "jest",
      "storyId": "US-005",
      "acIndex": 1,
      "moduleId": "TelemetryService"
    },
    {
      "target": "src/alert/alert.service.ts",
      "description": "evaluates a telemetry point against active rules and creates an alert record when condition is met",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 0,
      "moduleId": "AlertService"
    },
    {
      "target": "src/email/email.integration.ts",
      "description": "sends a stubbed email via SendGrid and returns a success flag",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 1,
      "moduleId": "EmailIntegration"
    },
    {
      "target": "src/auth/api-key.guard.ts",
      "description": "rejects a request without a valid X-API-Key header with 401",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 0,
      "moduleId": "ApiKeyGuard"
    },
    {
      "target": "src/auth/api-key.guard.ts",
      "description": "allows a request with a valid API key to proceed",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 1,
      "moduleId": "ApiKeyGuard"
    },
    {
      "target": "src/websocket/telemetry.gateway.ts",
      "description": "broadcasts telemetry updates to connected clients within 5 seconds",
      "framework": "jest",
      "storyId": "US-006",
      "acIndex": 1,
      "moduleId": "TelemetryGateway"
    }
  ],
  "integration": [
    {
      "target": "POST /devices",
      "description": "creates a device via API and returns 201 with device payload",
      "framework": "jest",
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "DeviceController"
    },
    {
      "target": "GET /devices/:id",
      "description": "returns device details including metadata for UI display",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 0,
      "moduleId": "DeviceController"
    },
    {
      "target": "PATCH /devices/:id",
      "description": "updates device metadata and returns the updated record",
      "framework": "jest",
      "storyId": "US-002",
      "acIndex": 1,
      "moduleId": "DeviceController"
    },
    {
      "target": "POST /devices/:id/deactivate",
      "description": "marks device as inactive and returns 200",
      "framework": "jest",
      "storyId": "US-003",
      "acIndex": 0,
      "moduleId": "DeviceController"
    },
    {
      "target": "GET /devices (active filter)",
      "description": "returns only devices with status active, excluding deactivated ones",
      "framework": "jest",
      "storyId": "US-003",
      "acIndex": 1,
      "moduleId": "DeviceController"
    },
    {
      "target": "POST /telemetry",
      "description": "accepts a valid telemetry payload and returns 200 OK",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": 0,
      "moduleId": "TelemetryController"
    },
    {
      "target": "POST /telemetry (invalid payload)",
      "description": "returns 400 Bad Request with validation error details",
      "framework": "jest",
      "storyId": "US-004",
      "acIndex": 1,
      "moduleId": "TelemetryController"
    },
    {
      "target": "GET /devices/:id/latest",
      "description": "returns the most recent telemetry point for the device",
      "framework": "jest",
      "storyId": "US-005",
      "acIndex": 1,
      "moduleId": "TelemetryController"
    },
    {
      "target": "GET /devices (map markers)",
      "description": "returns list of active devices with location data for map rendering",
      "framework": "jest",
      "storyId": "US-006",
      "acIndex": 0,
      "moduleId": "DeviceController"
    },
    {
      "target": "WebSocket telemetry subscription",
      "description": "verifies that a client receives telemetry updates within 5 seconds after POST /telemetry",
      "framework": "jest",
      "storyId": "US-006",
      "acIndex": 1,
      "moduleId": "TelemetryGateway"
    },
    {
      "target": "GET /alert-rules",
      "description": "returns list of saved alert rules",
      "framework": "jest",
      "storyId": "US-008",
      "acIndex": 1,
      "moduleId": "AlertRuleController"
    },
    {
      "target": "POST /alert-rules",
      "description": "creates a new alert rule with metric, threshold, and duration",
      "framework": "jest",
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "AlertRuleController"
    },
    {
      "target": "Alert generation flow",
      "description": "sends telemetry that satisfies a rule, verifies alert record creation and email stub call",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 0,
      "moduleId": "AlertService"
    },
    {
      "target": "Email stub verification",
      "description": "confirms that EmailIntegration.sendEmail is called and logs the action",
      "framework": "jest",
      "storyId": "US-009",
      "acIndex": 1,
      "moduleId": "EmailIntegration"
    },
    {
      "target": "GET /protected/* without API key",
      "description": "receives 401 Unauthorized response",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 0,
      "moduleId": "AuthMiddleware"
    },
    {
      "target": "GET /protected/* with valid API key",
      "description": "receives 200 OK and data payload",
      "framework": "jest",
      "storyId": "US-010",
      "acIndex": 1,
      "moduleId": "AuthMiddleware"
    },
    {
      "target": "Docker Compose startup",
      "description": "executes `docker compose up -d` and checks that API, SPA, and DB containers are healthy",
      "framework": "jest",
      "storyId": "US-999",
      "acIndex": 0,
      "moduleId": "SystemHealth"
    }
  ],
  "e2e": [
    {
      "scenario": "Register a new device via UI form and verify it appears in the device list",
      "description": "fills out device ID, name, type, metadata fields, submits, and checks list entry",
      "criticalPath": true,
      "storyId": "US-001",
      "acIndex": 0,
      "moduleId": "DeviceRegistrationPage"
    },
    {
      "scenario": "Submit device registration and verify API creates record and UI updates",
      "description": "intercepts POST /devices, asserts 201 response, then checks UI list for new device",
      "criticalPath": true,
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "DeviceRegistrationPage"
    },
    {
      "scenario": "Edit device metadata and verify persistence",
      "description": "opens device detail, clicks Edit, changes fields, saves, and asserts updated values in UI and API response",
      "criticalPath": true,
      "storyId": "US-002",
      "acIndex": 0,
      "moduleId": "DeviceDetailPage"
    },
    {
      "scenario": "Save edited metadata and confirm API PATCH persists changes",
      "description": "captures PATCH /devices/:id payload, ensures 200 response, and UI reflects new metadata",
      "criticalPath": true,
      "storyId": "US-002",
      "acIndex": 1,
      "moduleId": "DeviceDetailPage"
    },
    {
      "scenario": "Deactivate a device from list and detail view",
      "description": "clicks Deactivate button, confirms status changes to Inactive, and verifies removal from active dashboards",
      "criticalPath": true,
      "storyId": "US-003",
      "acIndex": 0,
      "moduleId": "DeviceListPage"
    },
    {
      "scenario": "Verify deactivated device is excluded from real‑time map and grid",
      "description": "after deactivation, checks map markers and grid no longer show the device",
      "criticalPath": true,
      "storyId": "US-003",
      "acIndex": 1,
      "moduleId": "MapPage"
    },
    {
      "scenario": "Display latest telemetry on device detail page",
      "description": "navigates to device detail, asserts temperature/humidity values match GET /devices/:id/latest response",
      "criticalPath": true,
      "storyId": "US-005",
      "acIndex": 0,
      "moduleId": "DeviceDetailPage"
    },
    {
      "scenario": "Live map shows all active devices as markers",
      "description": "loads map page, waits for markers, asserts count equals number of active devices from API",
      "criticalPath": true,
      "storyId": "US-006",
      "acIndex": 0,
      "moduleId": "MapPage"
    },
    {
      "scenario": "Map markers update within 5 seconds after telemetry POST",
      "description": "sends telemetry via curl, then asserts marker position changes within 5 s via WebSocket updates",
      "criticalPath": true,
      "storyId": "US-006",
      "acIndex": 1,
      "moduleId": "MapPage"
    },
    {
      "scenario": "Device grid displays required columns and reacts to filters",
      "description": "checks grid headers (name, status, battery, last‑seen), applies a low‑battery filter, and verifies grid and map sync",
      "criticalPath": true,
      "storyId": "US-007",
      "acIndex": 0,
      "moduleId": "DeviceGridPage"
    },
    {
      "scenario": "Filter interaction updates both grid and map synchronously",
      "description": "applies a status filter, asserts grid rows match map markers after filter",
      "criticalPath": true,
      "storyId": "US-007",
      "acIndex": 1,
      "moduleId": "DeviceGridPage"
    },
    {
      "scenario": "Create an alert rule via UI and verify it appears in the rules list",
      "description": "fills metric, threshold, duration fields, saves, and checks rule appears with edit/delete actions",
      "criticalPath": true,
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "AlertRulePage"
    },
    {
      "scenario": "Edit and delete an existing alert rule",
      "description": "opens rule, modifies threshold, saves, then deletes and confirms removal from list",
      "criticalPath": true,
      "storyId": "US-008",
      "acIndex": 1,
      "moduleId": "AlertRulePage"
    },
    {
      "scenario": "Trigger an alert by sending telemetry that meets rule conditions",
      "description": "uses curl to post telemetry that violates a rule, then checks Alerts page for new entry and verifies email stub log",
      "criticalPath": true,
      "storyId": "US-009",
      "acIndex": 0,
      "moduleId": "AlertsPage"
    },
    {
      "scenario": "Verify email notification stub is logged when alert fires",
      "description": "after alert generation, inspects application log for email send entry",
      "criticalPath": true,
      "storyId": "US-009",
      "acIndex": 1,
      "moduleId": "AlertsPage"
    },
    {
      "scenario": "API‑key enforcement – unauthorized request shows 401",
      "description": "makes a fetch call without X‑API‑Key header and expects 401 response",
      "criticalPath": true,
      "storyId": "US-010",
      "acIndex": 0,
      "moduleId": "AuthMiddleware"
    },
    {
      "scenario": "API‑key enforcement – authorized request succeeds",
      "description": "makes a fetch call with a valid X‑API‑Key and expects 200 response and data",
      "criticalPath": true,
      "storyId": "US-010",
      "acIndex": 1,
      "moduleId": "AuthMiddleware"
    },
    {
      "scenario": "Full system wiring: start stack, register device, send telemetry, see live dashboard updates",
      "description": "runs `docker compose up`, opens UI, registers a device, posts telemetry via curl, and verifies map and grid reflect new data",
      "criticalPath": true,
      "storyId": "US-999",
      "acIndex": 1,
      "moduleId": "SystemE2E"
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
