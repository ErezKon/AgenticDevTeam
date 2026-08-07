# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-08-07T22:59:44.314Z

---

## Test Plan

{
  "scope": "No explicit user stories or acceptance criteria were provided. The test plan is derived from the functional requirements of the calculator SPA, covering parsing, evaluation, UI interaction, error handling, and critical user journeys.",
  "unit": [
    {
      "target": "src/engine/tokenizer.ts - tokenize function",
      "description": "Tokenizes input strings into numbers, operators, parentheses, handling decimals and negatives.",
      "framework": "Jest",
      "storyId": "CALC-ENG",
      "acIndex": 0
    },
    {
      "target": "src/engine/parser.ts - parseExpression function",
      "description": "Parses valid arithmetic expressions with correct operator precedence and parentheses.",
      "framework": "Jest",
      "storyId": "CALC-ENG",
      "acIndex": 1
    },
    {
      "target": "src/engine/evaluator.ts - evaluateAST function",
      "description": "Evaluates the abstract syntax tree produced by the parser and returns the correct numeric result.",
      "framework": "Jest",
      "storyId": "CALC-ENG",
      "acIndex": 2
    },
    {
      "target": "src/engine/errors.ts",
      "description": "Throws descriptive errors for syntax errors, unmatched parentheses, and division by zero.",
      "framework": "Jest",
      "storyId": "CALC-ENG",
      "acIndex": 3
    },
    {
      "target": "src/engine/utils.ts - isValidNumber helper",
      "description": "Validates numeric tokens, ensuring proper handling of leading zeros and decimal points.",
      "framework": "Jest",
      "storyId": "CALC-ENG",
      "acIndex": 4
    }
  ],
  "integration": [
    {
      "target": "src/components/Calculator.tsx - expression submission",
      "description": "UI captures user input, passes the raw expression to the Calculator Engine, and displays the numeric result.",
      "framework": "Jest with React Testing Library",
      "storyId": "CALC-UI",
      "acIndex": 0
    },
    {
      "target": "src/components/Calculator.tsx - error display",
      "description": "When the engine throws an error, the UI renders a clear validation message without breaking the layout.",
      "framework": "Jest with React Testing Library",
      "storyId": "CALC-UI",
      "acIndex": 1
    },
    {
      "target": "src/components/Calculator.tsx - keyboard support",
      "description": "Pressing Enter triggers evaluation; arrow keys navigate within the input field without losing focus.",
      "framework": "Jest with React Testing Library",
      "storyId": "CALC-UI",
      "acIndex": 2
    },
    {
      "target": "src/components/Calculator.tsx - sanitization",
      "description": "Any engine output is escaped before being rendered to prevent XSS.",
      "framework": "Jest with React Testing Library",
      "storyId": "CALC-SEC",
      "acIndex": 0
    }
  ],
  "e2e": [
    {
      "scenario": "User enters a simple valid expression and sees correct result",
      "description": "Type '2+3*4' into the calculator, press Enter, and verify that the displayed result is '14'.",
      "criticalPath": true,
      "storyId": "CALC-E2E",
      "acIndex": 0
    },
    {
      "scenario": "User enters expression with parentheses and decimals",
      "description": "Type '(1.5+2.5)*2', press Enter, and verify that the displayed result is '8'.",
      "criticalPath": true,
      "storyId": "CALC-E2E",
      "acIndex": 1
    },
    {
      "scenario": "User enters negative numbers",
      "description": "Type '-5+3', press Enter, and verify that the displayed result is '-2'.",
      "criticalPath": true,
      "storyId": "CALC-E2E",
      "acIndex": 2
    },
    {
      "scenario": "User triggers division by zero error",
      "description": "Type '10/0', press Enter, and verify that a user‑friendly error message like 'Division by zero' is shown.",
      "criticalPath": true,
      "storyId": "CALC-E2E",
      "acIndex": 3
    },
    {
      "scenario": "User enters a malformed expression",
      "description": "Type '5++2', press Enter, and verify that a syntax error message is displayed.",
      "criticalPath": true,
      "storyId": "CALC-E2E",
      "acIndex": 4
    },
    {
      "scenario": "Responsive layout on different viewports",
      "description": "Resize the browser to mobile width and verify that the input and result remain visible and usable.",
      "criticalPath": false,
      "storyId": "CALC-UI",
      "acIndex": 3
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
