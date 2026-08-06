import { render, screen } from '@testing-library/react';
import { App } from './App';

test('renders Pac-Man heading', () => {
  render(<App />);
  const heading = screen.getByRole('heading', { name: /pac-man/i });
  expect(heading).toBeInTheDocument();
});
