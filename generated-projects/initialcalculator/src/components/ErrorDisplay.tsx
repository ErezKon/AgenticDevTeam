import React from 'react';
import { memo } from 'react';

export interface ErrorDisplayProps {
  /**
   * Optional error message to display. When undefined, null, empty string, or a non‑string value is provided, the component renders nothing.
   */
  error?: string;
}

/**
 * Displays an error message from the calculator engine.
 * Uses role="alert" for accessibility.
 */
/**
 * ErrorDisplay component renders an accessible error message when provided.
 * It uses a <div> with role="alert" and aria-live="assertive" to announce errors.
 * The error prop is optional; if it is undefined, null, an empty string, or not a string,
 * the component renders nothing.
 */
export const ErrorDisplay: React.FC<ErrorDisplayProps> = memo(function ErrorDisplay({ error }) {
  if (!error || typeof error !== 'string') {
    return null;
  }
  return (
    <div role="alert" aria-live="assertive" aria-label="Error" style={{ marginTop: '1rem', color: 'red' }}>
      <p>{error}</p>
    </div>
  );
});

export default ErrorDisplay;
