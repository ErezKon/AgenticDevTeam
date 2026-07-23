import React from 'react';

/**
 * Props for the CalculatorKeypad component.
 * The parent component supplies an `onKeyPress` callback that receives the
 * string value of the pressed key (e.g., "1", "+", "C", "=").
 */
interface CalculatorKeypadProps {
  /**
   * Callback invoked when a keypad button is pressed.
   * @param key The string representation of the key.
   */
  onKeyPress: (key: string) => void;
}

/**
 * CalculatorKeypad renders all calculator keys as semantic <button> elements.
 * It is a pure presentational component – the parent handles state updates.
 */
const CalculatorKeypad: React.FC<CalculatorKeypadProps> = ({ onKeyPress }) => {
  // Keys are defined in the visual order they should appear.
  const keys: { label: string; value: string }[] = [
    // Row 1
    { label: '7', value: '7' },
    { label: '8', value: '8' },
    { label: '9', value: '9' },
    { label: '/', value: '/' },
    // Row 2
    { label: '4', value: '4' },
    { label: '5', value: '5' },
    { label: '6', value: '6' },
    { label: '*', value: '*' },
    // Row 3
    { label: '1', value: '1' },
    { label: '2', value: '2' },
    { label: '3', value: '3' },
    { label: '-', value: '-' },
    // Row 4
    { label: '0', value: '0' },
    { label: '.', value: '.' },
    { label: '(', value: '(' },
    { label: ')', value: ')' },
    // Row 5 – actions
    { label: 'Clear', value: 'C' },
    { label: '=', value: '=' },
    { label: '+', value: '+' },
  ];

  return (
    <div className="calculator-keypad" data-testid="calculator-keypad">
      {keys.map((key) => (
        <button
          key={key.value}
          type="button"
          onClick={() => onKeyPress(key.value)}
          data-testid={`key-${key.value}`}
          aria-label={key.label}
          className="calculator-key"
        >
          {key.label}
        </button>
      ))}
    </div>
  );
};

export default CalculatorKeypad;
