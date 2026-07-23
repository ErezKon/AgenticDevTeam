import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders BaseCalc heading', () => {
  render(<App />);
  const heading = screen.getByRole('heading', { name: /BaseCalc/i });
  expect(heading).toBeInTheDocument();
});
