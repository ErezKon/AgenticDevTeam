export type EvalResult =
  | { result: number }
  | { error: { code: string; message: string } };

/**
 * Simple evaluator using Function constructor.
 * Handles basic arithmetic and division by zero detection.
 */
export function evaluate(expression: string): EvalResult {
  // Basic validation: allow only digits, operators, parentheses, decimal point, and whitespace
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
    return { error: { code: 'INVALID_CHAR', message: 'Invalid characters in expression' } };
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`'use strict'; return (${expression});`)();
    if (typeof result !== 'number' || !isFinite(result)) {
      // Handles division by zero or other non-finite results
      return { error: { code: 'DIV_ZERO', message: 'Cannot divide by zero' } };
    }
    return { result };
  } catch (e) {
    return { error: { code: 'SYNTAX_ERROR', message: 'Syntax error' } };
  }
}
