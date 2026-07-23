import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import CalcButton from './CalcButton';

describe('CalcButton component', () => {
  it('renders the provided label', () => {
    const { getByRole } = render(
      <CalcButton label="7" value="7" onClick={() => {}} />
    );
    const button = getByRole('button', { name: /7/i });
    expect(button).toBeInTheDocument();
  });

  it('calls onClick with the value when clicked', () => {
    const handleClick = jest.fn();
    const { getByRole } = render(
      <CalcButton label="+" value="+" onClick={handleClick} />
    );
    const button = getByRole('button', { name: /\+/i });
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
    expect(handleClick).toHaveBeenCalledWith('+');
  });
});
