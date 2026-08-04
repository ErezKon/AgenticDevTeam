# Architect Mission Report

**Agent**: architect  
**Generated**: 2026-08-04T12:04:27.996Z

---

## Architecture Style

client-side monolith (single-page application)

## Components

- **UI** (ui): React single‑page application that captures user input, displays results, and shows validation/error messages.
- **Expression Evaluator** (library): Pure TypeScript module that parses arithmetic expressions (including parentheses, decimals, negatives) and computes the result.
- **Static Server** (service): Node.js Express server that serves the compiled SPA assets and provides a simple health‑check endpoint.

## Tech Stack

- **frontend**: React with TypeScript — React offers a mature ecosystem, strong community support, and excellent TypeScript integration, which speeds development of a dynamic SPA. Vue is comparable but has a smaller pool of developers in many teams, and Svelte, while lightweight, lacks the same level of tooling for large‑scale TS projects.
- **backend**: Node.js with Express — Express provides a minimal Node runtime that can serve static files and a health‑check endpoint with virtually no configuration, keeping the deployment model simple. Nginx is powerful but adds operational overhead for a single static site, and S3/CloudFront introduces external cloud services that may be unnecessary for an MVP.
- **database**: None — The calculator is a stateless computation engine; no persistent data is required, so a database would add needless complexity.
- **infra**: Docker (single‑container) — Docker guarantees environment parity across development, CI, and production while remaining lightweight for a single‑container app. Direct host deployment works but loses reproducibility, and serverless static hosting is an option for later but adds a separate CI/CD workflow.
- **auth**: None — The calculator does not require user accounts or protected resources, so authentication would be unnecessary overhead.
- **messaging**: None — All processing is synchronous and in‑process; a message broker would add complexity without any benefit.
- **testing**: Jest + React Testing Library — Jest integrates tightly with TypeScript and provides fast unit testing. React Testing Library encourages testing from the user’s perspective, ideal for UI validation. Mocha requires additional configuration, and Cypress is great for e2e but overkill for core arithmetic logic.
- **ci/cd**: GitHub Actions — GitHub Actions runs directly in the same repository host, offers free minutes for open‑source, and can build Docker images, run tests, and push to a container registry with minimal setup. GitLab CI would require a separate GitLab instance, and CircleCI adds another service to maintain.

## Epics

- **EPIC-001** Build User Interface: Create a responsive React SPA with an input field, result display, and clear error messaging.
- **EPIC-002** Implement Expression Evaluator: Develop a TypeScript module that parses arithmetic strings (supporting +, -, *, /, parentheses, decimals, negatives) and returns the computed value.
- **EPIC-003** Input Validation & Graceful Error Handling: Detect malformed expressions, division by zero, and other invalid inputs; surface clear error messages without crashing the app.
- **EPIC-004** Responsive Design & Accessibility: Ensure the calculator works on desktop and mobile, follows WCAG contrast guidelines, and is keyboard‑navigable.
- **EPIC-005** Containerisation & Deployment Pipeline: Dockerise the static server, set up GitHub Actions to build the image, run tests, and push to a container registry for deployment.
- **EPIC-006** Testing Strategy & CI Integration: Write unit tests for the evaluator, component tests for the UI, and integrate them into the CI pipeline.

## Architecture Diagram

```mermaid
graph TD
    Browser[Browser] --> UI[UI (React SPA)]
    UI --> Evaluator[Expression Evaluator (TS)]
    Evaluator --> UI
    UI --> StaticServer[Static Server (Node/Express)]
```
