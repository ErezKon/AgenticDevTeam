import React from 'react';

/**
 * Simple keypad component for the calculator.
 * Renders placeholder buttons for digits and basic operators.
 */
const buttons = [
  '7', '8', '9', '/',
  '4', '5', '6', '*',
  '1', '2', '3', '-',
  '0', '.', '=', '+',
];

const Keypad: React.FC = () => {
  return (
    <div data-testid="keypad" className="calculator-keypad">
      {buttons.map((label) => (
        <button
          key={label}
          data-testid={`button-${label}`}
          className="calc-button"
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default Keypad;
