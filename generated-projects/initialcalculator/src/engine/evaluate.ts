export type EvalResult =
  | { result: number }
  | { error: string };

/**
 * Simple evaluator for arithmetic expressions supporting +, -, *, /, parentheses,
 * decimals and negative numbers. It performs basic validation and returns a
 * result or an error message.
 *
 * NOTE: This is a lightweight implementation using Function constructor for
 * evaluation after sanitising the expression. It is sufficient for the calculator
 * UI component tests. For production, a proper parser should replace this.
 */
export function evaluate(expression: string): EvalResult {
  // Trim whitespace
  const expr = expression.trim();
  if (expr === "") {
    return { error: "Invalid syntax" };
  }

  // Validate allowed characters (digits, operators, parentheses, decimal point, whitespace)
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return { error: "Invalid syntax" };
  }

  // Check for mismatched parentheses
  let balance = 0;
  for (const ch of expr) {
    if (ch === "(") balance++;
    else if (ch === ")") balance--;
    if (balance < 0) return { error: "Mismatched parentheses" };
  }
  if (balance !== 0) return { error: "Mismatched parentheses" };

  // Detect division by zero patterns (simple check)
  // This will catch direct division by zero like /0 or /0)
  if (/\/\s*0(?![0-9])/ .test(expr)) {
    return { error: "Division by zero" };
  }

  try {
    // Use Function constructor to evaluate safely after validation
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${expr});`);
    const rawResult = fn();
    if (typeof rawResult !== "number" || !isFinite(rawResult)) {
      return { error: "Invalid syntax" };
    }
    // Round to at most 10 decimal places
    const result = Math.round(rawResult * 1e10) / 1e10;
    return { result };
  } catch (e) {
    return { error: "Invalid syntax" };
  }
}
