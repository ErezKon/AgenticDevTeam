import React, { useState } from 'react';

/**
 * Simple Calculator component.
 * Renders a display area showing the current expression and a keypad of buttons.
 * Clicking a button appends its value to the expression string.
 */
const Calculator: React.FC = () => {
  const [expression, setExpression] = useState<string>('');

  const handleButtonClick = (value: string) => {
    setExpression((prev) => prev + value);
  };

  // Define the buttons to render. Order is not critical for tests.
  const buttons: string[] = [
    '7', '8', '9', '/',
    '4', '5', '6', '*',
    '1', '2', '3', '-',
    '0', '.', '=', '+',
  ];

  return (
    <div className="calculator" style={{ maxWidth: '300px', margin: '0 auto' }}>
      {/* Display */}
      <div
        data-testid="display"
        aria-label="calculator display"
        style={{
          minHeight: '2rem',
          border: '1px solid #ccc',
          padding: '0.5rem',
          marginBottom: '1rem',
          fontSize: '1.5rem',
          textAlign: 'right',
          backgroundColor: '#f9f9f9',
        }}
      >
        {expression}
      </div>

      {/* Keypad */}
      <div
        className="keypad"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '0.5rem',
        }}
      >
        {buttons.map((btn) => (
          <button
            key={btn}
            type="button"
            onClick={() => handleButtonClick(btn)}
            style={{
              padding: '1rem',
              fontSize: '1.2rem',
            }}
          >
            {btn}
          </button>
        ))}
      </div>
    </div>
  );
};

export default Calculator;
