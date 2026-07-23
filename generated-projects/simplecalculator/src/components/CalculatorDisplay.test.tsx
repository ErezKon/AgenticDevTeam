import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import CalculatorDisplay from './CalculatorDisplay';

describe('CalculatorDisplay', () => {
  test('renders the current expression', () => {
    render(<CalculatorDisplay expression="3+4*2" result={null} />);
    const exprEl = screen.getByTestId('expression-display');
    expect(exprEl).toBeInTheDocument();
    expect(exprEl).toHaveTextContent('3+4*2');
  });

  test('renders the numeric result when provided', () => {
    render(<CalculatorDisplay expression="3+4" result={7} />);
    const resultEl = screen.getByTestId('result-display');
    expect(resultEl).toBeInTheDocument();
    expect(resultEl).toHaveTextContent('7');
  });

  test('renders an error message when result is a string', () => {
    render(
      <CalculatorDisplay expression="3+" result="Error: Invalid expression" />
    );
    const resultEl = screen.getByTestId('result-display');
    expect(resultEl).toBeInTheDocument();
    expect(resultEl).toHaveTextContent('Error: Invalid expression');
  });
});
