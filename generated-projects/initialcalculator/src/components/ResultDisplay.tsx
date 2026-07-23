import React, { memo } from 'react';

export interface ResultDisplayProps {
  result: number;
}

/**
 * Displays the evaluated result of the expression.
 * Uses aria-label for accessibility.
 */
const ResultDisplay: React.FC<ResultDisplayProps> = memo(function ResultDisplay({ result }) {
  return (
    <div aria-label="Result" style={{ marginTop: '1rem', color: 'green' }}>
      Result: {result}
    </div>
  );
});

export default ResultDisplay;
