import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExpressionDisplay from './ExpressionDisplay';

describe('ExpressionDisplay component', () => {
  it('renders the provided expression', () => {
    const expr = '2+3*4';
    render(<ExpressionDisplay expression={expr} />);
    const display = screen.getByTestId('expression-display');
    expect(display).toBeInTheDocument();
    expect(display).toHaveTextContent(expr);
  });

  it('updates when expression prop changes', () => {
    const { rerender } = render(<ExpressionDisplay expression="1+1" />);
    const display = screen.getByTestId('expression-display');
    expect(display).toHaveTextContent('1+1');
    rerender(<ExpressionDisplay expression="5-2" />);
    expect(display).toHaveTextContent('5-2');
  });
});
