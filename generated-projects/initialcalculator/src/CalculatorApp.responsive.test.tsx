import React from 'react';
import { render, screen } from '@testing-library/react';
import CalculatorApp from './CalculatorApp';

test('CalculatorApp container is rendered with test-id', () => {
  render(<CalculatorApp />);
  const container = screen.getByTestId('calculator-container');
  expect(container).toBeInTheDocument();
});
