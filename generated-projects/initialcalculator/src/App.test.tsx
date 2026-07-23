import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

test('renders Initial Calculator heading', () => {
  render(<App />);
  const heading = screen.getByRole('heading', { name: /initial calculator/i });
  expect(heading).toBeInTheDocument();
});

test('counter button is present and increments', () => {
  render(<App />);
  const button = screen.getByRole('button', { name: /count is/i });
  expect(button).toBeInTheDocument();
  const initialText = button.textContent;
  fireEvent.click(button);
  expect(button.textContent).not.toBe(initialText);
});
