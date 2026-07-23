import { describe, expect, test } from '@jest/globals';

// Mock error handler that transforms mathjs errors
function handleError(error: Error): string {
  const msg = error.message;
  if (msg.includes('division by zero')) {
    return 'Cannot divide by zero';
  }
  if (msg.includes('syntax')) {
    return 'Invalid syntax';
  }
  return 'Unknown error';
}

describe('Error Handler module', () => {
  test('transforms syntax errors into "Invalid syntax"', () => {
    const err = new Error('Unexpected token syntax error');
    expect(handleError(err)).toBe('Invalid syntax');
  });

  test('transforms division-by-zero errors into "Cannot divide by zero"', () => {
    const err = new Error('division by zero');
    expect(handleError(err)).toBe('Cannot divide by zero');
  });
});
