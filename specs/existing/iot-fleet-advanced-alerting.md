# IoT Fleet Monitoring Platform — Advanced Alerting Enhancements

This document describes enhancements to the existing IoT Fleet Monitoring Platform focused on alerting, workflows, and operator productivity.

## Background

The current platform supports basic rule-based alerts (e.g., low battery, offline devices). Operators have requested more flexible alert logic, better grouping, and improved workflows for triage and resolution.

## Objectives

- Reduce alert noise while still surfacing critical issues quickly.
- Make it easier for operators to understand the context around an alert.
- Provide lightweight workflow tools without introducing a full ITSM system.

## New Requirements

### 1. Alert Policies & Severity Levels

- Introduce **Alert Policies** as named configurations that can be reused across many devices or device groups.
- Each policy can define:
  - Name and description.
  - Target scope (all devices, by tag, by customer, by device type, etc.).
  - One or more conditions (e.g., battery < 20% for 30 minutes, temperature > 40°C for 5 consecutive readings).
  - **Severity level**: Info, Warning, Critical.
- Policies can be enabled/disabled without deleting them.

### 2. Alert Grouping & Deduplication

- Alerts triggered by the same underlying issue should be grouped into a **single incident** where possible.
  - Example: A device flapping online/offline should not create dozens of separate alerts.
- Grouping rules (conceptual):
  - Same device, same policy, within a time window → group into one incident.
- The UI should show both the incident (high-level) and the underlying raw alerts/events.

### 3. Alert Triage Workflow

- Each incident should have a simple lifecycle:
  - **Open** → **Acknowledged** → **Resolved**.
- Operators can:
  - Assign an incident to themselves or another user.
  - Add free-text comments.
  - Change severity (with an audit trail).
- When the underlying condition clears (e.g., battery back above threshold), the system can suggest resolving the incident but should not auto-resolve by default.

### 4. Notification Channels (Configurable)

- Extend notifications beyond basic email:
  - Add support for webhooks (e.g., posting JSON payloads to an external URL).
- For each policy, allow configuring:
  - Which channels to use (UI only, email, webhook).
  - Basic rate limiting (e.g., no more than one notification every N minutes per incident).

### 5. Operator Views

- New "Incidents" page with:
  - Filters by status, severity, device, policy, assignee, and time range.
  - Sorting by last update time, severity, or customer.
- Device detail view should show:
  - Open and recent incidents for that device.
  - Links from incidents back to the originating alert policy.

## Non-Functional Considerations

- The new features should reuse existing data models where reasonable, but it is acceptable to introduce new tables/collections for policies and incidents.
- The system must handle hundreds of active incidents without degrading dashboard performance.
- Audit information (who changed what and when) must be recorded for policy edits and incident state changes.

## Out of Scope

- Full ITSM integration (Jira Service Management, ServiceNow, etc.).
- On-call rotation management or pager/phone call integrations.
