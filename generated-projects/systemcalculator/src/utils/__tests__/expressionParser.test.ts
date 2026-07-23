import { parseExpression, ExpressionSyntaxError, DivisionByZeroError } from '../expressionParser';

describe('parseExpression', () => {
  test('evaluates simple addition', () => {
    expect(parseExpression('1+2')).toBe(3);
  });

  test('evaluates expression with precedence', () => {
    expect(parseExpression('3+4*2')).toBe(11);
  });

  test('evaluates decimal multiplication', () => {
    expect(parseExpression('2.5*4')).toBe(10);
  });

  test('throws ExpressionSyntaxError for invalid syntax', () => {
    expect(() => parseExpression('invalid')).toThrow(ExpressionSyntaxError);
  });

  test('throws DivisionByZeroError for division by zero', () => {
    expect(() => parseExpression('5/0')).toThrow(DivisionByZeroError);
  });
});
