import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Calculator } from '../components/Calculator';

describe('Calculator component', () => {
  test('evaluates expression on = press', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<Calculator />);
    });
    await act(async () => {
      await user.click(screen.getByTestId('btn-1'));
      await user.click(screen.getByTestId('btn-+'));
      await user.click(screen.getByTestId('btn-2'));
      await user.click(screen.getByTestId('btn-='));
    });
    console.log('display after =', screen.getByTestId('display').textContent);
    expect(screen.getByTestId('display').textContent).toBe('3');
  });

  test('shows error message for division by zero', async () => {
    render(<Calculator />);
    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByTestId('btn-5'));
      await user.click(screen.getByTestId('btn-/'));
      await user.click(screen.getByTestId('btn-0'));
      await user.click(screen.getByTestId('btn-='));
    });
    expect(screen.getByTestId('display').textContent).toBe('Cannot divide by zero');
  });
});
