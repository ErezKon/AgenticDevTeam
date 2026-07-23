// src/utils/errorHandler.js
/**
 * Formats errors thrown by the expression parser (mathjs) into user‑friendly messages.
 * Maps known error patterns to clearer text for UI display.
 */
function formatError(err) {
  const message = err && err.message ? err.message : '';
  // Syntax errors
  if (/unexpected token|syntax/i.test(message)) {
    return 'Invalid syntax';
  }
  // Division by zero
  if (/division by zero/i.test(message)) {
    return 'Cannot divide by zero';
  }
  // Fallback to original message
  return message;
}
module.exports = { formatError };
