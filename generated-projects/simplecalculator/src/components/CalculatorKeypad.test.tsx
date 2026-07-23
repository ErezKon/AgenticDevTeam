import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CalculatorKeypad from './CalculatorKeypad';

describe('CalculatorKeypad', () => {
  const onKeyPressMock = jest.fn();

  beforeEach(() => {
    onKeyPressMock.mockClear();
    render(<CalculatorKeypad onKeyPress={onKeyPressMock} />);
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

  it('calls onKeyPress with correct value when a button is clicked', () => {
    const button = screen.getByTestId('key-5');
    fireEvent.click(button);
    expect(onKeyPressMock).toHaveBeenCalledTimes(1);
    expect(onKeyPressMock).toHaveBeenCalledWith('5');
  });

  it('calls onKeyPress with "C" when Clear button is clicked', () => {
    const clearButton = screen.getByTestId('key-C');
    fireEvent.click(clearButton);
    expect(onKeyPressMock).toHaveBeenCalledWith('C');
  });
});
