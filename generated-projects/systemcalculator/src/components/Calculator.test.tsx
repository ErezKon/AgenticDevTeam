import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Calculator from './Calculator';

describe('Calculator component', () => {
  test('initial display is empty', () => {
    render(<Calculator />);
    const display = screen.getByTestId('display');
    expect(display).toHaveTextContent('');
  });

  test('clicking buttons updates the display expression', () => {
    render(<Calculator />);
    const button1 = screen.getByRole('button', { name: '1' });
    const buttonPlus = screen.getByRole('button', { name: '+' });
    const button2 = screen.getByRole('button', { name: '2' });
    const display = screen.getByTestId('display');

    fireEvent.click(button1);
    expect(display).toHaveTextContent('1');

    fireEvent.click(buttonPlus);
    expect(display).toHaveTextContent('1+');

    fireEvent.click(button2);
    expect(display).toHaveTextContent('1+2');
  });
});
