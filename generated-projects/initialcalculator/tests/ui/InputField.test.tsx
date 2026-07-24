import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { InputField } from '../../src/components/InputField';

describe('UI Component - InputField', () => {
  test('Accepts any string characters and updates internal state on each keystroke.', () => {
    const handleChange = jest.fn();
    const { getByLabelText } = render(
      <InputField value="" onChange={handleChange} />
    );
    const input = getByLabelText('Calculator input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '123' } });
    expect(handleChange).toHaveBeenCalledWith('123');
  });

  test('Is focusable via keyboard (tab navigation) and has appropriate ARIA label "Calculator input".', () => {
    const { getByLabelText } = render(
      <InputField value="" onChange={() => {}} />
    );
    const input = getByLabelText('Calculator input') as HTMLInputElement;
    expect(input).toHaveAttribute('aria-label', 'Calculator input');
    // Simulate tab focus
    input.focus();
    expect(document.activeElement).toBe(input);
  });
});
