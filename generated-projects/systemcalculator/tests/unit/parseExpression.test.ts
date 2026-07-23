import { describe, expect, test } from '@jest/globals';

// Simple mock implementation of parseExpression using mathjs evaluate
function parseExpression(expr: string): number {
  // Very naive implementation for test purposes
  // Use Function constructor to evaluate safe arithmetic (no eval in real code)
  // Here we just handle simple + and - for demonstration
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    throw new Error('Invalid syntax');
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${expr});`);
    const result = fn();
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Invalid result');
    }
    return result;
  } catch (e) {
    throw new Error('Invalid syntax');
  }
}

describe('parseExpression function', () => {
  test('returns correct result for simple addition', () => {
    expect(parseExpression('1+2')).toBe(3);
  });

  test('throws an Error with recognizable message for invalid input', () => {
    expect(() => parseExpression('invalid')).toThrowError(/Invalid syntax/);
  });
});
