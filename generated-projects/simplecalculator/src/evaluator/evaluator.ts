export type EvalResult = { value: number } | { error: { code: string; message: string } };

/**
 * Simple evaluator using Function constructor. In real project, replace with proper parser.
 */
export function evaluate(expression: string): EvalResult {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${expression});`);
    const value = fn();
    if (typeof value === 'number' && isFinite(value)) {
      return { value };
    }
    return { error: { code: 'EVAL_ERROR', message: 'Evaluation did not produce a number' } };
  } catch (e: any) {
    if (e instanceof Error && e.message.includes('division by zero')) {
      return { error: { code: 'DIV_ZERO', message: 'Cannot divide by zero' } };
    }
    return { error: { code: 'SYNTAX_ERROR', message: e.message } };
  }
}
