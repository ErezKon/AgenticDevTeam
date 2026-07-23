import { render, screen } from '@testing-library/react';
import ResultDisplay from './ResultDisplay';

describe('ResultDisplay component', () => {
  test('renders the result correctly for integer values', () => {
    render(<ResultDisplay result={4} />);
    const resultDiv = screen.getByLabelText(/result/i);
    expect(resultDiv).toBeInTheDocument();
    expect(resultDiv).toHaveTextContent('Result: 4');
  });

  test('renders the result correctly for decimal values', () => {
    render(<ResultDisplay result={0.3} />);
    const resultDiv = screen.getByLabelText(/result/i);
    expect(resultDiv).toHaveTextContent('Result: 0.3');
  });

  test('renders placeholder for NaN and Infinity', () => {
    const { unmount: unmountNaN } = render(<ResultDisplay result={NaN} />);
    const resultDivNaN = screen.getByLabelText(/result/i);
    expect(resultDivNaN).toHaveTextContent('Result: —');
    unmountNaN();
    const { unmount: unmountInf } = render(<ResultDisplay result={Infinity} />);
    const resultDivInf = screen.getByLabelText(/result/i);
    expect(resultDivInf).toHaveTextContent('Result: —');
    unmountInf();
  });

  test('formats large numbers with commas', () => {
    render(<ResultDisplay result={1234567.89} />);
    const resultDiv = screen.getByLabelText(/result/i);
    // Expect locale formatting with commas
    expect(resultDiv).toHaveTextContent(/Result: 1,234,567\.89/);
  });

  test('updates instantly when the result prop changes', () => {
    const { rerender } = render(<ResultDisplay result={2} />);
    const resultDiv = screen.getByLabelText(/result/i);
    expect(resultDiv).toHaveTextContent('Result: 2');
    rerender(<ResultDisplay result={5} />);
    expect(resultDiv).toHaveTextContent('Result: 5');
  });
});
