import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

test('counter button increments when clicked', () => {
  render(<App />);
  const button = screen.getByRole('button', { name: /count is/i });
  expect(button).toBeInTheDocument();
  const initialText = button.textContent;
  fireEvent.click(button);
  expect(button.textContent).not.toBe(initialText);
});
