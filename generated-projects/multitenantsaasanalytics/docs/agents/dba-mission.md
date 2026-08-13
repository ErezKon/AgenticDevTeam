# DBA Mission Report

**Agent**: dba  
**Generated**: 2026-08-13T08:51:56.716Z

---

## Database Engine: PostgreSQL

PostgreSQL 15 is the chosen relational engine in the tech stack and, with the TimescaleDB extension, provides efficient time‑series storage and powerful analytical queries required for the event ingestion and analytics modules while keeping ACID guarantees for tenant and user data.

## Entities (7)

- **tenant**: 4 columns
- **user**: 9 columns
- **api_key**: 8 columns
- **event**: 5 columns
- **dashboard**: 7 columns
- **chart**: 8 columns
- **share_link**: 6 columns

## ERD

```mermaid
erDiagram
    TENANT ||--o{ USER : "has"
    TENANT ||--o{ API_KEY : "has"
    TENANT ||--o{ DASHBOARD : "owns"
    TENANT ||--o{ EVENT : "generates"
    DASHBOARD ||--o{ CHART : "contains"
    DASHBOARD ||--o{ SHARE_LINK : "has"
    USER {
        UUID id PK
        UUID tenant_id FK
        VARCHAR email
        VARCHAR password_hash
        VARCHAR role
        BOOLEAN is_active
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
    TENANT {
        UUID id PK
        VARCHAR name
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
    API_KEY {
        UUID id PK
        UUID tenant_id FK
        VARCHAR key_hash
        VARCHAR name
        BOOLEAN revoked
        TIMESTAMPTZ expires_at
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
    EVENT {
        BIGSERIAL id PK
        UUID tenant_id FK
        VARCHAR event_type
        JSONB payload
        TIMESTAMPTZ created_at
    }
    DASHBOARD {
        UUID id PK
        UUID tenant_id FK
        VARCHAR name
        TEXT description
        BOOLEAN is_default
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
    CHART {
        UUID id PK
        UUID dashboard_id FK
        VARCHAR title
        VARCHAR type
        JSONB query_config
        INTEGER position
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
    SHARE_LINK {
        UUID id PK
        UUID dashboard_id FK
        VARCHAR token
        TIMESTAMPTZ expires_at
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }
```
