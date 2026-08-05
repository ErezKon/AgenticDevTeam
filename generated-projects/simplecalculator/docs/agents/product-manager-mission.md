# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-08-05T18:31:41.730Z

---

## User Stories (9)

### US-001: As a developer, I want the Calculator Engine to recognize scientific function tokens in expressions
- So that: users can perform advanced calculations
- AC: The engine parses tokens for sqrt, pow, log, ln, sin, cos, tan, factorial, pi, e, abs, rad2deg, deg2rad, and percent.; Parsed scientific tokens are delegated to Math Utils and the engine returns the correct numeric result for each supported function.
### US-002: As a user, I want the calculator to evaluate scientific expressions correctly
- So that: I can trust the results
- AC: Expression "sqrt(9)" returns 3.; Expression "sin(pi/2)" returns 1 (within a tolerance of 0.0001).; Expression "50%" returns 0.5.
### US-003: As a user, I want scientific operation buttons grouped and displayed with symbols
- So that: I can find functions quickly
- AC: UI shows three sections (Basic, Scientific, Additional) using MUI Grid.; Each scientific button displays the correct symbol (e.g., "√", "x^y", "log", "ln", "sin", etc.).
### US-004: As a user, I want tooltips on scientific buttons that show the full operation name
- So that: I understand each symbol
- AC: Hovering over the "√" button shows a tooltip with text "Square root".; Tooltips are implemented with MUI Tooltip and are accessible via ARIA attributes.
### US-005: As a developer, I want a thin wrapper around mathjs exposing only needed functions
- So that: the Calculator Engine has a stable, limited API
- AC: MathUtils module exports functions: sqrt, pow, log, ln, sin, cos, tan, factorial, pi, e, abs, rad2deg, deg2rad, percent.; No other mathjs internals are exported from MathUtils.
### US-006: As a developer, I want the Calculator Engine to call MathUtils for scientific functions
- So that: calculations are accurate and maintainable
- AC: Engine invokes the corresponding MathUtils function for each scientific token.; Unit tests mocking MathUtils verify that the engine calls the correct wrapper function for a given expression.
### US-007: As a developer, I want CI to install new dependencies, lint, run tests, and generate coverage reports
- So that: code quality is continuously verified
- AC: GitHub Actions workflow runs npm ci, eslint linting, jest tests with coverage flag, and uploads the coverage artifact.; The build step succeeds with MUI and mathjs present in node_modules.
### US-008: As a DevOps engineer, I want Dockerfile to build Vite assets and serve them via Nginx
- So that: the container includes the updated application and runs without errors
- AC: Dockerfile builds production assets with Vite, copies them to Nginx's html directory, and creates a runnable image.; Running the container serves the updated calculator UI at http://localhost.
### US-009: As a user with a screen reader, I want each button to have appropriate ARIA labels and tooltip associations
- So that: I can operate the calculator using assistive technology
- AC: Every button includes an aria-label attribute matching the full operation name.; Tooltips are linked to their buttons via aria-describedby.

## Tasks (17)

- **TASK-001** [backend/TypeScript] Add scientific token parsing to Calculator Engine
- **TASK-002** [backend/TypeScript] Delegate scientific functions to MathUtils
- **TASK-003** [testing/Jest] Write unit tests for scientific operations in Calculator Engine
- **TASK-004** [backend/TypeScript] Create MathUtils wrapper module
- **TASK-005** [testing/Jest] Add unit tests for MathUtils functions
- **TASK-006** [frontend/React, Material UI] Add scientific button group layout using MUI Grid
- **TASK-007** [frontend/React, Material UI] Add MUI Button components for scientific symbols
- **TASK-008** [frontend/React, Material UI] Wrap scientific buttons with MUI Tooltip
- **TASK-009** [frontend/React, Material UI] Add ARIA labels and aria-describedby to buttons
- **TASK-010** [testing/React Testing Library, Jest] Write component tests for tooltip visibility
- **TASK-011** [infra/npm] Add mathjs dependency to package.json
- **TASK-012** [backend/TypeScript] Update imports to use MathUtils
- **TASK-013** [infra/GitHub Actions] Extend GitHub Actions workflow for lint, test, and coverage
- **TASK-014** [testing/Jest] Configure Jest to generate coverage reports
- **TASK-015** [infra/Docker] Update Dockerfile to build Vite assets and copy to Nginx
- **TASK-016** [infra/Nginx] Add or adjust Nginx configuration for static serving
- **TASK-017** [testing/React Testing Library, Jest] Write accessibility tests for ARIA labels
