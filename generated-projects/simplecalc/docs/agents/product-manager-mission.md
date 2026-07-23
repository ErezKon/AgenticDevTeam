# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-07-23T08:54:06.700Z

---

## User Stories (8)

### US-001: As a user, I want a responsive calculator UI that works on mobile and desktop
- So that: I can use the calculator on any device with a consistent experience
- AC: The calculator layout adapts to viewport widths below 600px and above 600px, maintaining readable button sizes and spacing.; All calculator buttons are fully tappable on touch devices with a minimum touch target of 48x48 dp.
### US-002: As a user, I want visual feedback when I press a calculator button
- So that: I know my input was registered correctly
- AC: A button shows an active/pressed style (e.g., background darkening) while it is being clicked or tapped.; The active style reverts immediately after the pointer is released.
### US-003: As a user, I want to enter arithmetic expressions and receive correct numeric results
- So that: my calculations are accurate
- AC: The engine evaluates expressions containing +, -, *, /, parentheses, decimal numbers, and negative numbers with correct operator precedence.; A set of sample expressions (e.g., "3+4*2/(1-5)", "-2.5*(3+4)") returns the mathematically correct result.
### US-004: As a developer, I want the calculation engine to be a pure TypeScript library with no runtime dependencies
- So that: the client bundle stays minimal and the code is easy to audit
- AC: The library compiles to a single JavaScript file without importing external packages.; Type definitions are exported and usable by the React UI without additional type‑only packages.
### US-005: As a user, I want clear, user‑friendly error messages for malformed expressions
- So that: I can correct my input quickly
- AC: When the expression has unmatched parentheses, the engine returns an error object with the message "Unmatched parentheses" and the UI displays this text prominently.; Division by zero produces an error object with the message "Division by zero" and the UI shows the same message without crashing.
### US-006: As a user, I want the calculator to remain usable after an invalid input
- So that: the app never crashes or becomes unresponsive
- AC: Invalid input never throws an uncaught exception; the engine always returns either a result or a structured error object.; After an error is shown, the user can continue entering a new expression and receive a new result or error.
### US-007: As a release engineer, I want an automated CI pipeline that lints, tests, builds, and creates a Docker image
- So that: every commit can be released safely and reproducibly
- AC: GitHub Actions runs on every push, executes ESLint, runs all Jest tests, builds the React bundle, builds the NGINX Docker image, and pushes the image to GitHub Container Registry.; The pipeline fails if any linting error, test failure, or Docker build error occurs, and the failure is reported in the pull‑request status.
### US-008: As a user, I want the application to be served over HTTPS by an NGINX container
- So that: my connection to the calculator is secure
- AC: The Docker image runs NGINX that serves the compiled React assets on port 443 with a self‑signed certificate for local testing.; Accessing https://localhost (or the deployed host) loads the calculator UI without mixed‑content warnings.

## Tasks (15)

- **TASK-001** [frontend/Vite, React 18, TypeScript] Initialize React TypeScript project with Vite
- **TASK-002** [infra/ESLint, Prettier] Add ESLint and Prettier configuration for React/TS
- **TASK-003** [testing/Jest, React Testing Library, ts-jest] Set up Jest with React Testing Library
- **TASK-004** [backend/TypeScript] Create Calculator Engine library skeleton
- **TASK-005** [backend/TypeScript] Implement shunting‑yard parser and evaluator
- **TASK-006** [testing/Jest] Write unit tests for valid arithmetic expressions
- **TASK-007** [testing/Jest] Write unit tests for error handling scenarios
- **TASK-008** [frontend/React, TypeScript, CSS Modules] Build responsive calculator UI components
- **TASK-009** [frontend/React Hooks, TypeScript] Implement UI state management and engine integration
- **TASK-010** [frontend/CSS] Add visual feedback for button presses
- **TASK-011** [frontend/React, ARIA] Fine‑tune responsive layout and accessibility
- **TASK-012** [infra/Docker, NGINX] Create Dockerfile for NGINX static asset server
- **TASK-013** [infra/NGINX] Configure NGINX for HTTPS and static file serving
- **TASK-014** [infra/GitHub Actions] Implement GitHub Actions CI/CD workflow
- **TASK-015** [frontend/Sentry, React] Add optional Sentry integration for client‑side error logging
