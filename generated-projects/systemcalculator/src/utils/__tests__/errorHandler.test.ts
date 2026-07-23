import { formatError } from '../errorHandler';

describe('formatError', () => {
  test('maps invalid syntax errors to user‑friendly message', () => {
    const err1 = new Error('Invalid expression');
    const err2 = new Error('Unexpected token');
    expect(formatError(err1)).toBe('Invalid syntax');
    expect(formatError(err2)).toBe('Invalid syntax');
  });

  test('maps division by zero errors to user‑friendly message', () => {
    const err1 = new Error('Division by zero');
    const err2 = new Error('Cannot divide by zero');
    expect(formatError(err1)).toBe('Cannot divide by zero');
    expect(formatError(err2)).toBe('Cannot divide by zero');
  });

  test('returns generic message for unknown errors', () => {
    const err = new Error('Something went wrong');
    expect(formatError(err)).toBe('An unexpected error occurred');
  });
});
