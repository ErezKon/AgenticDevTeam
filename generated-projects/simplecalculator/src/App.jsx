import React, { useState } from 'react';
import './styles.css';

const buttons = [
  '7','8','9','/',
  '4','5','6','*',
  '1','2','3','-',
  '0','.','=', '+',
  'C','(',')','⌫'
];

export default function App() {
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  const handleClick = (value) => {
    // Simplified handling for demo purposes
    if (value === 'C') {
      setExpression('');
      setResult('');
      setError('');
    } else if (value === '=') {
      // placeholder evaluation
      try {
        // eslint-disable-next-line no-eval
        const evalResult = eval(expression);
        setResult(evalResult);
        setError('');
      } catch (e) {
        setError('Invalid expression');
        setResult('');
      }
    } else if (value === '⌫') {
      setExpression(prev => prev.slice(0, -1));
    } else {
      setExpression(prev => prev + value);
    }
  };

  return (
    <div className="calculator">
      <div className="display" aria-label="calculator display">
        <div className="expression" data-testid="expression">{expression}</div>
        {error ? (
          <div className="error" data-testid="error">{error}</div>
        ) : (
          <div className="result" data-testid="result">{result}</div>
        )}
      </div>
      <div className="keypad" role="grid">
        {buttons.map((btn) => (
          <button
            key={btn}
            onClick={() => handleClick(btn)}
            aria-label={btn}
            className="key"
          >
            {btn}
          </button>
        ))}
      </div>
    </div>
  );
}
