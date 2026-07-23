# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-07-23T09:10:27.688Z

---

## Test Plan

{
  "scope": "The test plan covers unit testing of the pure TypeScript Calculator Engine and React UI components, integration testing of UI‑Engine interaction, build artifacts, CI pipeline and Docker container, and end‑to‑end (Playwright) testing of all user‑facing scenarios, ensuring every acceptance criterion is verified and the application meets quality, performance, and security goals.",
  "unit": [
    {
      "target": "CalculatorEngine.parseExpression",
      "description": "Verify tokenization of numbers, operators, parentheses, decimals and negative signs; ensure invalid characters produce a structured error.",
      "framework": "jest"
    },
    {
      "target": "CalculatorEngine.evaluateExpression",
      "description": "Test correct evaluation of expressions with operator precedence, parentheses, decimal numbers and negative numbers using sample expressions from US‑003.",
      "framework": "jest"
    },
    {
      "target": "CalculatorEngine error handling",
      "description": "Assert that unmatched parentheses return error { message: \"Unmatched parentheses\" } and division by zero returns error { message: \"Division by zero\" }. Covers US‑005.",
      "framework": "jest"
    },
    {
      "target": "CalculatorEngine return contract",
      "description": "Confirm the engine never throws; it always returns either a numeric result or a defined error object, satisfying US‑006.",
      "framework": "jest"
    },
    {
      "target": "Button component (React)",
      "description": "Render a calculator button and simulate mouse/touch press; verify active/pressed CSS class is applied while pressed and removed on release (US‑002).",
      "framework": "jest with @testing-library/react"
    },
    {
      "target": "CalculatorDisplay component (React)",
      "description": "Ensure the component correctly renders numeric results and error messages received from the engine, covering US‑005 and US‑006.",
      "framework": "jest with @testing-library/react"
    },
    {
      "target": "ResponsiveLayout component (React)",
      "description": "Render the calculator UI at viewport widths <600px and >600px; assert button size meets minimum 48x48dp and layout adjusts appropriately (US‑001).",
      "framework": "jest with @testing-library/react"
    }
  ],
  "integration": [
    {
      "target": "UI ↔ CalculatorEngine interaction",
      "description": "Mount the full calculator UI, input a full expression via button clicks, and verify the displayed result matches engine evaluation for both correct and error cases (US‑003, US‑005, US‑006).",
      "framework": "jest with @testing-library/react"
    },
    {
      "target": "Build artifact verification",
      "description": "Run the TypeScript build and assert the generated JavaScript bundle for the engine is a single file with no external import statements, confirming US‑004.",
      "framework": "jest (using child_process exec) "
    },
    {
      "target": "GitHub Actions CI pipeline",
      "description": "Execute the CI workflow in a dry‑run mode and assert that lint, Jest tests, React build, Docker build steps all succeed; ensure the job fails on any lint or test error (US‑007).",
      "framework": "jest (via @actions/core mock) "
    },
    {
      "target": "NGINX Docker image",
      "description": "Build the Docker image, start a container, and perform an HTTPS GET request to '/' verifying a 200 response and correct content‑type, satisfying US‑008.",
      "framework": "jest with supertest or node-fetch"
    }
  ],
  "e2e": [
    {
      "scenario": "Responsive layout on mobile and desktop",
      "description": "Launch the app with viewport 375x667 (mobile) and 1024x768 (desktop); verify button dimensions ≥48x48dp and that the layout switches (e.g., grid vs. stacked) as defined in US‑001.",
      "criticalPath": true
    },
    {
      "scenario": "Button visual feedback",
      "description": "Using Playwright, press each calculator button and assert that the button receives the active style (e.g., darker background) while pressed and reverts immediately after release, covering US‑002.",
      "criticalPath": true
    },
    {
      "scenario": "Correct calculation of sample expressions",
      "description": "Enter expressions like \"3+4*2/(1-5)\" and \"-2.5*(3+4)\" via UI clicks; verify the displayed result matches the mathematically correct value, fulfilling US‑003.",
      "criticalPath": true
    },
    {
      "scenario": "Error handling for malformed expressions",
      "description": "Input \"(2+3\" (unmatched parentheses) and \"5/0\" (division by zero); confirm the UI shows the exact error messages \"Unmatched parentheses\" and \"Division by zero\" without crashing, covering US‑005.",
      "criticalPath": true
    },
    {
      "scenario": "Recovery after an error",
      "description": "After triggering an error, enter a new valid expression \"7-2\"; verify the previous error disappears and the correct result is displayed, ensuring continued usability per US‑006.",
      "criticalPath": true
    },
    {
      "scenario": "HTTPS serving via NGINX container",
      "description": "Navigate to https://localhost (or the container's host) with Playwright; assert the page loads without mixed‑content warnings and the calculator UI is visible, satisfying US‑008.",
      "criticalPath": true
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
