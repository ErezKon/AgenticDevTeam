# Multi-Tenant SaaS Analytics Dashboard

## Summary

Create a multi-tenant SaaS web application that allows product teams to track key usage metrics for their own applications. Each customer (tenant) can send event data to the platform and then explore it via dashboards, charts, and simple queries.

This is a **new system** with no existing codebase.

## Target Users

- Product managers who want to understand how users engage with their product.
- Engineers who need to debug feature adoption or performance regressions.
- Executives who want high-level KPIs (DAU/MAU, retention, feature adoption).

## Tenancy & Security

- The system is **multi-tenant**:
  - Each customer account has its own set of users.
  - Data from one customer must **never** be visible to another.
- Support two roles per tenant for now:
  - **Admin** — manages users, API keys, and billing info.
  - **Member** — can view dashboards and create reports.

## Data Ingestion

- Each tenant can generate one or more **API keys**.
- Clients send events via an HTTPS REST API, for example:
  - `POST /api/events`
  - Body includes: tenant key, event name, timestamp, user ID (optional), and arbitrary properties (JSON object).
- Basic validation and rate limiting should be applied per tenant key.

## Data Model (Conceptual)

- **Event**: `{ tenantId, projectId, eventName, timestamp, userId?, properties{} }`
- **User Profile (optional)**: simple key-value profile data referenced by `userId`.
- **Dashboard**: a collection of saved charts.
- **Chart/Query**: configuration for how to slice/aggregate data.

You do **not** need to design a full relational schema; focus on conceptual entities and relationships for now.

## Core Features

1. **Tenant & User Management**
   - Tenant sign-up (simple email/password, or invite-based for now).
   - Admin can:
     - Invite/remove users.
     - Generate/revoke API keys.

2. **Pre-Built Dashboards**
   - For each project, predefine a few standard views:
     - Event volume over time (last 24 hours, 7 days, 30 days).
     - Active users (DAU/WAU/MAU based on `userId`).
     - Top events and top properties (e.g., most-used features).

3. **Ad-Hoc Exploration**
   - A simple "query builder" UI where a user can:
     - Choose an event name or set of events.
     - Filter by properties (e.g., `plan = premium`).
     - Choose a time range.
     - Choose an aggregation (count, unique users, etc.).
   - The result is shown as a chart and/or table.

4. **Sharing & Saving**
   - Users can save a chart to a dashboard.
   - Dashboards can be shared read-only with a link **inside** the tenant (no public sharing needed yet).

## Non-Functional Requirements

- Initial scale: a few million events per month spread across tenants.
- Queries for the last 7 days of data should typically complete in under a few seconds.
- The system should be deployable as a single environment (no need for full region sharding yet).

## Out of Scope (For Now)

- Complex billing, metering, and credit-card integration.
- Real-time streaming dashboards (sub-second updates).
- Row-level security beyond tenant isolation.
