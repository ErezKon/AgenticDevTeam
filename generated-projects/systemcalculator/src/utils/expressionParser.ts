import { evaluate } from 'mathjs';

/**
 * Parses a mathematical expression string and returns the numeric result.
 *
 * Supported operators: +, -, *, /, parentheses, decimals and negative numbers.
 *
 * On success, returns a number. On failure, throws an Error with a user‑friendly
 * message. Currently, syntax errors are normalized to "Invalid syntax".
 */
export function parseExpression(expr: string): number {
  // Pre‑validation: reject obvious syntax errors like consecutive operators
  if (/[+\-*/]{2,}/.test(expr)) {
    throw new Error('Invalid syntax');
  }
  // Check for balanced parentheses
  const stack: string[] = [];
  for (const ch of expr) {
    if (ch === '(') {
      stack.push(ch);
    } else if (ch === ')') {
      if (stack.length === 0) {
        throw new Error('Invalid syntax');
      }
      stack.pop();
    }
  }
  if (stack.length !== 0) {
    throw new Error('Invalid syntax');
  }
  try {
    // mathjs evaluate will throw on syntax errors or illegal operations.
    const result = evaluate(expr);
    // Ensure the result is a finite number.
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      // For cases like division by zero which yields Infinity.
      throw new Error('Invalid result');
    }
    return result;
  } catch (err: any) {
    // Normalize known mathjs error messages to a generic user‑friendly message.
    const msg = err?.message ?? '';
    // mathjs syntax errors typically contain the word "Unexpected" or "Parenthesis".
    if (/Unexpected|Parenthesis|Syntax|Invalid/.test(msg)) {
      throw new Error('Invalid syntax');
    }
    // For division by zero, mathjs may produce "Infinity" or a specific message.
    if (/divide by zero/i.test(msg) || /Infinity/.test(msg)) {
      throw new Error('Cannot divide by zero');
    }
    // Fallback to the original error message.
    throw err;
  }
}
