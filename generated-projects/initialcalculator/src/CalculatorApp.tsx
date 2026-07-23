import { useState, ChangeEvent } from 'react';
import { evaluate, EvalResult } from './engine/evaluate';

// Input component
interface InputProps {
  value: string;
  onChange: (value: string) => void;
}
function Input({ value, onChange }: InputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };
  return (
    <input
      type="text"
      aria-label="Expression input"
      placeholder="Enter expression"
      value={value}
      onChange={handleChange}
      style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
    />
  );
}

// Result display component
interface ResultDisplayProps {
  result: number;
}
function ResultDisplay({ result }: ResultDisplayProps) {
  return (
    <div aria-label="Result" style={{ marginTop: '1rem', color: 'green' }}>
      Result: {result}
    </div>
  );
}

// Error display component
interface ErrorDisplayProps {
  error: string;
}
function ErrorDisplay({ error }: ErrorDisplayProps) {
  return (
    <div aria-label="Error" style={{ marginTop: '1rem', color: 'red' }}>
      {error}
    </div>
  );
}

// Main CalculatorApp component
export default function CalculatorApp() {
  const [expression, setExpression] = useState('');
  const evalResult: EvalResult = evaluate(expression);

  const hasError = 'error' in evalResult;

  return (
    <div style={{ maxWidth: '400px', margin: '2rem auto', padding: '1rem', border: '1px solid #ccc', borderRadius: '8px' }}>
      <h2>Calculator</h2>
      <Input value={expression} onChange={setExpression} />
      {hasError ? (
        <ErrorDisplay error={evalResult.error} />
      ) : (
        // Show result only when expression is non‑empty and valid
        expression.trim() !== '' && <ResultDisplay result={evalResult.result} />
      )}
    </div>
  );
}
