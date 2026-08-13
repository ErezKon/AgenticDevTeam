# IoT Fleet Monitoring Platform

## Overview

Design and implement a cloud-based platform that monitors a fleet of connected devices (for example, delivery trucks, vending machines, or industrial sensors). Each device periodically sends telemetry data (location, status, health metrics) to the cloud. Operators use a web dashboard to see the current state of the fleet, drill into individual devices, and configure alerts.

Assume this is a **new greenfield product**.

## High-Level Goals

- Provide near real-time visibility into thousands of devices.
- Surface anomalies and alerts quickly so operators can take action.
- Offer an API so other systems (e.g., maintenance, billing) can consume device data.

## Core Use Cases

1. **Device Registration & Identity**
   - Each physical device is represented as a record in the system with:
     - Unique device ID
     - Human-readable name/label
     - Device type/model
     - Customer / owning organization
     - Optional metadata (tags, notes)
   - Operators can:
     - Create a new device record.
     - Update metadata.
     - Deactivate/retire a device.

2. **Telemetry Ingestion**
   - Devices send telemetry messages periodically (e.g., every 30–60 seconds).
   - Telemetry includes:
     - Timestamp (device and/or server)
     - GPS location (lat/lon)
     - Battery level (0–100%)
     - Connection status (online/offline/intermittent)
     - Domain-specific metrics (e.g., temperature, door-open count, etc.).
   - The system validates incoming data, stores it, and makes the latest state easily queryable.

3. **Real-Time Fleet Dashboard**
   - A web UI that shows:
     - A map with markers for each active device.
     - A table/grid view of devices with key fields (name, last-seen time, status, battery level, alerts).
   - The dashboard auto-refreshes (or uses websockets) so operators see changes within a few seconds.
   - Operators can filter devices (e.g., by customer, status, battery level, region).

4. **Device Detail View**
   - From the dashboard, an operator can click a device to view:
     - Last 24 hours of telemetry (graphs/tables).
     - Recent alerts.
     - Static info (owner, install date, firmware version if available).
   - Operators can add notes (simple text log) to a device.

5. **Alerting & Rules**
   - Operators can define simple rules like:
     - "Battery below X% for more than Y minutes."
     - "No heartbeat from device for more than N minutes."
     - "Temperature out of range for more than M readings."
   - When a rule triggers:
     - The alert is recorded and visible in the UI.
     - Optionally, send an email notification to a configured address (for now, treat email as an integration point; actual sending can be stubbed or logged).

6. **External API**
   - Provide a REST API for:
     - Listing devices and their latest status.
     - Fetching telemetry history for a device.
     - Querying open/active alerts.
   - Authentication model can be simple (e.g., API key per customer) for the first version.

## Non-Functional Requirements

- Target scale: a few thousand devices sending data once per minute.
- Ingestion should be able to handle short bursts (e.g., many devices reconnecting after a network outage).
- Dashboard should remain responsive with this data volume.
- Basic auditability: record who changed key configuration items (e.g., alert rules, device metadata).

## Out of Scope (For Now)

- Firmware update distribution.
- Complex multi-tenant billing.
- Advanced analytics or machine learning on telemetry data.
