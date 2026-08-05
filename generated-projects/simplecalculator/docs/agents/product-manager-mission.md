# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-08-05T14:02:20.743Z

---

## User Stories (12)

### US-001: As a user, I want a responsive calculator layout that works on desktop and mobile
- So that: I can use it comfortably on any device
- AC: The calculator layout adjusts to screen widths: on screens >600px shows full keypad, on <600px buttons resize appropriately.; The display and keypad remain fully visible without horizontal scrolling.
### US-002: As a user, I want to interact with the calculator using keyboard keys and have proper ARIA attributes for accessibility
- So that: I can use it accessibly
- AC: All buttons have appropriate ARIA roles (button) and labels.; Keyboard input (e.g., pressing "1" key) triggers the same action as clicking the button, and pressing "Enter" evaluates the expression.
### US-003: As a user, I want to enter arithmetic expressions with parentheses, decimals, and negatives and get correct results
- So that: I can perform complex calculations
- AC: The engine correctly evaluates expressions like "3+4*2/(1-5)" to the expected result.; The engine supports decimal numbers (e.g., "0.5*2") and negative numbers (e.g., "-3+5").
### US-004: As a developer, I want the calculator engine to be a pure TypeScript module with no external runtime
- So that: the bundle size stays minimal and the logic is testable
- AC: The engine module builds to a <10KB bundle (excluding dependencies) when compiled.; The module has no runtime dependencies beyond standard JavaScript/TypeScript.
### US-005: As a user, I want to see clear error messages when I input malformed expressions or divide by zero
- So that: I understand what went wrong
- AC: When the user enters "5/0", the UI displays "Error: Division by zero".; When the user enters a malformed expression like "5++2", the UI displays "Error: Invalid syntax".
### US-006: As a user, I want the UI not to crash on any invalid input
- So that: my session remains stable
- AC: The application does not crash (no uncaught exceptions) when evaluating invalid expressions.; The UI remains functional after an error, allowing new input.
### US-007: As a developer, I want a Vite build pipeline that outputs static assets
- So that: they can be served by Nginx
- AC: Running `npm run build` produces a `dist` folder with index.html and assets ready for Nginx.; The build completes without lint or test failures.
### US-008: As a DevOps engineer, I want a Dockerfile that builds an Nginx container serving the static assets
- So that: deployment is reproducible
- AC: The Docker image builds successfully and serves the calculator at http://localhost (port 80) with correct content.; The Nginx container includes CSP header `Content-Security-Policy: default-src 'self'`.
### US-009: As a CI engineer, I want a GitHub Actions workflow that lints, tests, builds, and pushes the Docker image
- So that: CI/CD is automated
- AC: On each push, GitHub Actions runs lint, test, build, and Docker push steps, and passes.; The workflow fails if tests or coverage thresholds fail.
### US-010: As a QA engineer, I want unit tests for the Calculator Engine covering all operations and edge cases
- So that: the core logic is reliable
- AC: All core operations (+, -, *, /) have passing unit tests.; Edge cases (division by zero, large numbers, decimal precision) are covered and pass.
### US-011: As a QA engineer, I want component tests for the React UI using React Testing Library
- So that: UI behavior is verified
- AC: UI component tests verify that clicking "7", "+", "3", "=" updates display to "10".; Keyboard events produce the same result.
### US-012: As a QA engineer, I want coverage thresholds enforced in CI
- So that: code quality is maintained
- AC: CI fails if overall test coverage drops below 80%.; Coverage report is generated and uploaded as an artifact.

## Tasks (29)

- **TASK-001** [infra/Vite] Initialize Vite React TypeScript project
- **TASK-002** [infra/npm] Install core and dev dependencies
- **TASK-003** [infra/ESLint, Prettier] Configure ESLint and Prettier for TypeScript React
- **TASK-004** [testing/Jest, React Testing Library] Set up Jest with React Testing Library
- **TASK-005** [infra/Docker] Create Dockerfile for Nginx static server
- **TASK-006** [infra/GitHub Actions] Create GitHub Actions CI/CD workflow
- **TASK-007** [frontend/React, TypeScript, CSS Modules] Implement responsive CalculatorLayout component
- **TASK-008** [frontend/React, TypeScript, CSS] Implement Display component
- **TASK-009** [frontend/React, TypeScript, CSS] Implement Keypad component with responsive buttons
- **TASK-010** [frontend/React] Add ARIA roles and labels to calculator buttons
- **TASK-011** [frontend/React] Implement keyboard navigation for keypad
- **TASK-012** [frontend/React] Add global keyboard event listener
- **TASK-013** [frontend/CSS] Implement focus ring styling for accessibility
- **TASK-014** [backend/TypeScript] Create parser module using shunting‑yard algorithm
- **TASK-015** [backend/TypeScript] Create evaluator module for RPN
- **TASK-016** [backend/TypeScript] Export evaluateExpression API
- **TASK-017** [backend/TypeScript] Configure tsconfig for minimal ES module output
- **TASK-018** [backend/TypeScript] Add descriptive error objects in engine
- **TASK-019** [frontend/React] Display engine errors in UI
- **TASK-020** [frontend/React] Guard UI against uncaught engine exceptions
- **TASK-021** [infra/Vite] Configure Vite production build settings
- **TASK-022** [testing/GitHub Actions] Verify build output in CI
- **TASK-023** [infra/Docker] Write Dockerfile for Nginx static serving
- **TASK-024** [infra/Nginx] Create nginx.conf with security headers
- **TASK-025** [infra/GitHub Actions] Implement GitHub Actions CI workflow
- **TASK-026** [testing/Jest] Add coverage threshold check in CI
- **TASK-027** [testing/Jest] Write unit tests for Calculator Engine
- **TASK-028** [testing/React Testing Library, Jest] Write React component tests with RTL
- **TASK-029** [testing/Jest] Configure Jest coverage thresholds
