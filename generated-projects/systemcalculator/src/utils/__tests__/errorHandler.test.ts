// This test file is deprecated and disabled.
// import { formatError } from '../errorHandler';
// describe('formatError TS test', () => {
//   test('placeholder', () => {
//     expect(true).toBe(true);
//   });
// });

describe('formatError', () => {
  test('maps syntax errors to user-friendly message', () => {
    const err = new Error('Unexpected token "+" at position 2');
    expect(formatError(err)).toBe('Invalid syntax');
  });

  test('maps division by zero errors to user-friendly message', () => {
    const err = new Error('Division by zero');
    expect(formatError(err)).toBe('Cannot divide by zero');
  });

  test('returns original message for unknown errors', () => {
    const err = new Error('Some other error');
    expect(formatError(err)).toBe('Some other error');
  });
});
