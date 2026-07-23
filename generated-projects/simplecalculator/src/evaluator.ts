export interface EvalResult {
  result?: number;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Simple evaluator stub focusing on division by zero detection.
 * Returns an error object with code 'DIV_ZERO' when a division by zero is detected.
 * For other expressions, returns a placeholder result (NaN).
 */
export function evaluate(expression: string): EvalResult {
  // Detect division by zero (e.g., "/0" possibly with spaces) not followed by another digit
  const divZeroPattern = /\/\s*0(?!\d)/;
  if (divZeroPattern.test(expression)) {
    return {
      error: {
        code: 'DIV_ZERO',
        message: 'Cannot divide by zero',
      },
    };
  }
  // Placeholder for other evaluations
  return { result: NaN };
}
