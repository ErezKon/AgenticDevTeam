import React, { ChangeEvent, memo, forwardRef, InputHTMLAttributes } from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Optional callback when Enter is pressed */
  onEnter?: () => void;
}

/**
 * Input component for entering arithmetic expressions.
 * Uses a label for accessibility and forwards changes via onChange.
 */
const Input = memo(forwardRef<HTMLInputElement, InputProps>(function Input({ value, onChange, onKeyDown, onEnter }, ref) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onEnter) {
      onEnter();
    }
    if (onKeyDown) {
      onKeyDown(e);
    }
  };

  return (
    <div>
      <label htmlFor="expression-input" style={{ display: 'block', marginBottom: '0.5rem' }}>
        Expression input
      </label>
      <input
        id="expression-input"
        ref={ref}
        type="text"
        aria-label="Calculator expression"
        placeholder="Enter expression"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
      />
    </div>
  );
});

export default Input;
