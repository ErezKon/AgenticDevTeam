import React, { useState, KeyboardEvent, FormEvent } from 'react';

const evaluateExpression = (expr: string): number => {
  // Simple safe evaluation using Function constructor
  // This is only for demonstration/testing purposes.
  // In production a proper parser would be used.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${expr})`);
  return fn();
};

export const Calculator: React.FC = () => {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');

  const clearAll = () => {
    setExpression('');
    setResult('');
    setError('');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!expression.trim()) {
      setResult('');
      setError('');
      return;
    }
    try {
      // Simple division by zero detection
      if (/\/0(?!\d)/.test(expression)) {
        throw { code: 'DIV_ZERO' };
      }
      const value = evaluateExpression(expression);
      setResult(value.toString());
      setError('');
    } catch (err: any) {
      if (err.code === 'DIV_ZERO') {
        setError('Cannot divide by zero');
      } else {
        setError('Syntax error: unexpected token');
      }
      setResult('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      clearAll();
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <label htmlFor="expr-input">Expression</label>
        <input
          id="expr-input"
          aria-label="Expression Input"
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
        <button type="submit">Evaluate</button>
        <button type="button" onClick={clearAll}>Clear</button>
      </form>
      <div data-testid="expression-display">{expression}</div>
      <div data-testid="result-display">{result}</div>
      <div data-testid="error-display">{error}</div>
    </div>
  );
};

export default Calculator;
