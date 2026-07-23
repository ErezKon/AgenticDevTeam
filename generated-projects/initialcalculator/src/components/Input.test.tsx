import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Input, { InputProps } from './Input';

describe('Input component', () => {
  test('renders with correct aria-label', () => {
    const handleChange = jest.fn();
    render(<Input value="" onChange={handleChange} />);
    const input = screen.getByLabelText('Calculator expression');
    expect(input).toBeInTheDocument();
  });

  test('calls onChange with updated value on each keystroke', () => {
    const handleChange = jest.fn();
    render(<Input value="" onChange={handleChange} />);
    const input = screen.getByLabelText('Calculator expression') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2' } });
    expect(handleChange).toHaveBeenLastCalledWith('2');
    fireEvent.change(input, { target: { value: '2+' } });
    expect(handleChange).toHaveBeenLastCalledWith('2+');
    fireEvent.change(input, { target: { value: '2+2' } });
    expect(handleChange).toHaveBeenLastCalledWith('2+2');
  });

  test('input is focusable via keyboard (tab)', () => {
    const handleChange = jest.fn();
    render(<Input value="" onChange={handleChange} />);
    const input = screen.getByLabelText('Calculator expression') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
  });
});
