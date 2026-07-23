// src/utils/errorHandler.ts
/**
 * Formats errors thrown by the expression parser (mathjs) into user‑friendly messages.
 *
 * The function inspects the error message and maps known patterns to a clearer
 * description that can be displayed in the UI. If the error does not match any
 * known pattern, the original message is returned.
 */
export function formatError(err: Error): string {
export default formatError;
  const message = err.message ?? '';

  // mathjs syntax errors usually contain "Unexpected token" or "syntax"
  if (/unexpected token|syntax/i.test(message)) {
    return 'Invalid syntax';
  }

  // Division by zero error from mathjs
  if (/division by zero/i.test(message)) {
    return 'Cannot divide by zero';
  }

  // Add more mappings here as needed.

  // Fallback – return the original message.
  return message;
}
