import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Calculator from '../Calculator';

describe('Calculator component', () => {
  test('button clicks update the display', async () => {
    render(<Calculator />);
    const user = userEvent.setup();
    const btn1 = screen.getByTestId('btn-1');
    const btnPlus = screen.getByTestId('btn-+');
    const btn2 = screen.getByTestId('btn-2');
    await user.click(btn1);
    await user.click(btnPlus);
    await user.click(btn2);
    const display = screen.getByTestId('display');
    expect(display).toHaveTextContent('1+2');
  });

  test('"=" button evaluates the expression', async () => {
    render(<Calculator />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('btn-3'));
    await user.click(screen.getByTestId('btn-+'));
    await user.click(screen.getByTestId('btn-4'));
    await user.click(screen.getByTestId('btn-='));
    const display = screen.getByTestId('display');
    expect(display).toHaveTextContent('7');
  });

  test('invalid syntax shows error message', async () => {
    render(<Calculator />);
    const user = userEvent.setup();
    // input 5 ++ 2 =
    await user.click(screen.getByTestId('btn-5'));
    await user.click(screen.getByTestId('btn-+'));
    await user.click(screen.getByTestId('btn-+'));
    await user.click(screen.getByTestId('btn-2'));
    await user.click(screen.getByTestId('btn-='));
    await screen.findByTestId('error'); // ensure error element is in DOM
    const error = screen.getByTestId('error');
    expect(error).toHaveTextContent('Invalid syntax');
  });

  test('division by zero shows specific error message', async () => {
    render(<Calculator />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('btn-5'));
    await user.click(screen.getByTestId('btn-/'));
    await user.click(screen.getByTestId('btn-0'));
    await user.click(screen.getByTestId('btn-='));
    const error = await screen.findByTestId('error');
    expect(error).toHaveTextContent('Cannot divide by zero');
  });
});
