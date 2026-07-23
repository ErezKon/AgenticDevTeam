import { parseExpression } from '../utils/expressionParser';

describe('parseExpression', () => {
  test('evaluates simple addition', () => {
    expect(parseExpression('1+2')).toBe(3);
  });

  test('throws error on invalid expression', () => {
    expect(() => parseExpression('invalid')).toThrow(Error);
  });
});
