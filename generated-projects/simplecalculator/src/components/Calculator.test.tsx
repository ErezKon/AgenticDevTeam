import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { Calculator } from './Calculator';

describe('Calculator Clear functionality and shortcuts', () => {
  test('clicking Clear button resets expression, result and error displays', () => {
    render(<Calculator />);

    const input = screen.getByLabelText(/Expression Input/i) as HTMLInputElement;
    const evaluateBtn = screen.getByRole('button', { name: /evaluate/i });
    const clearBtn = screen.getByRole('button', { name: /clear/i });
    const expressionDisplay = screen.getByTestId('expression-display');
    const resultDisplay = screen.getByTestId('result-display');
    const errorDisplay = screen.getByTestId('error-display');

    // Enter a valid expression and evaluate
    fireEvent.change(input, { target: { value: '2+2' } });
    fireEvent.click(evaluateBtn);

    expect(expressionDisplay).toHaveTextContent('2+2');
    expect(resultDisplay).toHaveTextContent('4');
    expect(errorDisplay).toBeEmptyDOMElement();

    // Click Clear
    fireEvent.click(clearBtn);

    expect(input.value).toBe('');
    expect(expressionDisplay).toBeEmptyDOMElement();
    expect(resultDisplay).toBeEmptyDOMElement();
    expect(errorDisplay).toBeEmptyDOMElement();
  });

  test('pressing Escape key resets all UI state', () => {
    render(<Calculator />);

    const input = screen.getByLabelText(/Expression Input/i) as HTMLInputElement;
    const evaluateBtn = screen.getByRole('button', { name: /evaluate/i });
    const expressionDisplay = screen.getByTestId('expression-display');
    const resultDisplay = screen.getByTestId('result-display');
    const errorDisplay = screen.getByTestId('error-display');

    fireEvent.change(input, { target: { value: '10/2' } });
    fireEvent.click(evaluateBtn);

    expect(expressionDisplay).toHaveTextContent('10/2');
    expect(resultDisplay).toHaveTextContent('5');
    expect(errorDisplay).toBeEmptyDOMElement();

    // Trigger Escape key on the form (focus on input)
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });

    expect(input.value).toBe('');
    expect(expressionDisplay).toBeEmptyDOMElement();
    expect(resultDisplay).toBeEmptyDOMElement();
    expect(errorDisplay).toBeEmptyDOMElement();
  });
});
