import { ExpressionEngine } from '../../src/services/engine';

describe('ExpressionEngine.evaluateExpression', () => {
  test('evaluates simple addition', () => {
    expect(ExpressionEngine.evaluateExpression('2+3')).toBe(5);
  });

  test('evaluates complex expression with precedence and parentheses', () => {
    const expr = '3 + (2.5 * -4) / 2';
    // Expected: 3 + (2.5 * -4) / 2 = 3 + (-10) / 2 = 3 + -5 = -2
    expect(ExpressionEngine.evaluateExpression(expr)).toBeCloseTo(-2);
  });

  test('throws error for invalid expression', () => {
    expect(() => ExpressionEngine.evaluateExpression('2++2')).toThrow();
  });
});

describe('ExpressionEngine.shuntingYardParser', () => {
  test('handles operator precedence', () => {
    const rpn = ExpressionEngine.shuntingYardParser('2+3*4');
    // Expected RPN: 2 3 4 * +
    expect(rpn).toEqual([2, 3, 4, '*', '+']);
  });

  test('handles decimals and negative numbers', () => {
    const rpn = ExpressionEngine.shuntingYardParser('5 + -2.5');
    // Expected: 5 -2.5 +
    expect(rpn).toEqual([5, -2.5, '+']);
  });

  test('handles parentheses', () => {
    const rpn = ExpressionEngine.shuntingYardParser('(1+2)*3');
    // Expected: 1 2 + 3 *
    expect(rpn).toEqual([1, 2, '+', 3, '*']);
  });
});

describe('ExpressionEngine.pureFunctionDeterminism', () => {
  test('same input yields same output', () => {
    const expr = '7 * (8 - 3) / 5';
    const first = ExpressionEngine.evaluateExpression(expr);
    const second = ExpressionEngine.evaluateExpression(expr);
    expect(first).toBe(second);
  });
});
