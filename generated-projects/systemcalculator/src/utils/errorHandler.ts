/**
 * Formats errors from the expression parser into user‑friendly messages.
 *
 * The parser (mathjs) can throw generic Error instances with various messages.
 * This function maps known error patterns to messages that can be displayed in the UI.
 * If the error is not recognised, a generic fallback message is returned.
 */
export function formatError(error: Error): string {
  const msg = error.message.toLowerCase();

  // Invalid syntax – mathjs throws messages containing "unexpected" or "invalid".
  if (msg.includes('invalid') || msg.includes('unexpected') || msg.includes('syntax')) {
    return 'Invalid syntax';
  }

  // Division by zero – mathjs throws "Division by zero" or similar.
  if (msg.includes('division by zero') || msg.includes('cannot divide by zero') || msg.includes('infinity')) {
    return 'Cannot divide by zero';
  }

  // Fallback generic message.
  return 'An unexpected error occurred';
}
