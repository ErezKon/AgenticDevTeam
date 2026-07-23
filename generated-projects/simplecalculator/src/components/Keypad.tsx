import React from 'react';
import { Button } from './Button';

type KeypadProps = {
  /**
   * Callback invoked when any keypad button is pressed.
   * Receives the button's value (e.g., "1", "+", "C", "=").
   */
  onButtonPress: (value: string) => void;
};

/**
 * Calculator keypad component.
 * Renders a grid of buttons for digits, operators, parentheses, decimal point,
 * clear (C) and equals (=). Each button forwards its value to `onButtonPress`.
 */
export const Keypad: React.FC<KeypadProps> = ({ onButtonPress }) => {
  // Define button layout rows for readability.
  const rows: Array<Array<{ label: string; value?: string }>> = [
    // First row: clear, parentheses, division
    [
      { label: 'C', value: 'C' },
      { label: '(', value: '(' },
      { label: ')', value: ')' },
      { label: '/', value: '/' },
    ],
    // Second row: digits 7-9 and multiplication
    [
      { label: '7' },
      { label: '8' },
      { label: '9' },
      { label: '*', value: '*' },
    ],
    // Third row: digits 4-6 and subtraction
    [
      { label: '4' },
      { label: '5' },
      { label: '6' },
      { label: '-', value: '-' },
    ],
    // Fourth row: digits 1-3 and addition
    [
      { label: '1' },
      { label: '2' },
      { label: '3' },
      { label: '+', value: '+' },
    ],
    // Fifth row: 0, decimal, equals
    [
      { label: '0' },
      { label: '.', value: '.' },
      { label: '=', value: '=' },
    ],
  ];

  return (
    <div className="keypad" data-testid="keypad">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="keypad-row" style={{ display: 'flex' }}>
          {row.map((btn, colIndex) => (
            <Button
              key={colIndex}
              label={btn.label}
              value={btn.value}
              onPress={onButtonPress}
              className="keypad-button"
            />
          ))}
        </div>
      ))}
    </div>
  );
};
