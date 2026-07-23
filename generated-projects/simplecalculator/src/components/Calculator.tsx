import React, { useState, KeyboardEvent, ChangeEvent } from 'react';

// Simple evaluator placeholder – in real app this would import the expression evaluator module
function evaluateExpression(expr: string): { result?: number; error?: { code: string; message: string } } {
  try {
    // Using Function constructor for quick evaluation (not safe for production)
    // In the actual project, replace with proper parser/evaluator.
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${expr})`);
    const value = fn();
    if (typeof value === 'number' && isFinite(value)) {
      return { result: value };
    }
    return { error: { code: 'EVAL_ERROR', message: 'Invalid result' } };
  } catch (e: any) {
    if (e instanceof SyntaxError) {
      return { error: { code: 'SYNTAX_ERROR', message: 'Syntax error' } };
    }
    if (e.message?.includes('divide by zero')) {
      return { error: { code: 'DIV_ZERO', message: 'Cannot divide by zero' } };
    }
    return { error: { code: 'UNKNOWN', message: e.message || 'Evaluation error' } };
  }
}

export const Calculator: React.FC = () => {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow only digits, operators, parentheses, decimal point, and minus sign
    if (/^[0-9+\-*/().\s]*$/.test(value)) {
      setExpression(value);
      setError('');
    } else {
      setError('Invalid characters');
    }
  };

  const evaluate = () => {
    if (!expression.trim()) {
      setError('Expression is empty');
      setResult('');
      return;
    }
    const evalResult = evaluateExpression(expression);
    if (evalResult.error) {
      setError(evalResult.error.message);
      setResult('');
    } else if (evalResult.result !== undefined) {
      setResult(evalResult.result.toFixed(10).replace(/\.?(0)+$/, ''));
      setError('');
    }
  };

  const clear = () => {
    setExpression('');
    setResult('');
    setError('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      evaluate();
    } else if (e.key === 'Escape') {
      clear();
    }
  };

  return (
    <div>
      <label htmlFor="calc-input" style={{ display: 'none' }}>Expression</label>
      <input
        id="calc-input"
        type="text"
        value={expression}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        aria-label="Expression input"
        placeholder="Enter expression"
      />
      <button onClick={evaluate} aria-label="Evaluate expression">Evaluate</button>
      <button onClick={clear} aria-label="Clear calculator">Clear</button>
      <div aria-label="Result" role="status">
        {error ? <span style={{ color: 'red' }}>{error}</span> : result && <span>{result}</span>}
      </div>
    </div>
  );
};
