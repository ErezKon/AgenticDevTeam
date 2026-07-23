# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-07-23T08:46:01.542Z

---

## Test Plan

{
  "scope": "The test plan covers unit testing of the core TypeScript utility modules (Validation Service and Expression Engine), integration testing of the React UI components with those services and the Express server, and end‑to‑end (Playwright) testing of all user‑facing scenarios, accessibility, security headers, and deployment artifacts. All acceptance criteria from the user stories are mapped to at least one test.",
  "unit": [
    {
      "target": "ValidationService.validateExpression",
      "description": "Unit tests for illegal character detection, ensuring the function returns an error with message \"Invalid character detected\" for any character outside 0-9, +, -, *, /, (, ), .",
      "framework": "jest"
    },
    {
      "target": "ValidationService.checkParenthesesBalance",
      "description": "Unit tests verifying that mismatched parentheses are detected and the appropriate error \"Mismatched parentheses\" is thrown.",
      "framework": "jest"
    },
    {
      "target": "ValidationService.checkDivisionByZero",
      "description": "Unit tests confirming division‑by‑zero pre‑check returns error \"Division by zero is not allowed\" before evaluation.",
      "framework": "jest"
    },
    {
      "target": "ExpressionEngine.evaluateExpression",
      "description": "Unit tests asserting the pure function returns correct numeric results for simple and complex expressions, throws errors for invalid input, and does not read or modify any global state.",
      "framework": "jest"
    },
    {
      "target": "ExpressionEngine.shuntingYardParser",
      "description": "Unit tests covering operator precedence, handling of decimals, negative numbers, and parentheses to ensure the parsing algorithm is correct.",
      "framework": "jest"
    },
    {
      "target": "ExpressionEngine.pureFunctionDeterminism",
      "description": "Unit tests calling evaluateExpression multiple times with the same string and asserting identical outputs each time.",
      "framework": "jest"
    },
    {
      "target": "CalculatorUI.DisplayComponent",
      "description": "Unit test that the display component updates its text content immediately when the prop `value` changes (simulating button press).",
      "framework": "jest"
    },
    {
      "target": "ErrorDisplayComponent",
      "description": "Unit test that the component renders the provided error message and includes `role=\"alert\"` and appropriate ARIA attributes for screen‑reader announcement.",
      "framework": "jest"
    },
    {
      "target": "CalculatorUI.KeyboardNavigationHooks",
      "description": "Unit tests for custom hooks handling Enter key evaluation and Arrow key focus movement, ensuring correct callbacks are invoked.",
      "framework": "jest"
    },
    {
      "target": "CalculatorUI.ResponsiveStyles",
      "description": "Unit test using jsdom and window.innerWidth to verify that CSS class toggles for viewports <600px and >=600px are applied correctly.",
      "framework": "jest"
    }
  ],
  "integration": [
    {
      "target": "CalculatorUI + ValidationService + ExpressionEngine",
      "description": "Render the full calculator UI, simulate button clicks to input the expression \"3 + (2.5 * -4) / 2\", press Enter, and verify the displayed result is \"-2.0\".",
      "framework": "jest"
    },
    {
      "target": "Keyboard navigation integration",
      "description": "Render Calculator UI, use RTL's `tab` utility to move focus through keypad buttons, assert logical order, press Enter to evaluate, and verify result. Also test Arrow keys move focus between adjacent buttons.",
      "framework": "jest"
    },
    {
      "target": "Error handling integration",
      "description": "Enter an invalid character via UI, assert ValidationService error propagates to ErrorDisplayComponent with correct message and ARIA alert role.",
      "framework": "jest"
    },
    {
      "target": "Mismatched parentheses integration",
      "description": "Input \"(2+3\" through UI, trigger evaluation, and verify the error message \"Mismatched parentheses\" appears.",
      "framework": "jest"
    },
    {
      "target": "Division by zero integration",
      "description": "Input \"5/0\" via UI, trigger evaluation, and verify the error message \"Division by zero is not allowed\" appears.",
      "framework": "jest"
    },
    {
      "target": "Express server security headers",
      "description": "Using supertest, send a GET request to the root path and assert that `Content-Security-Policy`, `X-Content-Type-Options`, and `X-Frame-Options` headers are present with expected values.",
      "framework": "jest"
    },
    {
      "target": "CI pipeline lint and test execution",
      "description": "Run the GitHub Actions workflow locally (act) on a pull_request event and assert that lint and Jest steps complete successfully and cause a failure when a test fails.",
      "framework": "jest"
    },
    {
      "target": "Docker image build integration",
      "description": "Execute `docker build` with the provided Dockerfile, tag with a dummy SHA, and run the container; then perform an HTTP request to `http://localhost:3000` to confirm the app serves the calculator page.",
      "framework": "jest"
    }
  ],
  "e2e": [
    {
      "scenario": "Responsive layout verification",
      "description": "Launch the app in Playwright, set viewport width to 500px and verify keypad buttons are sized for mobile; then set width to 800px and verify desktop layout. Capture screenshots for visual regression.",
      "criticalPath": true
    },
    {
      "scenario": "Real‑time display update",
      "description": "Click sequence of buttons (e.g., 1, +, 2) and assert the display panel updates after each click to show \"1\", then \"1+\", then \"1+2\".",
      "criticalPath": true
    },
    {
      "scenario": "ARIA accessibility compliance",
      "description": "Use Playwright's accessibility snapshot to ensure all interactive elements have appropriate `aria-label` attributes and that the ErrorDisplay component uses `role=\"alert\"`.",
      "criticalPath": true
    },
    {
      "scenario": "Keyboard navigation flow",
      "description": "Tab through the calculator, verify focus order matches keypad layout, press Enter to evaluate a simple expression, and use Arrow keys to move focus between adjacent buttons, confirming focus moves as expected.",
      "criticalPath": true
    },
    {
      "scenario": "Complex expression evaluation",
      "description": "Type \"3 + (2.5 * -4) / 2\" using the keypad or keyboard, press Enter, and verify the result displayed is \"-2.0\" with at least four decimal precision where applicable.",
      "criticalPath": true
    },
    {
      "scenario": "Invalid character error handling",
      "description": "Enter the character \"a\" via the UI, submit, and verify the error message \"Invalid character detected\" appears and is announced to screen readers.",
      "criticalPath": true
    },
    {
      "scenario": "Mismatched parentheses error handling",
      "description": "Input \"(2+3\" and attempt evaluation; confirm the error \"Mismatched parentheses\" is shown.",
      "criticalPath": true
    },
    {
      "scenario": "Division by zero error handling",
      "description": "Input \"5/0\" and evaluate; confirm the error \"Division by zero is not allowed\" is displayed.",
      "criticalPath": true
    },
    {
      "scenario": "Security headers verification",
      "description": "Navigate to the app, intercept the network response for the HTML page, and assert that CSP, X-Content-Type-Options, and X-Frame-Options headers are present and correctly configured.",
      "criticalPath": true
    },
    {
      "scenario": "Docker deployment sanity check",
      "description": "After the CI builds and pushes the Docker image, pull the image locally, run the container on port 3000, open the app in a browser, and verify the calculator UI loads and functions.",
      "criticalPath": true
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
