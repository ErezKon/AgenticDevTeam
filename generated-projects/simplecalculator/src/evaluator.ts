// Simple expression evaluator for calculator UI
// NOTE: This is a naive implementation using Function constructor.
// It handles basic arithmetic, division by zero, and syntax errors.

export interface EvalResult {
  result?: number;
  error?: { code: string; message: string };
}

export function evaluateExpression(expr: string): EvalResult {
  // Trim whitespace
  const trimmed = expr.trim();
  if (trimmed === "") {
    return { error: { code: "EMPTY", message: "Expression is empty" } };
  }
  try {
    // Use Function to evaluate safely (no external variables)
    // This will throw on syntax errors.
    const fn = new Function(`"use strict"; return (${trimmed});`);
    const value = fn();
    if (typeof value !== "number" || isNaN(value)) {
      return { error: { code: "INVALID", message: "Result is not a number" } };
    }
    if (!isFinite(value)) {
      // Handles division by zero resulting in Infinity or -Infinity
      return { error: { code: "DIV_ZERO", message: "Cannot divide by zero" } };
    }
    // Round to 10 decimal places as per UI requirement
    const rounded = Math.round(value * 1e10) / 1e10;
    return { result: rounded };
  } catch (e: any) {
    // Distinguish division by zero if caught via Infinity
    if (e instanceof Error && e.message.includes("division by zero")) {
      return { error: { code: "DIV_ZERO", message: "Cannot divide by zero" } };
    }
    // Generic syntax error
    return { error: { code: "SYNTAX_ERROR", message: "Syntax error: unexpected token" } };
  }
}
