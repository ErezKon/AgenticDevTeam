import { memo } from 'react';

export interface ResultDisplayProps {
  /**
   * The evaluated result of the expression.
   * If null, a placeholder is shown.
   */
  result: number | null;
}

/**
 * Displays the evaluated result of the expression.
 * Formats the number using locale string with up to 6 fraction digits.
 * Shows a placeholder ("—") when result is null or not a finite number.
 * Uses aria-label for accessibility.
 */
const ResultDisplay: React.FC<ResultDisplayProps> = memo(function ResultDisplay({ result }) {
  const displayValue =
    result !== null && Number.isFinite(result)
      ? result.toLocaleString(undefined, { maximumFractionDigits: 10 })
      : '—';

  return (
    <div aria-label="Result" style={{ marginTop: '1rem', color: 'green' }}>
      Result: {displayValue}
    </div>
  );
});

export default ResultDisplay;
