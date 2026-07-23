import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button component', () => {
  test('renders label and calls onPress with label when value not provided', () => {
    const handlePress = jest.fn();
    render(<Button label="5" onPress={handlePress} />);
    const btn = screen.getByRole('button', { name: /5/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(handlePress).toHaveBeenCalledTimes(1);
    expect(handlePress).toHaveBeenCalledWith('5');
  });

  test('uses provided value prop when emitting', () => {
    const handlePress = jest.fn();
    render(<Button label="×" value="*" onPress={handlePress} />);
    const btn = screen.getByRole('button', { name: /×/i });
    fireEvent.click(btn);
    expect(handlePress).toHaveBeenCalledWith('*');
  });

  test('has appropriate aria-label for accessibility', () => {
    const handlePress = jest.fn();
    render(<Button label="Clear" value="C" onPress={handlePress} />);
    const btn = screen.getByLabelText('Clear');
    expect(btn).toBeInTheDocument();
  });
});
