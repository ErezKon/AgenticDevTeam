import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import Display from './Display';

describe('Display component', () => {
  test('renders expression and result when no error', () => {
    render(<Display expression="2+3" result="5" />);
    const expr = screen.getByTestId('display-expression');
    const res = screen.getByTestId('display-result');
    expect(expr).toHaveTextContent('2+3');
    expect(res).toHaveTextContent('5');
    // error element should not be in the document
    expect(screen.queryByTestId('display-error')).not.toBeInTheDocument();
  });

  test('renders error message and hides expression/result', () => {
    render(<Display expression="2+" result="" error="Invalid syntax" />);
    const errorEl = screen.getByTestId('display-error');
    expect(errorEl).toHaveTextContent('Invalid syntax');
    // expression and result should not be rendered
    expect(screen.queryByTestId('display-expression')).not.toBeInTheDocument();
    expect(screen.queryByTestId('display-result')).not.toBeInTheDocument();
  });
});
