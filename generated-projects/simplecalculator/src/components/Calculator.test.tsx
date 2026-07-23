import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Calculator } from './Calculator';

describe('Calculator ARIA labels', () => {
  test('input field has appropriate aria-label', () => {
    render(<Calculator />);
    const input = screen.getByLabelText(/Expression input/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'text');
  });

  test('evaluate button has appropriate aria-label', () => {
    render(<Calculator />);
    const button = screen.getByLabelText(/Evaluate expression/i);
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent(/Evaluate/i);
  });

  test('clear button has appropriate aria-label', () => {
    render(<Calculator />);
    const button = screen.getByLabelText(/Clear calculator/i);
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent(/Clear/i);
  });

  test('result area has appropriate aria-label', () => {
    render(<Calculator />);
    const resultDiv = screen.getByLabelText(/Result/i);
    expect(resultDiv).toBeInTheDocument();
    // Initially empty, but should have role status
    expect(resultDiv).toHaveAttribute('role', 'status');
  });
});
