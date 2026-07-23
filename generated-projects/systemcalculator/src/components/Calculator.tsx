import React, { useState } from 'react';
import { evaluate } from 'mathjs';

interface CalculatorProps {}

const BUTTONS = [
  '7', '8', '9', '/',
  '4', '5', '6', '*',
  '1', '2', '3', '-',
  '0', '.', '=', '+',
];

export const Calculator: React.FC<CalculatorProps> = () => {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = (value: string) => {
    if (error) {
      // clear previous error on any new input
      setError(null);
    }
    if (value === '=') {
      // Simple validation for consecutive operators (basic syntax check)
      const invalidPattern = /[+\-*/]{2,}/;
      if (invalidPattern.test(expression)) {
        setError('Invalid syntax');
        setResult(null);
        return;
      }
      try {
        // mathjs evaluate can handle empty string, but we guard
        const evalResult = evaluate(expression);
        // Detect division by zero resulting in Infinity
        if (typeof evalResult === 'number' && !Number.isFinite(evalResult)) {
          setError('Cannot divide by zero');
          setResult(null);
          setExpression('');
          return;
        }
        setResult(String(evalResult));
        setExpression(String(evalResult)); // allow chaining
      } catch (e: any) {
        // map some common errors to friendly messages
        const msg = e?.message?.includes('divide by zero')
          ? 'Cannot divide by zero'
          : 'Invalid syntax';
        setError(msg);
        setResult(null);
      }
    } else {
      // Append button value to expression (except when it's = which is handled above)
      setExpression(prev => prev + value);
      setResult(null);
    }
  };

  return (
    <div className="calculator" style={{ maxWidth: '300px', margin: '0 auto' }}>
      <div data-testid="display" className="display" style={{ minHeight: '2rem', border: '1px solid #ccc', padding: '0.5rem', marginBottom: '0.5rem' }}>
        {result !== null ? result : expression || '0'}
      </div>
      <div data-testid="error" className="error" style={{ color: 'red', marginBottom: '0.5rem', display: error ? 'block' : 'none' }}>
        {error}
      </div>
      <div className="keypad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
        {BUTTONS.map(btn => (
          <button
            key={btn}
            data-testid={`btn-${btn}`}
            onClick={() => handleClick(btn)}
            style={{ padding: '1rem', fontSize: '1rem' }}
          >
            {btn}
          </button>
        ))}
      </div>
    </div>
  );
};

export default Calculator;
