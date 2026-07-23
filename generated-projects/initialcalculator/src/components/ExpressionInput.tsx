import React, { ChangeEvent, forwardRef, InputHTMLAttributes, memo } from 'react';

export interface ExpressionInputProps {
  /** Current value of the expression */
  value: string;
  /** Callback invoked on each change with the new string value */
  onChange: (value: string) => void;
  /** Optional placeholder */
  placeholder?: string;
  /** Optional callback invoked when user presses Enter */
  onEnter?: () => void;
  /** Optional key down handler for additional keyboard navigation */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Controlled input component for entering arithmetic expressions.
 * It forwards a ref to the underlying <input> element to allow parent
 * components to focus it programmatically.
 *
 * Accessibility:
 *  - `aria-label="Calculator expression"` provides a clear description for screen readers.
 *  - The input is associated with a visible <label> for keyboard navigation.
 */
const ExpressionInput = memo(
  forwardRef<HTMLInputElement, ExpressionInputProps>(function ExpressionInput(
    { value, onChange, placeholder = 'Enter expression', onEnter, onKeyDown },
    ref,
  ) {
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
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
        />
      </div>
    );
  },
),
);

export default ExpressionInput;
