import { render, screen } from '@testing-library/react';
import App from './App';

test('renders Initial Calculator heading', () => {
  render(<App />);
  const heading = screen.getByRole('heading', { name: /initial calculator/i });
  expect(heading).toBeInTheDocument();
});
