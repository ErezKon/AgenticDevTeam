import React, { useState, KeyboardEvent, ChangeEvent } from 'react';
import { evaluate, EvalResult } from './evaluator';

export const App: React.FC = () => {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string>('');

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setExpression(e.target.value);
    // clear previous result/error on new input
    setResult(null);
    setError('');
  };

  const evaluateExpression = () => {
    const evalResult: EvalResult = evaluate(expression);
    if ('result' in evalResult) {
      setResult(evalResult.result);
      setError('');
    } else {
      setResult(null);
      setError(evalResult.error.message);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      evaluateExpression();
    }
  };

  return (
    <div style={{ padding: '1rem', fontFamily: 'sans-serif' }}>
      <h1>Simple Calculator</h1>
      <div>
        <label htmlFor="expr-input">Expression:</label>
        <input
          id="expr-input"
          type="text"
          value={expression}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-label="Expression input"
        />
        <button onClick={evaluateExpression}>Evaluate</button>
      </div>
      <div>
        <strong>Current expression:</strong> {expression}
      </div>
      {result !== null && (
        <div data-testid="result">Result: {result}</div>
      )}
      {error && (
        <div data-testid="error" style={{ color: 'red' }}>
          Error: {error}
        </div>
      )}
    </div>
  );
};
