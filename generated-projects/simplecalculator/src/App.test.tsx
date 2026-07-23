import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

describe('Calculator UI evaluation', () => {
  test('evaluates expression on button click and shows result', async () => {
    render(<App />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    await userEvent.type(input, '2+3*4');
    const button = screen.getByRole('button', { name: /evaluate/i });
    await userEvent.click(button);
    const result = await screen.findByTestId('result');
    expect(result).toHaveTextContent('Result: 14');
  });

  test('evaluates expression on Enter key press', async () => {
    render(<App />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    await userEvent.type(input, '10/2');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    const result = await screen.findByTestId('result');
    expect(result).toHaveTextContent('Result: 5');
  });

  test('displays error message for division by zero', async () => {
    render(<App />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    await userEvent.type(input, '1/0');
    const button = screen.getByRole('button', { name: /evaluate/i });
    await userEvent.click(button);
    const error = await screen.findByTestId('error');
    expect(error).toHaveTextContent('Cannot divide by zero');
  });

  test('displays error for invalid characters', async () => {
    render(<App />);
    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    await userEvent.type(input, '2a+3');
    const button = screen.getByRole('button', { name: /evaluate/i });
    await userEvent.click(button);
    const error = await screen.findByTestId('error');
    expect(error).toHaveTextContent('Invalid characters in expression');
  });
});
