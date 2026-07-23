import { evaluate } from 'mathjs';

/**
 * Custom error thrown when the expression has invalid syntax.
 */
export class ExpressionSyntaxError extends Error {
  constructor(message?: string) {
    super(message ?? 'Invalid syntax');
    this.name = 'ExpressionSyntaxError';
  }
}

/**
 * Custom error thrown when a division by zero is attempted.
 */
export class DivisionByZeroError extends Error {
  constructor(message?: string) {
    super(message ?? 'Cannot divide by zero');
    this.name = 'DivisionByZeroError';
  }
}

/**
 * Parses and evaluates a mathematical expression.
 *
 * @param expr - The expression string to evaluate.
 * @returns The numeric result of the evaluation.
 * @throws {ExpressionSyntaxError} If the expression cannot be parsed.
 * @throws {DivisionByZeroError} If the expression attempts division by zero.
 */
export function parseExpression(expr: string): number {
  try {
    const result = evaluate(expr);
    // mathjs may return a BigNumber or other types; coerce to number if possible
    if (typeof result === 'number') {
      if (!Number.isFinite(result)) {
        // Handles division by zero resulting in Infinity
        throw new DivisionByZeroError();
      }
      return result;
    }
    // If result is a BigNumber, convert to number safely
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any).toNumber) {
      // @ts-ignore
      const num = (result as any).toNumber();
      if (!Number.isFinite(num)) {
        throw new DivisionByZeroError();
      }
      return num;
    }
    throw new Error('Result is not a number');
  } catch (e: any) {
    // mathjs throws an Error with a message describing the problem.
    const msg = e?.message ?? '';
    if (msg.toLowerCase().includes('division by zero')) {
      throw new DivisionByZeroError();
    }
    // Syntax errors typically contain the word "parse" or "unexpected"
    if (
      msg.toLowerCase().includes('parse') ||
      msg.toLowerCase().includes('unexpected') ||
      msg.toLowerCase().includes('syntax') ||
      msg.toLowerCase().includes('undefined symbol')
    ) {
      throw new ExpressionSyntaxError();
    }
    // Re‑throw unknown errors
    throw e;
  }
}
