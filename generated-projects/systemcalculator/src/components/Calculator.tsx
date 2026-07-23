import React, { useState } from 'react';
import './Calculator.css';

const buttons = [
  '7','8','9','/',
  '4','5','6','*',
  '1','2','3','-',
  '0','.','=','+',
];

export const Calculator: React.FC = () => {
  const [expression, setExpression] = useState('');
  const handleClick = (value: string) => {
    if (value === '=') {
      // evaluation handled elsewhere; placeholder
      return;
    }
    setExpression(prev => prev + value);
  };

  return (
    <div className="calculator">
      <div className="display" data-testid="display">{expression}</div>
      <div className="keypad" data-testid="keypad">
        {buttons.map(btn => (
          <button
            key={btn}
            className="key"
            onClick={() => handleClick(btn)}
            aria-label={btn}
          >
            {btn}
          </button>
        ))}
      </div>
    </div>
  );
};

export default Calculator;
