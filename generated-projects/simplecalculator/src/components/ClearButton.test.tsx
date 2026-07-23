import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { ClearButton } from './ClearButton';

describe('ClearButton', () => {
  test('calls onClear when clicked', () => {
    const onClear = jest.fn();
    const { getByTestId } = render(<ClearButton onClear={onClear} />);
    const button = getByTestId('clear-button');
    fireEvent.click(button);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  test('calls onClear when Escape key is pressed', () => {
    const onClear = jest.fn();
    render(<ClearButton onClear={onClear} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
