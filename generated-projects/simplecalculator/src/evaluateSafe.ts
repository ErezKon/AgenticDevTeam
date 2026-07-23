import { evaluate } from './evaluator';

/**
 * Safe wrapper around {@link evaluate}.
 * Performs validation and catches errors, returning descriptive error strings.
 *
 * @param expression arithmetic expression to evaluate
 * @returns number result or error message string
 */
export function evaluateSafe(expression: string): number | string {
  // Trim whitespace
  const trimmed = expression.trim();
  if (!trimmed) return 'Error: Invalid expression';

  // Allowed characters: digits, operators, parentheses, decimal point, whitespace
  if (/[^0-9+\-*/().\s]/.test(trimmed)) {
    return 'Error: Invalid character';
  }

  // Detect invalid number format: more than one decimal point in a number
  // This regex finds a digit sequence with two dots before a non-digit/non-dot
  if (/\d*\.\d*\./.test(trimmed)) {
    return 'Error: Invalid number format';
  }

  try {
    const result = evaluate(trimmed);
    // evaluate may return an error string directly
    return result;
  } catch (err) {
    if (err instanceof Error) {
      return `Error: ${err.message}`;
    }
    return 'Error: Unknown error';
  }
}
