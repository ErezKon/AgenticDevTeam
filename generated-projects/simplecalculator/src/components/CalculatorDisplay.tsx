import React from 'react';

/**
 * Props for the CalculatorDisplay component.
 * - `expression`: the current arithmetic expression entered by the user.
 * - `result`: the evaluated result of the expression, which can be a number,
 *   an error message string, or null when no result is available yet.
 */
interface CalculatorDisplayProps {
  expression: string;
  /**
   * Numeric result, error string, or null if not evaluated yet.
   */
  result: number | string | null;
}

/**
 * CalculatorDisplay renders the current expression and the result (or error).
 * It uses `data-testid` attributes to make testing straightforward.
 */
const CalculatorDisplay: React.FC<CalculatorDisplayProps> = ({
  expression,
  result,
}) => {
  return (
    <div className="calculator-display">
      <div data-testid="expression-display" aria-label="Expression">
        {expression}
      </div>
      <div data-testid="result-display" aria-label="Result">
        {result !== null && result !== undefined ? result : ''}
      </div>
    </div>
  );
};

export default CalculatorDisplay;
