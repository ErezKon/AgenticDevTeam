import { render, screen, fireEvent } from '@testing-library/react';
import CalculatorApp from './CalculatorApp';

describe('CalculatorApp component', () => {
  test('renders input field with correct ARIA label', () => {
    render(<CalculatorApp />);
    const input = screen.getByLabelText(/expression input/i);
    expect(input).toBeInTheDocument();
  });

  test('evaluates a valid expression and displays result', () => {
    render(<CalculatorApp />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2+2' } });
    const result = screen.getByLabelText(/result/i);
    expect(result).toHaveTextContent('Result: 4');
  });

  test('shows error message for division by zero', () => {
    render(<CalculatorApp />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5/0' } });
    const error = screen.getByLabelText(/error/i);
    expect(error).toHaveTextContent('Division by zero');
  });

  test('error disappears when expression becomes valid', () => {
    render(<CalculatorApp />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    // Trigger error
    fireEvent.change(input, { target: { value: '5/0' } });
    expect(screen.getByLabelText(/error/i)).toBeInTheDocument();
    // Correct expression
    fireEvent.change(input, { target: { value: '5/1' } });
    expect(screen.queryByLabelText(/error/i)).not.toBeInTheDocument();
    const result = screen.getByLabelText(/result/i);
    expect(result).toHaveTextContent('Result: 5');
  });

  test('handles malformed expressions with appropriate error', () => {
    render(<CalculatorApp />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    // Consecutive operators
    fireEvent.change(input, { target: { value: '2++2' } });
    expect(screen.getByLabelText(/error/i)).toHaveTextContent('Invalid syntax');
    // Non‑numeric characters
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(screen.getByLabelText(/error/i)).toHaveTextContent('Invalid syntax');
    // Excessively long string
    const longExpr = '1+'.repeat(101); // length > 100
    fireEvent.change(input, { target: { value: longExpr } });
    expect(screen.getByLabelText(/error/i)).toHaveTextContent('Expression too long');
  });

  test('floating‑point precision is rounded correctly', () => {
    render(<CalculatorApp />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.1+0.2' } });
    const result = screen.getByLabelText(/result/i);
    // Expected result is 0.3 after rounding to 10 decimal places
    expect(result).toHaveTextContent('Result: 0.3');
  });
});
