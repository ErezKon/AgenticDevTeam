# Team Leader Mission Report

**Agent**: team-leader  
**Generated**: 2026-08-05T10:18:34.181Z

---

## Assignments (25)

### ASSIGN-001 -> senior-frontend [senior]
- Priority: critical | Complexity: complex
- Create a new repository and run `npm create vite@latest` with the React + TypeScript template. Commit the initial project files including package.json, vite.config.ts, and src directory.
### ASSIGN-002 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Add core dependencies: React, ReactDOM, TypeScript, Jest, React Testing Library, ESLint, Prettier, and related plugins. Update package.json scripts accordingly.
### ASSIGN-003 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Add `jest.config.ts`, configure `ts-jest`, set up React Testing Library environment, and add a sample test to verify the configuration works.
### ASSIGN-004 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Create `.eslintrc.js` with @typescript-eslint parser, add a `.prettierrc` configuration, and add lint and format npm scripts to package.json.
### ASSIGN-005 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Create a `Calculator` component using CSS Grid/Flex that adapts to mobile (<768px) and desktop (>=768px) breakpoints. Ensure the display area spans the top and buttons wrap appropriately.
### ASSIGN-006 -> junior-react [junior]
- Priority: medium | Complexity: simple
- Create a reusable `CalcButton` component (`src/components/CalcButton.tsx`) that accepts `label`, `value`, and `onClick` props, applies consistent styling, and is touch‑friendly.
### ASSIGN-007 -> junior-react [junior]
- Priority: medium | Complexity: simple
- Develop a `Display` component (`src/components/Display.tsx`) that shows the current expression string, updates in real time, and handles overflow for long expressions.
### ASSIGN-008 -> senior-frontend [senior]
- Priority: medium | Complexity: moderate
- Add appropriate ARIA attributes to each `CalcButton` (e.g., `aria-label`) and to the `Display` component (`role="textbox"` and `aria-live="polite"`).
### ASSIGN-009 -> senior-frontend [senior]
- Priority: medium | Complexity: moderate
- Implement keyboard navigation: allow Tab focus through all buttons, handle Enter/Space activation, and style focus rings. Ensure focus order matches visual layout.
### ASSIGN-010 -> senior-backend [senior]
- Priority: critical | Complexity: very-complex
- Create `src/engine/evaluator.ts` implementing tokenization, recursive‑descent parsing, and evaluation of numbers, operators, parentheses, respecting precedence. Export `evaluate(expression: string): number | Error`.
### ASSIGN-011 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Add Jest test cases in `src/engine/__tests__/evaluator.test.ts` covering simple operations, operator precedence, nested parentheses, decimals, and negative numbers.
### ASSIGN-012 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Create `src/index.ts` that re‑exports `evaluate`. Adjust `tsconfig.json` to generate declaration files for library consumption.
### ASSIGN-013 -> senior-backend [senior]
- Priority: medium | Complexity: simple
- Add a build script in `package.json` that runs `tsc --project tsconfig.lib.json` producing compiled JS and `.d.ts` files in `dist/`.
### ASSIGN-014 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Enhance the parser to detect unmatched parentheses, illegal characters, malformed decimals, and return `Error` objects with descriptive messages.
### ASSIGN-015 -> senior-backend [senior]
- Priority: high | Complexity: simple
- During evaluation, detect division by zero and return a specific `Error` indicating the illegal operation.
### ASSIGN-016 -> junior-react [junior]
- Priority: medium | Complexity: simple
- Build an `ErrorBanner` component (`src/components/ErrorBanner.tsx`) that receives an error string prop and displays it with ARIA role `alert` and appropriate styling.
### ASSIGN-017 -> senior-frontend [senior]
- Priority: high | Complexity: complex
- Update the main `Calculator` component to call `evaluate`, differentiate between numeric result and `Error`, render `Display` or `ErrorBanner` accordingly, and reset state after an error.
### ASSIGN-018 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Add `.github/workflows/ci.yml` that runs on push/pull_request, installs dependencies, runs ESLint, TypeScript compilation, Jest tests, and builds the production bundle.
### ASSIGN-019 -> senior-frontend [senior]
- Priority: medium | Complexity: simple
- Add npm scripts `lint` and `format` invoking ESLint and Prettier, ensure they are called in the CI workflow, and configure them to fail fast on errors.
### ASSIGN-020 -> senior-backend [senior]
- Priority: medium | Complexity: complex
- Write a multi‑stage Dockerfile: Stage 1 uses a Node image to run `npm ci` and `npm run build`; Stage 2 uses an NGINX image and copies the built static files into `/usr/share/nginx/html`. Expose port 80.
### ASSIGN-021 -> senior-backend [senior]
- Priority: medium | Complexity: moderate
- Create `nginx.conf` that sets `root /usr/share/nginx/html;`, enables gzip compression, and adds basic caching headers for static assets.
### ASSIGN-022 -> senior-backend [senior]
- Priority: medium | Complexity: moderate
- Update `nginx.conf` to add `expires max;` and `Cache-Control: public, max-age=31536000` for JS/CSS files while keeping HTML non‑cached.
### ASSIGN-023 -> senior-frontend [senior]
- Priority: low | Complexity: moderate
- Extend the GitHub Actions workflow to run Lighthouse CI (`lhci autorun`) with a performance budget of 2 seconds for first contentful paint on a simulated 3G network.
### ASSIGN-024 -> junior-react [junior]
- Priority: medium | Complexity: simple
- Write React Testing Library tests in `src/__tests__/Calculator.test.tsx` that render the Calculator, simulate button clicks, and assert that the Display updates with the correct expression string.
### ASSIGN-025 -> senior-frontend [senior]
- Priority: medium | Complexity: moderate
- Write an integration test in `src/__tests__/ErrorFlow.test.tsx` that simulates entering an invalid expression (e.g., `5/0`), verifies the `ErrorBanner` appears with the correct message, then enters a valid expression and confirms normal operation resumes.
