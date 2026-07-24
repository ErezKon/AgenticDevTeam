// Integration tests for UI ↔ Engine interaction
import React, { useState } from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { evaluate } from '../../src/engine/evaluate';
import { InputField } from '../../src/components/InputField';

// Simple ResultDisplay component used only for testing
const ResultDisplay: React.FC<{ result?: number }> = ({ result }) => (
  <div data-testid="result">{result !== undefined ? result : ''}</div>
);

// Simple ErrorMessage component used only for testing
const ErrorMessage: React.FC<{ error?: string }> = ({ error }) => (
  <div data-testid="error">{error || ''}</div>
);

// Test harness component that ties InputField to the engine
const CalculatorTestApp: React.FC = () => {
  const [expr, setExpr] = useState('');
  const [output, setOutput] = useState<{ result?: number; error?: string }>({});

  const handleChange = (value: string) => {
    setExpr(value);
    const evalResult = evaluate(value);
    setOutput(evalResult);
  };

  return (
    <div>
      <InputField value={expr} onChange={handleChange} />
      <ResultDisplay result={output.result} />
      <ErrorMessage error={output.error} />
    </div>
  );
};

describe('UI Component ↔ Calculator Engine interaction', () => {
  test('Typing a valid expression triggers evaluate and updates the result area within 100 ms.', async () => {
    const { getByLabelText, getByTestId } = render(<CalculatorTestApp />);
    const input = getByLabelText('Calculator input') as HTMLInputElement;
    const start = performance.now();
    fireEvent.change(input, { target: { value: '2+3*4' } });
    await waitFor(() => expect(getByTestId('result')).toHaveTextContent('14'));
    const duration = performance.now() - start;
    expect(duration).toBeLessThanOrEqual(100);
  });

  test('When evaluate returns an error, the UI displays the exact error message.', async () => {
    const { getByLabelText, getByTestId } = render(<CalculatorTestApp />);
    const input = getByLabelText('Calculator input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5/0' } });
    await waitFor(() => expect(getByTestId('error')).toHaveTextContent('Division by zero'));
  });

  test('Error message is cleared automatically after the user corrects the expression to a valid one.', async () => {
    const { getByLabelText, getByTestId } = render(<CalculatorTestApp />);
    const input = getByLabelText('Calculator input') as HTMLInputElement;
    // cause error
    fireEvent.change(input, { target: { value: '5/0' } });
    await waitFor(() => expect(getByTestId('error')).toHaveTextContent('Division by zero'));
    // correct expression
    fireEvent.change(input, { target: { value: '5/1' } });
    await waitFor(() => expect(getByTestId('error')).toHaveTextContent(''));
    await waitFor(() => expect(getByTestId('result')).toHaveTextContent('5'));
  });
});
