/**
 * Validation utilities for arithmetic expressions.
 * Only the following characters are allowed:
 *   digits 0-9
 *   operators + - * /
 *   parentheses ( )
 *   decimal point .
 * No whitespace or other characters are permitted.
 */

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: { code: string; message: string } };

/**
 * Checks whether the given expression contains only allowed characters.
 * Returns a ValidationResult indicating success or a structured error.
 */
export function validateExpression(expression: string): ValidationResult {
  // Allowed characters regex: digits, +, -, *, /, parentheses, decimal point.
  const allowedPattern = /^[0-9+\-*/().]+$/;
  if (allowedPattern.test(expression)) {
    return { valid: true };
  }
  return {
    valid: false,
    error: {
      code: 'INVALID_CHAR',
      message: 'Expression contains invalid characters',
    },
  };
}
