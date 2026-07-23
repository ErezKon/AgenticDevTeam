import React, { ChangeEvent, memo } from 'react';

export interface InputProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Input component for entering arithmetic expressions.
 * Uses a label for accessibility and forwards changes via onChange.
 */
const Input: React.FC<InputProps> = memo(function Input({ value, onChange }) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  return (
    <div>
      <label htmlFor="expression-input" style={{ display: 'block', marginBottom: '0.5rem' }}>
        Expression input
      </label>
      <input
        id="expression-input"
        type="text"
        aria-label="Calculator expression"
        placeholder="Enter expression"
        value={value}
        onChange={handleChange}
        style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
      />
    </div>
  );
});

export default Input;
