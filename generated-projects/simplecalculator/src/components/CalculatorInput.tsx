import React, { ChangeEvent, KeyboardEvent, useState } from 'react';

export interface CalculatorInputProps {
  /**
   * Current value of the input. The component is controlled, so the parent must pass the value.
   */
  value: string;
  /**
   * Called when the user types a valid character sequence.
   */
  onChange: (newValue: string) => void;
  /**
   * Called when the user submits the expression (e.g., presses Enter).
   */
  onSubmit?: () => void;
}

/**
 * Regex that matches only allowed characters for the calculator input.
 * Digits, decimal point, plus, minus, multiply, divide, parentheses, and whitespace.
 */
const VALID_INPUT_REGEX = /^[0-9+\-*/().\s]*$/;

export const CalculatorInput: React.FC<CalculatorInputProps> = ({
  value,
  onChange,
  onSubmit,
}) => {
  const [error, setError] = useState<string>('');

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    if (VALID_INPUT_REGEX.test(newVal)) {
      setError('');
      onChange(newVal);
    } else {
      // Keep the previous valid value and show an error.
      setError('Invalid character entered');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (onSubmit) {
        onSubmit();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Clear the input on Escape.
      setError('');
      onChange('');
    }
  };

  return (
    <div>
      <input
        type="text"
        aria-label="Calculator input"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Enter expression"
      />
      {error && (
        <div role="alert" style={{ color: 'red' }}>
          {error}
        </div>
      )}
    </div>
  );
};
