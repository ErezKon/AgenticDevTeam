import { parseExpression } from '../expressionParser';

describe('parseExpression error handling', () => {
  test('throws Invalid syntax for malformed expression with double operator', () => {
    expect(() => parseExpression('5++2')).toThrowError('Invalid syntax');
  });

  test('throws Invalid syntax for incomplete parentheses', () => {
    expect(() => parseExpression('(3+2')).toThrowError('Invalid syntax');
  });
});
