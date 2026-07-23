import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CalculatorKeypad from './CalculatorKeypad';

describe('CalculatorKeypad', () => {
  // Helper wrapper component to manage expression state
  const Wrapper: React.FC = () => {
    const [expr, setExpr] = React.useState('');
    const handleKeyPress = (key: string) => {
      if (key === 'C') {
        setExpr('');
      } else if (key === '=') {
        // For test purposes, we just keep the expression unchanged
        // Evaluation is handled elsewhere
      } else {
        setExpr((prev) => prev + key);
      }
    };
    return (
      <div>
        <div data-testid="expression-display">{expr}</div>
        <CalculatorKeypad onKeyPress={handleKeyPress} />
      </div>
    );
  };

  // We'll render the Wrapper component which manages expression state
  beforeEach(() => {
    render(<Wrapper />);
  });

  it('renders all expected keys', () => {
    const expectedKeys = [
      '7','8','9','/','4','5','6','*','1','2','3','-','0','.','(',' )','C','=', '+'
    ];
    expectedKeys.forEach((key) => {
      const testId = `key-${key}`;
      const button = screen.getByTestId(testId);
      expect(button).toBeInTheDocument();
    });
  });

  it('updates expression display when a digit button is clicked', () => {
    const button = screen.getByTestId('key-5');
    fireEvent.click(button);
    const display = screen.getByTestId('expression-display');
    expect(display).toHaveTextContent('5');
  });

  it('clears expression display when Clear button is clicked', () => {
    // First add some characters
    fireEvent.click(screen.getByTestId('key-1'));
    fireEvent.click(screen.getByTestId('key-+'));
    fireEvent.click(screen.getByTestId('key-2'));
    const displayBefore = screen.getByTestId('expression-display');
    expect(displayBefore).toHaveTextContent('1+2');
    // Now clear
    fireEvent.click(screen.getByTestId('key-C'));
    const displayAfter = screen.getByTestId('expression-display');
    expect(displayAfter).toHaveTextContent('');
  });
});
