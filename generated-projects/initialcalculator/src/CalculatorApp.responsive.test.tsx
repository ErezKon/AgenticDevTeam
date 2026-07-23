import React from 'react';
import { render, screen } from '@testing-library/react';
import CalculatorApp from './CalculatorApp';

test('CalculatorApp container has responsive CSS class', () => {
  render(<CalculatorApp />);
  const container = screen.getByTestId('calculator-container');
  // The className should include the CSS module class 'container'
  expect(container.className).toMatch(/container/);
});
