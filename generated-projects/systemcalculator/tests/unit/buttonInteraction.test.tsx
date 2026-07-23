import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

function Calculator() {
  const [expr, setExpr] = React.useState('');
  const handleClick = (value: string) => {
    setExpr(prev => prev + value);
  };
  return (
    <div>
      <div data-testid="display">{expr}</div>
      <button onClick={() => handleClick('1')} aria-label="Number 1">1</button>
      <button onClick={() => handleClick('+')} aria-label="Add">+</button>
      <button onClick={() => handleClick('2')} aria-label="Number 2">2</button>
    </div>
  );
}

describe('Calculator UI button interaction', () => {
  test('clicking numeric/operator updates display within 100ms preserving sequence', async () => {
    render(<Calculator />);
    const btn1 = screen.getByLabelText('Number 1');
    const btnAdd = screen.getByLabelText('Add');
    const btn2 = screen.getByLabelText('Number 2');
    fireEvent.click(btn1);
    fireEvent.click(btnAdd);
    fireEvent.click(btn2);
    const display = screen.getByTestId('display');
    await waitFor(() => expect(display).toHaveTextContent('1+2'), { timeout: 100 });
  });
});
