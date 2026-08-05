# Team Leader Mission Report

**Agent**: team-leader  
**Generated**: 2026-08-05T09:32:51.377Z

---

## Assignments (20)

### ASSIGN-001 -> principal-frontend [principal]
- Priority: critical | Complexity: complex
- Initialize a new Git repository, run `npm create vite@latest` with the React template, commit the initial project structure, and push the initial commit to the remote.
### ASSIGN-002 -> junior-react [junior]
- Priority: high | Complexity: simple
- Add React, ReactDOM, Jest, React Testing Library, ESLint and Prettier to the project. Update `package.json` scripts to include `test`, `lint`, and `build` commands.
### ASSIGN-003 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Create `.github/workflows/ci.yml` that runs ESLint, Jest tests with coverage, builds the Vite bundle, and on success triggers a Netlify deploy via the Netlify CLI.
### ASSIGN-004 -> principal-backend [principal]
- Priority: high | Complexity: simple
- Add `netlify.toml` with the build command `npm run build`, publish directory `dist`, and configure basic redirects.
### ASSIGN-005 -> principal-backend [principal]
- Priority: high | Complexity: simple
- Configure Netlify to include a `Content-Security-Policy` header that restricts resources to `'self'` and allows required inline scripts/styles.
### ASSIGN-006 -> junior-react [junior]
- Priority: medium | Complexity: moderate
- Create `CalculatorDisplay.jsx` component that receives `expression` and `result` props and renders them clearly. Apply basic styling following the project’s CSS conventions.
### ASSIGN-007 -> junior-react [junior]
- Priority: medium | Complexity: moderate
- Create `CalculatorKeypad.jsx` component that renders a grid of buttons for digits, decimal point, operators, parentheses, clear, and equals. Emit a click event with the button value.
### ASSIGN-008 -> senior-frontend [senior]
- Priority: medium | Complexity: complex
- In `Calculator.jsx`, manage the expression state, handle button clicks from `CalculatorKeypad`, update the display, and on ‘=’ press forward the expression string to the parser/evaluator modules.
### ASSIGN-009 -> junior-react [junior]
- Priority: medium | Complexity: simple
- Create `ErrorMessage.jsx` component that accepts an error text prop and displays it in a noticeable red style.
### ASSIGN-010 -> senior-frontend [senior]
- Priority: medium | Complexity: moderate
- Update `Calculator.jsx` to catch `SyntaxError` or runtime error objects from the parser/evaluator and render `ErrorMessage` with the error's message.
### ASSIGN-011 -> senior-frontend [senior]
- Priority: medium | Complexity: moderate
- Write responsive CSS (or Tailwind) rules so the calculator layout adapts for viewports <600px: adjust button size, grid layout, and font scaling.
### ASSIGN-012 -> principal-backend [principal]
- Priority: high | Complexity: very-complex
- Create `parser.js` implementing a recursive‑descent parser: tokenize the input, handle numbers (including decimals and negatives), parentheses, and the four operators with correct precedence, and output an AST.
### ASSIGN-013 -> principal-backend [principal]
- Priority: high | Complexity: moderate
- Export a function `parseExpression(str): AST` from `parser.js` that returns the AST or throws a `SyntaxError` with location information.
### ASSIGN-014 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Write Jest unit tests for the parser covering simple operations, precedence, parentheses, decimals, negatives, and malformed inputs. Ensure overall coverage ≥90 %.
### ASSIGN-015 -> principal-backend [principal]
- Priority: high | Complexity: very-complex
- Create `evaluator.js` that walks the AST from `parser.js` and computes the numeric result. Detect division by zero and return an error object with a descriptive message.
### ASSIGN-016 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Export a function `evaluateAST(ast): number | Error` from `evaluator.js` that returns the computed value or an error object with a clear message.
### ASSIGN-017 -> senior-backend [senior]
- Priority: high | Complexity: moderate
- Write Jest unit tests for the evaluator covering basic operations, precedence, nested parentheses, and edge cases like division by zero. Verify error handling and achieve ≥90 % coverage.
### ASSIGN-018 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- In `Calculator.jsx`, on ‘=’ press call `parseExpression` then `evaluateAST`. Display the numeric result or forward any error to the `ErrorMessage` component.
### ASSIGN-019 -> senior-frontend [senior]
- Priority: high | Complexity: moderate
- Write React Testing Library tests that simulate button clicks to build an expression (e.g., 2 + 2) and assert that the display shows the correct result. Also test that an invalid expression triggers the `ErrorMessage` component.
### ASSIGN-020 -> senior-backend [senior]
- Priority: high | Complexity: simple
- Update the GitHub Actions workflow to run `npm test -- --coverage` and fail the build if coverage for parser or evaluator drops below 90 %.
