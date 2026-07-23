import React, { useState } from 'react';
import { parseExpression } from '../utils/expressionParser';
import { formatError } from '../utils/errorHandler';

/**
 * Simple calculator UI.
 * - Displays the current expression or result.
 * - Provides a keypad with digits, basic operators and an "=" button.
 * - On "=" evaluates the expression using parseExpression.
 *   Successful evaluation replaces the display with the numeric result.
 *   Errors are passed through formatError and the friendly message is shown.
 */
export const Calculator: React.FC = () => {
  const [display, setDisplay] = useState<string>('');
  const expressionRef = React.useRef<string>('');

  const handleButtonClick = (value: string) => {
    if (value === '=') {
      console.log('expression before parse', expressionRef.current);
      try {
        const result = parseExpression(expressionRef.current);
        console.log('parse result', result);
        setDisplay(String(result));
        // Reset expression after evaluation
        expressionRef.current = String(result);
      } catch (err) {
        console.error('parse error', err);
        const message = formatError(err as Error);
        setDisplay(message);
        // Reset expression to empty on error
        expressionRef.current = '';
      }
    } else if (value === 'C') {
      setDisplay('');
      expressionRef.current = '';
    } else {
      // Update ref immediately
      console.log('button', value, 'updating ref to', expressionRef.current + value);
      expressionRef.current = expressionRef.current + value;
      setDisplay((prev) => prev + value);
    }
  };

  const buttons: string[] = [
    '7', '8', '9', '/',
    '4', '5', '6', '*',
    '1', '2', '3', '-',
    '0', '.', '=', '+',
    'C',
  ];

  return (
    <div className="calculator" style={{ maxWidth: '200px', margin: '0 auto' }}>
      <div
        data-testid="display"
        className="calculator-display"
        style={{
          border: '1px solid #ccc',
          padding: '10px',
          minHeight: '40px',
          marginBottom: '10px',
          textAlign: 'right',
          fontSize: '1.2rem',
        }}
      >
        {display}
      </div>
      <div className="calculator-keypad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '5px' }}>
        {buttons.map((btn) => (
          <button
            key={btn}
            type="button"
            onClick={() => handleButtonClick(btn)}
            data-testid={`btn-${btn}`}
            style={{ padding: '10px', fontSize: '1rem' }}
          >
            {btn}
          </button>
        ))}
      </div>
    </div>
  );
};
