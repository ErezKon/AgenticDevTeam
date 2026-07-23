import React from 'react';

type ExpressionDisplayProps = {
  /**
   * The arithmetic expression to display.
   */
  expression: string;
};

/**
 * ExpressionDisplay renders the current arithmetic expression inside a styled container.
 * It updates automatically when the `expression` prop changes.
 */
const ExpressionDisplay: React.FC<ExpressionDisplayProps> = ({ expression }) => {
  return (
    <div className="expression-display" data-testid="expression-display">
      {expression}
    </div>
  );
};

export default ExpressionDisplay;
