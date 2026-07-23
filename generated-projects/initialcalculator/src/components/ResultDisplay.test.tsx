import { render, screen, rerender } from '@testing-library/react';
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

  test('updates instantly when the result prop changes', () => {
    const { rerender } = render(<ResultDisplay result={2} />);
    const resultDiv = screen.getByLabelText(/result/i);
    expect(resultDiv).toHaveTextContent('Result: 2');
    // Update prop
    rerender(<ResultDisplay result={5} />);
    expect(resultDiv).toHaveTextContent('Result: 5');
  });
});
