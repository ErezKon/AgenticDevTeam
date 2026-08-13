# Requirements Traceability Matrix

**Agent**: conductor  
**Generated**: 2026-08-13T08:50:01.820Z

---

## Requirements Traceability Summary

| Metric | Value |
|--------|-------|
| Total acceptance criteria | 11 |
| Verified (merged + executed test passed) | 0 |
| Tested but failing | 0 |
| Implemented but untested | 0 |
| Planned only (no merged PR) | 7 |
| Blocked | 4 |
| Missing (no assignment) | 0 |
| Verified % | 0.0% |
| Implemented % | 0.0% |
| Delivery score | 0.00 |

## Top Gaps

| Story | AC# | Criterion | Status | Assignment/Module |
|-------|-----|-----------|--------|-------------------|
| US-004 | 0 | GitHub Actions runs the Jest test suite on every push and fails the workflow on  | BLOCKED | ASSIGN-001 |
| US-004 | 1 | On a successful build, Netlify automatically deploys the latest version and serv | BLOCKED | ASSIGN-001 |
| US-005 | 0 | After the Vite build, opening the deployed index.html loads the SPA without cons | BLOCKED | ASSIGN-002 |
| US-005 | 1 | A user can enter a full expression via button clicks or keyboard, press '=', and | BLOCKED | ASSIGN-002 |

## Traceability Matrix

| Epic | Story | AC# | Acceptance Criterion | Status | PRs | Tests |
|------|-------|-----|----------------------|--------|-----|-------|
| EPIC-004 | US-004 | 0 | GitHub Actions runs the Jest test suite on every push and fails the workflow on any test failure. | BLOCKED | #102 (blocked) | 1 planned |
| EPIC-004 | US-004 | 1 | On a successful build, Netlify automatically deploys the latest version and serves it from a CDN. | BLOCKED | #102 (blocked) | 1 planned |
| EPIC-004 | US-005 | 0 | After the Vite build, opening the deployed index.html loads the SPA without console errors. | BLOCKED | #102 (blocked) | 2 planned |
| EPIC-004 | US-005 | 1 | A user can enter a full expression via button clicks or keyboard, press '=', and see the correct result displayed. | BLOCKED | #102 (blocked) | 1 planned |
| EPIC-001 | US-001 | 0 | The calculator displays the current expression and the computed result or error message in the Display component. | planned-only | -- | 1 planned |
| EPIC-001 | US-001 | 1 | All required buttons (0-9, ., +, -, *, /, (, ), =, C) are rendered, have appropriate ARIA labels, and update the expression when clicked. | planned-only | -- | 2 planned |
| EPIC-001 | US-001 | 2 | The UI updates instantly without page reload and is usable via keyboard navigation (Tab/Enter). | planned-only | -- | 1 planned |
| EPIC-002 | US-002 | 0 | evaluate returns the correct numeric result for expressions using +, -, *, /, parentheses, decimals, and negative numbers. | planned-only | -- | 1 planned |
| EPIC-002 | US-002 | 1 | evaluate handles division by zero by returning an error that can be displayed to the user. | planned-only | -- | 1 planned |
| EPIC-003 | US-003 | 0 | isValidExpression returns true for syntactically correct expressions and false for malformed ones. | planned-only | -- | 1 planned |
| EPIC-003 | US-003 | 1 | When an invalid expression is submitted, the UI shows a user‑friendly error message instead of crashing. | planned-only | -- | 1 planned |

## Blocked Deliveries

| Branch | PR | Status | Reason |
|--------|-----|--------|--------|
| simplecalculator/chore/scaffold | #102 | blocked | Merge conflicts or review blocked |
| simplecalculator/chore/build-verify | #102 | blocked | Merge conflicts or review blocked |

