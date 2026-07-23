import { evaluate } from 'mathjs';

/**
 * Parses a mathematical expression string and returns the numeric result.
 * Throws an Error with a message describing the problem if the expression is invalid.
 */
export function parseExpression(expr: string): number {
  console.log('parseExpression called with', expr);
  // mathjs evaluate will throw on syntax errors or illegal operations.
  const result = evaluate(expr);
  if (typeof result !== 'number') {
    // In case of unexpected non‑numeric result (e.g., functions), coerce or throw.
    throw new Error('Result is not a number');
  }
  // Detect division by zero which yields Infinity in mathjs.
  if (!Number.isFinite(result)) {
    throw new Error('Division by zero');
  }
  return result;
}
