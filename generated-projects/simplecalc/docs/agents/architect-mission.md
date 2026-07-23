# Architect Mission Report

**Agent**: architect  
**Generated**: 2026-07-23T08:53:51.351Z

---

## Architecture Style

client-side monolith with static asset server

## Components

- **Web UI** (ui): React single‑page application that renders the calculator interface, captures user input, and displays results or error messages.
- **Calculator Engine** (library): Pure JavaScript module that parses arithmetic expressions, validates syntax, evaluates using the shunting‑yard algorithm, and returns a numeric result or a descriptive error.
- **Static Asset Server** (server): Lightweight NGINX container that serves the compiled React bundle, static assets (HTML, CSS, JS) and handles HTTPS termination.

## Tech Stack

- **frontend**: React 18 with TypeScript — React offers a mature ecosystem, excellent TypeScript support, and component‑based UI that matches the simple state‑driven nature of a calculator. Vue and Svelte are viable but React's larger community and tooling (Create React App / Vite) reduce onboarding risk for most teams.
- **calculation-engine**: Custom TypeScript library (no framework) — A custom library keeps bundle size minimal, avoids pulling in heavy third‑party code, and gives full control over validation and error handling. Math.js is feature‑rich but overkill for basic arithmetic. Using eval is insecure and fails to provide graceful error messages.
- **backend/infra**: NGINX 1.25 in Docker — NGINX is a proven, low‑overhead static file server that can be containerized for consistent environments. Express adds unnecessary Node runtime overhead for a pure static site. S3+CloudFront is production‑grade but introduces extra cloud configuration for a V1 prototype.
- **containerization**: Docker — Docker is universally supported, integrates with CI pipelines, and ensures the NGINX configuration runs identically across dev, test, and prod. Podman offers similar capabilities but has less CI integration. Direct host deployment removes reproducibility.
- **testing**: Jest with React Testing Library — Jest provides fast unit testing for TypeScript and integrates tightly with React Testing Library for component tests. Mocha requires more setup for TypeScript. Cypress is excellent for E2E but adds unnecessary complexity for a calculator where unit tests cover the core logic.
- **CI/CD**: GitHub Actions — GitHub Actions runs directly in the same repository host, offers free minutes for open source, and can build Docker images, run Jest tests, and push to a container registry with minimal configuration. GitLab CI and CircleCI are comparable but add external service overhead.

## Epics

- **EPIC-001** Responsive Calculator UI: Design and implement a clean, mobile‑friendly interface with a display area, button grid for digits and operators, and visual feedback for invalid input.
- **EPIC-002** Arithmetic Expression Engine: Create a TypeScript library that parses strings containing numbers, decimal points, negative signs, parentheses, and the four basic operators, evaluates them safely, and returns results or detailed error messages.
- **EPIC-003** Input Validation & Graceful Error Handling: Detect malformed expressions (e.g., unmatched parentheses, division by zero, invalid characters) and surface user‑friendly error messages without crashing the app.
- **EPIC-004** Production Deployment Pipeline: Set up Dockerized NGINX static asset server, GitHub Actions CI to lint, test, build the React bundle, build the Docker image, and push to a container registry for deployment.

## Architecture Diagram

```mermaid
flowchart LR
    subgraph Client
        UI[Web UI (React)]
        Engine[Calculator Engine (TS Library)]
    end
    subgraph Server
        Nginx[Static Asset Server (NGINX)]
    end
    UI --> Engine
    Engine --> UI
    UI --> Nginx
    Nginx --> UI
```
