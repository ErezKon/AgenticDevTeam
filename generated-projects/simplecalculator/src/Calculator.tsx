import React, { useState } from 'react';
import './Calculator.css';

const Calculator: React.FC = () => {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setExpression(e.target.value);
    // clear previous result/error on change
    setResult(null);
    setError(null);
  };

  const evaluate = () => {
    try {
      // Simple eval for placeholder; in real app use evaluator module
      // eslint-disable-next-line no-eval
      const evalResult = Function(`'use strict'; return (${expression})`)();
      setResult(String(evalResult));
      setError(null);
    } catch (e) {
      setError('Invalid expression');
      setResult(null);
    }
  };

  const clear = () => {
    setExpression('');
    setResult(null);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      evaluate();
    } else if (e.key === 'Escape') {
      clear();
    }
  };

  return (
    <div className="calculator">
      <input
        type="text"
        value={expression}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Enter expression"
        aria-label="Expression input"
        className="expression-input"
      />
      <div className="button-group">
        <button onClick={evaluate} aria-label="Evaluate">
          Evaluate
        </button>
        <button onClick={clear} aria-label="Clear">
          Clear
        </button>
      </div>
      {result !== null && <div className="result" aria-label="Result">Result: {result}</div>}
      {error && <div className="error" aria-label="Error">Error: {error}</div>}
    </div>
  );
};

export default Calculator;
