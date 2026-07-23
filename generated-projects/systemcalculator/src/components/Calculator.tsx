import React from 'react';
import Display from './Display';
import Keypad from './Keypad';

/**
 * Calculator component – UI skeleton that composes the display and keypad.
 */
const Calculator: React.FC = () => {
  return (
    <div data-testid="calculator" className="calculator-container">
      <Display />
      <Keypad />
    </div>
  );
};

export default Calculator;
