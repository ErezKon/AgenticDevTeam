# Senior Backend Developer Mission Report

**Agent**: senior-backend  
**Generated**: 2026-07-23T13:11:08.018Z

---

## Branch: simplecalculator/feature/task-004-setup-github-actions

## Files Changed

- **created** `.github/workflows/ci.yml` — Add GitHub Actions CI workflow to run lint, Jest unit tests, RTL component tests, and Vite build on PRs and pushes.

## Notes

Assumes the project defines npm scripts: lint, test (Jest unit + RTL component tests), and build (Vite). The workflow installs dependencies via npm ci, runs lint, runs tests, and builds the project. No existing files were present, so only the CI workflow file is added.

## Diagram

```mermaid
flowchart LR
    A[GitHub Push/PR] --> B[GitHub Actions CI]
    B --> C[Checkout code]
    B --> D[Setup Node.js]
    B --> E[Install dependencies]
    B --> F[Run lint]
    B --> G[Run Jest unit tests]
    B --> H[Run RTL component tests]
    B --> I[Run Vite build]
    I --> J[Artifact (optional)]
```
