# DBA Mission Report

**Agent**: dba  
**Generated**: 2026-08-13T01:22:41.038Z

---

## Database Engine: PostgreSQL 15 with TimescaleDB extension

PostgreSQL provides strong relational guarantees needed for device metadata, audit logs and alert rule management. TimescaleDB adds efficient time‑series storage and query capabilities for high‑write telemetry ingestion while staying within a single database instance, simplifying deployment and transactions across entities.

## Entities (7)

- **customers**: 4 columns
- **api_keys**: 7 columns
- **devices**: 11 columns
- **telemetry**: 6 columns
- **alert_rules**: 11 columns
- **alerts**: 9 columns
- **audit_logs**: 8 columns

## ERD

```mermaid
erDiagram
    customers ||--o{ api_keys : has
    customers ||--o{ devices : owns
    devices ||--o{ telemetry : records
    customers ||--o{ alert_rules : defines
    alert_rules ||--o{ alerts : generates
    devices ||--o{ alerts : receives
    api_keys ||--o{ audit_logs : "records action"
    
    customers {
        uuid id PK
        text name
        timestamptz created_at
        timestamptz updated_at
    }
    api_keys {
        uuid id PK
        uuid customer_id FK
        text key UNIQUE
        timestamptz expires_at
        boolean revoked
        timestamptz created_at
        timestamptz updated_at
    }
    devices {
        uuid id PK
        uuid customer_id FK
        text name
        text serial_number UNIQUE
        text model
        text firmware_version
        text status
        jsonb metadata
        timestamptz deactivated_at
        timestamptz created_at
        timestamptz updated_at
    }
    telemetry {
        uuid device_id FK
        timestamptz time PK
        numeric temperature
        numeric humidity
        jsonb payload
        timestamptz created_at
    }
    alert_rules {
        uuid id PK
        uuid customer_id FK
        text name
        text description
        text metric
        text operator
        numeric threshold
        jsonb condition
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }
    alerts {
        uuid id PK
        uuid rule_id FK
        uuid device_id FK
        timestamptz triggered_at
        text severity
        text message
        timestamptz resolved_at
        timestamptz created_at
        timestamptz updated_at
    }
    audit_logs {
        bigserial id PK
        text entity_type
        uuid entity_id
        text action
        uuid performed_by_api_key_id FK
        timestamptz performed_at
        jsonb details
        timestamptz created_at
    }
```
