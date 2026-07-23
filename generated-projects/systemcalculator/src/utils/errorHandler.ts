/**
 * Formats errors thrown by the expression parser into user‑friendly messages.
 * @param err The caught Error object.
 * @returns A string suitable for display in the UI.
 */
export function formatError(err: Error): string {
  const msg = err.message.toLowerCase();
  if (msg.includes('unexpected') || msg.includes('syntax')) {
    return 'Invalid syntax';
  }
  if (msg.includes('divide by zero') || msg.includes('division by zero') || msg.includes('infinity')) {
    return 'Cannot divide by zero';
  }
  return 'Error';
}
