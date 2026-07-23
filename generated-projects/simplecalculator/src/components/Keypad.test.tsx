import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Keypad } from './Keypad';

describe('Keypad component', () => {
  const mockPress = jest.fn();

  beforeEach(() => {
    mockPress.mockClear();
    render(<Keypad onButtonPress={mockPress} />);
  });

  test('renders all expected buttons', () => {
    const expectedLabels = ['C', '(', ')', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '='];
    expectedLabels.forEach((label) => {
      const btn = screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
      expect(btn).toBeInTheDocument();
    });
  });

  test('clicking a button emits its value via onButtonPress', () => {
    const buttonMap: Record<string, string> = {
      C: 'C',
      '(': '(',
      ')': ')',
      '/': '/',
      '7': '7',
      '8': '8',
      '9': '9',
      '*': '*',
      '4': '4',
      '5': '5',
      '6': '6',
      '-': '-',
      '1': '1',
      '2': '2',
      '3': '3',
      '+': '+',
      '0': '0',
      '.': '.',
      '=': '=',
    };
    Object.entries(buttonMap).forEach(([label, value]) => {
      const btn = screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
      fireEvent.click(btn);
      expect(mockPress).toHaveBeenLastCalledWith(value);
    });
    // Ensure total calls equal number of buttons
    expect(mockPress).toHaveBeenCalledTimes(Object.keys(buttonMap).length);
  });
});
