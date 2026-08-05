# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-08-05T19:41:57.373Z

---

## User Stories (6)

### US-001: As a Developer, I want to add scientific operation functions to the Calculator Engine
- So that: users can perform advanced calculations
- AC: The engine exposes methods for sqrt, pow, log, ln, sin, cos, tan, factorial, constants pi/e, abs, radToDeg, degToRad, and percent, each returning correct numeric results.; The expression parser recognizes the symbols √, ^, log, ln, sin, cos, tan, !, π, e, |x|, rad, deg, % and evaluates them with correct precedence and parentheses.; All existing basic operations (addition, subtraction, multiplication, division) continue to work unchanged.
### US-002: As a User, I want the calculator to handle parentheses, decimals, and negative numbers in scientific expressions
- So that: I can enter complex formulas accurately
- AC: Expressions containing nested parentheses evaluate to the correct result.; Decimal numbers and negative numbers are parsed and computed with proper precision.; No regression is observed on previously supported basic calculations.
### US-003: As a User, I want a scientific keypad with grouped sections (Basic, Scientific, Additional) displaying symbols
- So that: I can easily find and use the required operation
- AC: The UI renders three distinct keypad groups with the correct symbols for each operation.; Clicking any button sends the appropriate symbol to the Calculator Engine and updates the display accordingly.; The keypad layout is responsive and remains usable on both mobile and desktop viewports.
### US-004: As a User, I want tooltips showing operation names when hovering over button symbols
- So that: I understand the meaning of each symbol
- AC: Hovering any calculator button displays a tooltip with the correct operation name (e.g., "Square Root" for √).; Tooltips are accessible (ARIA‑labelled) and disappear when the mouse leaves the button.; The addition of tooltips does not introduce visual regressions or layout shifts.
### US-005: As a Developer, I want Jest unit tests for all new engine functions
- So that: the correctness of scientific calculations is automatically verified
- AC: A test suite exists that covers each new operation with typical, edge‑case, and error inputs.; Engine test coverage is at least 90% after adding the new tests.; All tests run locally with `npm test` and pass without failures.
### US-006: As a Developer, I want the GitHub Actions workflow updated to run lint, tests, build, and Docker image creation
- So that: the CI/CD pipeline validates every change before deployment
- AC: The workflow triggers on push and pull‑request events to the main branch.; Steps include npm install, ESLint linting, Jest test execution, Vite production build, Docker image build, and optional image push.; The workflow fails if any step (lint, test, build) fails, preventing faulty code from being deployed.

## Tasks (13)

- **TASK-001** [backend/TypeScript] Implement scientific operation methods in Calculator Engine
- **TASK-002** [backend/TypeScript] Extend expression parser to recognize new symbols
- **TASK-003** [testing/Jest] Add Jest unit tests for scientific engine functions
- **TASK-004** [frontend/React 18 with TypeScript] Add scientific and additional button groups to Keypad component
- **TASK-005** [frontend/React 18 with TypeScript] Update Button component to accept tooltip data
- **TASK-006** [frontend/tippy.js (React wrapper) with TypeScript] Create TooltipButton component using tippy.js
- **TASK-007** [frontend/React 18 with TypeScript] Integrate TooltipButton into Keypad rendering
- **TASK-008** [frontend/CSS (PostCSS) ] Add responsive CSS for keypad layout
- **TASK-009** [testing/Jest with React Testing Library] Add Jest tests for TooltipButton component
- **TASK-010** [infra/GitHub Actions] Create GitHub Actions CI workflow
- **TASK-011** [infra/Docker] Update Dockerfile to copy latest build output
- **TASK-012** [frontend/Vite] Adjust Vite configuration for any new static assets
- **TASK-013** [infra/ESLint] Add ESLint lint script to package.json
