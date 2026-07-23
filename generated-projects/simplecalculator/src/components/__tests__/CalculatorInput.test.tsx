import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CalculatorInput } from '../CalculatorInput';

describe('CalculatorInput component', () => {
  test('renders with provided value', () => {
    render(
      <CalculatorInput value="2+2" onChange={() => {}} />
    );
    const input = screen.getByLabelText('Calculator input') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('2+2');
  });

  test('calls onChange with valid input', () => {
    const handleChange = jest.fn();
    render(<CalculatorInput value="" onChange={handleChange} />);
    const input = screen.getByLabelText('Calculator input');
    fireEvent.change(input, { target: { value: '12+3' } });
    expect(handleChange).toHaveBeenCalledWith('12+3');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('shows error and does not call onChange for invalid characters', () => {
    const handleChange = jest.fn();
    render(<CalculatorInput value="" onChange={handleChange} />);
    const input = screen.getByLabelText('Calculator input');
    fireEvent.change(input, { target: { value: '2+2a' } });
    expect(handleChange).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Invalid character entered');
  });

  test('calls onSubmit when Enter key is pressed', () => {
    const handleSubmit = jest.fn();
    render(
      <CalculatorInput value="1+1" onChange={() => {}} onSubmit={handleSubmit} />
    );
    const input = screen.getByLabelText('Calculator input');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(handleSubmit).toHaveBeenCalled();
  });

  test('clears input and error on Escape key', () => {
    const handleChange = jest.fn();
    render(
      <CalculatorInput value="123" onChange={handleChange} />
    );
    const input = screen.getByLabelText('Calculator input');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(handleChange).toHaveBeenCalledWith('');
    // error should be cleared; ensure no alert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
