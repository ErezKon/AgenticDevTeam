import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import Display from './Display';

describe('Display component error styling', () => {
  test('applies error class when error prop is provided', () => {
    render(<Display expression="2+" result="" error="Invalid syntax" />);
    const errorEl = screen.getByTestId('display-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl).toHaveClass('error');
    // Ensure expression and result are not rendered
    expect(screen.queryByTestId('display-expression')).not.toBeInTheDocument();
    expect(screen.queryByTestId('display-result')).not.toBeInTheDocument();
  });
});
