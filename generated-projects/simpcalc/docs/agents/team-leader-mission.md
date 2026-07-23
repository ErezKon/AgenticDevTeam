# Team Leader Mission Report

**Agent**: team-leader  
**Generated**: 2026-07-23T08:28:15.418Z

---

## Assignments (15)

### ASSIGN-001 -> principal-frontend [principal]
- Priority: critical | Complexity: simple
- Create a new Vite React+TypeScript project named 'calculator' using `npm create vite@latest calculator -- --template react-ts`. Commit all generated files, push to the repository. Ensure .gitignore includes node_modules and dist directories.
### ASSIGN-002 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Install ESLint, Prettier, eslint-plugin-react, @typescript-eslint/parser and related plugins. Add `.eslintrc.js` with React/TypeScript rules and `.prettierrc` for formatting. Add lint and format scripts to package.json. No code changes beyond configuration.
### ASSIGN-003 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Create a multi‑stage Dockerfile: stage 1 uses `node:18-alpine` to run `npm install` and `npm run build`; stage 2 uses `node:18-alpine` to copy the `dist` folder and start an Express server (server.js) that serves static files on port 3000. Add a `.dockerignore` file.
### ASSIGN-004 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Add `.github/workflows/ci.yml` that triggers on push and pull_request. Steps: checkout, setup Node, install dependencies, run ESLint, execute Jest tests, and build the Vite production bundle. Fail the workflow on any lint or test error.
### ASSIGN-005 -> senior-frontend [senior]
- Priority: critical | Complexity: moderate
- Create React components under `src/components`: `Calculator.tsx` (holds expression state and orchestrates evaluation), `Display.tsx` (shows current expression/result), `Keypad.tsx` (grid of buttons), and `Button.tsx` (individual button component). Use TypeScript interfaces, functional components, and React hooks. Export `Calculator` as default.
### ASSIGN-006 -> junior-react [junior]
- Priority: high | Complexity: moderate
- Add responsive styling to the Calculator UI. Use TailwindCSS (or CSS Modules) with media queries: for viewports <600px display keypad in a single column; for >=600px use a grid layout. Ensure buttons have a minimum touch size of 44px. Modify `Calculator.tsx` and related CSS files.
### ASSIGN-007 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Implement keyboard navigation and ARIA attributes. Add `tabIndex`, `role="button"`, and descriptive `aria-label` to each `Button`. In `Calculator.tsx` handle `onKeyDown` to map Enter to evaluation and Arrow keys to move focus between adjacent buttons. Ensure focus outline is visible.
### ASSIGN-008 -> junior-react [junior]
- Priority: high | Complexity: moderate
- Create `src/services/validation.ts` exporting three functions: `hasInvalidChars(expr: string): boolean`, `areParenthesesBalanced(expr: string): boolean`, and `hasDivisionByZero(expr: string): boolean`. Each returns a boolean or throws an `Error` with a descriptive message. Follow existing ESLint and Prettier conventions.
### ASSIGN-009 -> junior-react [junior]
- Priority: high | Complexity: simple
- Create `src/components/ErrorDisplay.tsx` component that accepts a `message: string` prop and renders a `<div>` with `role="alert"` and ARIA live region attributes. Style the message in red text. Import and use this component in `Calculator.tsx` to show validation or evaluation errors.
### ASSIGN-010 -> principal-backend [principal]
- Priority: critical | Complexity: very-complex
- Implement `src/services/engine.ts` with a pure function `evaluate(expr: string): number`. Use the shunting‑yard algorithm to convert the infix expression to Reverse Polish Notation, then evaluate the RPN. Support decimal numbers, negative numbers, parentheses, and standard operator precedence. Throw `Error` with clear messages for malformed expressions.
### ASSIGN-011 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Create Jest test file `src/services/__tests__/validation.test.ts`. Write tests covering illegal characters, mismatched parentheses, division‑by‑zero, and valid expressions. Use `expect(() => fn()).toThrow('...')` to verify error messages.
### ASSIGN-012 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Create Jest test file `src/services/__tests__/engine.test.ts`. Write test cases for operator precedence, decimal arithmetic, negative numbers, and error handling on malformed expressions. Verify that `evaluate` returns the correct numeric result or throws the expected error.
### ASSIGN-013 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Write integration tests in `src/__tests__/calculator.integration.test.ts` using React Testing Library. Simulate button clicks to build an expression, verify the `Display` updates in real time, press Enter to evaluate, and assert the final result matches the output of `evaluate`. Include accessibility checks for ARIA attributes.
### ASSIGN-014 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Extend `.github/workflows/ci.yml` with a `docker` job. Log into Docker Hub using secrets, build the Docker image using the Dockerfile, tag it with the commit SHA (`${{ github.sha }}`), and push it to the container registry. Ensure this job runs after the build step and fails the workflow on any error.
### ASSIGN-015 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- In `server.js` (Express static server), install `helmet` middleware and configure it to set Content‑Security‑Policy, X‑Content‑Type‑Options, X‑Frame‑Options, and Referrer‑Policy headers. Apply the middleware before serving static files on port 3000.
