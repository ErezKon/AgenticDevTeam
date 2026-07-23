import React, { useState, KeyboardEvent, ChangeEvent } from 'react';
import { evaluateExpression, EvalResult } from './evaluator';

export const Calculator: React.FC = () => {
  const [input, setInput] = useState('');
  const [display, setDisplay] = useState(''); // mirrors input
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow only digits, operators, parentheses, decimal point, minus sign
    if (/^[0-9+\-*/().\s]*$/.test(value)) {
      setInput(value);
      setDisplay(value);
      // clear previous result/error while typing
      setResult('');
      setError('');
    }
  };

  const evaluate = () => {
    const trimmed = input.trim();
    if (trimmed === '') {
      setError('Expression cannot be empty');
      setResult('');
      return;
    }
    const evalResult: EvalResult = evaluateExpression(trimmed);
    if (evalResult.error) {
      setError(evalResult.error.message);
      setResult('');
    } else if (typeof evalResult.result === 'number') {
      setResult(evalResult.result.toString());
      setError('');
    }
  };

  const clear = () => {
    setInput('');
    setDisplay('');
    setResult('');
    setError('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      evaluate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clear();
    }
  };

  return (
    <div className="calculator" style={{ maxWidth: '400px', margin: '0 auto' }}>
      <label htmlFor="calc-input" className="sr-only">
        Expression input
      </label>
      <input
        id="calc-input"
        type="text"
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        aria-label="Expression input"
        style={{ width: '100%', padding: '8px', fontSize: '1rem' }}
      />
      <div
        aria-live="polite"
        style={{ marginTop: '8px', minHeight: '1.5rem', fontFamily: 'monospace' }}
      >
        {display}
      </div>
      <div style={{ marginTop: '8px' }}>
        <button
          type="button"
          onClick={evaluate}
          aria-label="Evaluate expression"
          style={{ marginRight: '8px' }}
        >
          Evaluate
        </button>
        <button type="button" onClick={clear} aria-label="Clear calculator">
          Clear
        </button>
      </div>
      {result && (
        <div role="status" style={{ marginTop: '8px', color: 'green' }}>
          Result: {result}
        </div>
      )}
      {error && (
        <div role="alert" style={{ marginTop: '8px', color: 'red' }}>
          {error}
        </div>
      )}
    </div>
  );
};
