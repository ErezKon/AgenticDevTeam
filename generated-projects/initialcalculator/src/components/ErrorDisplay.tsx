import React, { memo } from 'react';

export interface ErrorDisplayProps {
  error: string;
}

/**
 * Displays an error message from the calculator engine.
 * Uses role="alert" for accessibility.
 */
const ErrorDisplay: React.FC<ErrorDisplayProps> = memo(function ErrorDisplay({ error }) {
  return (
    <div role="alert" aria-label="Error" style={{ marginTop: '1rem', color: 'red' }}>
      {error}
    </div>
  );
});

export default ErrorDisplay;
