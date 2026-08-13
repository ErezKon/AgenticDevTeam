# System-Wide Observability & Telemetry — Cross-Cutting Enhancement

This spec is for an **existing multi-service application** (web frontends, back-end APIs, and background workers). The goal is to add consistent observability across all components so operators and developers can understand system behavior, troubleshoot issues, and track SLIs/SLOs.

## Goals

- Standardize logging, metrics, and tracing across all services.
- Make it easy to answer basic questions such as:
  - "What is the error rate for API X?"
  - "Why was this user request slow?"
  - "Which downstream dependency is causing the most latency?"
- Keep the initial implementation simple enough that small teams can maintain it.

## Scope

Applies to:
- All public-facing HTTP APIs.
- Backend workers / job processors.
- Shared libraries used across services (for example, database wrappers, HTTP clients).

## Requirements

### 1. Structured Logging

- All services should use **structured, machine-parseable logs** (e.g., JSON).
- Every log event should include at minimum:
  - Timestamp
  - Service name
  - Environment (dev/stage/prod)
  - Log level (DEBUG/INFO/WARN/ERROR)
  - Correlation/trace ID (if available)
- HTTP request logs should additionally include:
  - HTTP method, path, status code
  - Latency
  - Caller identity if known (user ID, API key, etc.)

### 2. Metrics

- Define a minimal **core metrics vocabulary** shared across services, for example:
  - `http_request_duration_seconds` (histogram)
  - `http_requests_total` (counter by status code, method, and route)
  - `background_job_duration_seconds` (histogram by job type)
  - `background_jobs_failed_total` (counter by job type)
- Services should expose metrics via an HTTP endpoint suitable for scraping (e.g., `/metrics`).

### 3. Distributed Tracing

- Introduce basic distributed tracing:
  - Assign a trace ID at the edge (API gateway or first public-facing service).
  - Propagate trace context through HTTP and message queues.
- At minimum, capture spans for:
  - Incoming HTTP requests.
  - Outgoing HTTP calls between services.
  - Database queries longer than a configurable threshold.

### 4. Dashboards & Alerts (High-Level)

- Create starter dashboards for:
  - API latency and error rates per service.
  - Background job throughput and failures.
- Define a small number of **high-signal alerts** (for example):
  - Error rate > X% for Y minutes on a critical endpoint.
  - P95 latency above threshold for a sustained period.

### 5. Developer Experience

- Provide simple, documented helpers or libraries so that developers can:
  - Log with consistent fields.
  - Emit metrics with minimal boilerplate.
  - Start and propagate traces.
- Local development should support viewing logs and traces without requiring access to production systems.

## Non-Goals

- Full APM feature parity with commercial tools.
- Business analytics and product metrics (those belong in a separate analytics stack).
