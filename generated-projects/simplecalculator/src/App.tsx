import React, { useState } from 'react';
import './App.css';

function App() {
  const [expr, setExpr] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setExpr(e.target.value);
    setError(null);
  };

  const evaluate = () => {
    // Placeholder: In real implementation, call evaluator module.
    try {
      // Simple eval using Function for placeholder (not secure).
      // eslint-disable-next-line no-new-func
      const evalResult = Function(`'use strict'; return (${expr})`)();
      setResult(String(evalResult));
    } catch (e) {
      setError('Invalid expression');
      setResult(null);
    }
  };

  const clear = () => {
    setExpr('');
    setResult(null);
    setError(null);
  };

  return (
    <div className="app">
      <h1>Simple Calculator</h1>
      <input
        type="text"
        value={expr}
        onChange={handleChange}
        placeholder="Enter expression"
        aria-label="Expression input"
      />
      <button onClick={evaluate}>Evaluate</button>
      <button onClick={clear}>Clear</button>
      {result !== null && <div className="result">Result: {result}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export default App;
