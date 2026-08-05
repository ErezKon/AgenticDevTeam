# Team Leader Mission Report

**Agent**: team-leader  
**Generated**: 2026-08-05T14:03:00.678Z

---

## Assignments (29)

### ASSIGN-001 -> principal-frontend [principal]
- Priority: critical | Complexity: moderate
- Run `npm create vite@latest` with React + TypeScript template, commit the generated files, and push the initial Git repository.
### ASSIGN-002 -> principal-frontend [principal]
- Priority: high | Complexity: simple
- Add core dependencies (react, react-dom, typescript) and dev dependencies (jest, @testing-library/react, eslint, prettier, type definitions) via npm.
### ASSIGN-003 -> principal-frontend [principal]
- Priority: high | Complexity: simple
- Create `.eslintrc.js` and `.prettierrc` with recommended TypeScript React rules and configure lint‑staged to run on commit.
### ASSIGN-004 -> principal-backend [principal]
- Priority: high | Complexity: simple
- Add `jest.config.ts`, configure `ts-jest`, set up the testing environment, and add a basic test script in `package.json`.
### ASSIGN-005 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Write a multi‑stage Dockerfile: first stage runs `npm run build`, second stage copies `dist` into `/usr/share/nginx/html` and adds a custom `nginx.conf`.
### ASSIGN-006 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Create `.github/workflows/ci.yml` that checks out code, sets up Node, installs deps, runs lint, test, builds the app, builds the Docker image and pushes it.
### ASSIGN-007 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Create `CalculatorLayout.tsx` using CSS Grid/Flexbox with media queries to adapt keypad size for screens >600px and <600px.
### ASSIGN-008 -> junior-react [junior]
- Priority: high | Complexity: simple
- Create `Display.tsx` that shows the current expression or result, uses responsive typography, and handles overflow.
### ASSIGN-009 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Create `Keypad.tsx` with button components for digits and operators, style them to resize based on viewport, and place them inside `CalculatorLayout`.
### ASSIGN-010 -> junior-react [junior]
- Priority: high | Complexity: trivial
- Add `role="button"` and appropriate `aria-label` to each button in `Keypad.tsx` for accessibility.
### ASSIGN-011 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Implement focus management and visual focus indicators for keypad buttons, enabling navigation via Tab and activation with Enter/Space.
### ASSIGN-012 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Add a global `keydown` listener in the app root that maps numeric/operator keys to button actions and triggers evaluation on Enter.
### ASSIGN-013 -> junior-react [junior]
- Priority: high | Complexity: trivial
- Create CSS focus‑ring styles for calculator buttons that meet WCAG contrast requirements.
### ASSIGN-014 -> senior-backend [senior]
- Priority: high | Complexity: complex
- Create `parser.ts` implementing tokenization and the shunting‑yard algorithm to convert infix strings to RPN arrays.
### ASSIGN-015 -> senior-backend [senior]
- Priority: high | Complexity: complex
- Create `evaluator.ts` that evaluates an RPN array, handling arithmetic, decimals, negatives, and detecting division by zero.
### ASSIGN-016 -> senior-backend [senior]
- Priority: high | Complexity: simple
- Export `evaluateExpression(expr: string): number | EngineError` in `engine.ts` that uses the parser and evaluator modules.
### ASSIGN-017 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Configure `tsconfig.json` to target ES2020, use ESNext modules, generate declarations, and avoid polyfills for minimal bundle size.
### ASSIGN-018 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Define `EngineError` types for syntax errors and division‑by‑zero, with clear messages, and make `evaluateExpression` return them.
### ASSIGN-019 -> junior-react [junior]
- Priority: high | Complexity: simple
- Update `Display.tsx` to render error messages in red text when the engine returns an `EngineError`.
### ASSIGN-020 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Wrap all calls to the calculator engine in try/catch, log unexpected errors, and ensure the UI stays responsive after failures.
### ASSIGN-021 -> principal-frontend [principal]
- Priority: high | Complexity: simple
- Configure Vite production settings: set base public path, enable minification, and generate source maps.
### ASSIGN-022 -> principal-backend [principal]
- Priority: high | Complexity: simple
- Add a CI step that runs `npm run build` and verifies that the `dist` folder contains `index.html` and asset files.
### ASSIGN-023 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Write a multi‑stage Dockerfile that builds the Vite app and copies the `dist` folder into Nginx's html directory.
### ASSIGN-024 -> principal-backend [principal]
- Priority: high | Complexity: simple
- Create `nginx.conf` with CSP, HSTS, X‑Content‑Type‑Options, and other security headers.
### ASSIGN-025 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Implement the full GitHub Actions CI workflow with jobs for lint, test (with coverage), build, Docker image build, and Docker Hub push.
### ASSIGN-026 -> principal-backend [principal]
- Priority: high | Complexity: simple
- Add a coverage threshold step in the CI workflow that fails if global coverage is below 80%.
### ASSIGN-027 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Write Jest unit tests covering all operations (+, -, *, /), parentheses, decimals, negatives, division‑by‑zero, and syntax errors for the engine.
### ASSIGN-028 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Write React Testing Library component tests for button clicks, keyboard input, display updates, and error rendering.
### ASSIGN-029 -> senior-backend [senior]
- Priority: high | Complexity: simple
- Update `jest.config.ts` to enforce an 80% global coverage threshold for branches, functions, lines, and statements.
