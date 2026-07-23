import { parseExpression } from '../expressionParser';

describe('parseExpression valid expressions', () => {
  test('evaluates basic addition', () => {
    expect(parseExpression('1+2')).toBe(3);
  });

  test('evaluates expression with operator precedence', () => {
    expect(parseExpression('3+4*2')).toBe(11);
  });

  test('evaluates decimal multiplication', () => {
    expect(parseExpression('2.5*4')).toBe(10);
  });

  test('evaluates expression with parentheses', () => {
    expect(parseExpression('(3+4)*2')).toBe(14);
  });

  test('evaluates negative numbers', () => {
    expect(parseExpression('-5+3')).toBe(-2);
  });
});
