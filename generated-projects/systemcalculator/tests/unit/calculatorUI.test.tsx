import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

function Calculator() {
  const [expr, setExpr] = React.useState('');
  const buttons = ['1','2','3','+','4','5','6','-','7','8','9','*','0','/','='];
  const handleClick = (value: string) => {
    if (value === '=') {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${expr});`);
        setExpr(String(fn()));
      } catch {
        setExpr('Error');
      }
    } else {
      setExpr(prev => prev + value);
    }
  };
  return (
    <div>
      <div data-testid="display">{expr}</div>
      <div data-testid="keypad">
        {buttons.map(b => (
          <button key={b} onClick={() => handleClick(b)} aria-label={b}>
            {b}
          </button>
        ))}
      </div>
    </div>
  );
}

describe('Calculator UI root component', () => {
  test('renders display area and full keypad on initial load without console errors', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<Calculator />);
    expect(screen.getByTestId('display')).toBeInTheDocument();
    const keypad = screen.getByTestId('keypad');
    expect(keypad).toBeInTheDocument();
    expect(keypad.querySelectorAll('button')).toHaveLength(14);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
