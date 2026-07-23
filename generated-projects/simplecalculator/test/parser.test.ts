import { evaluateExpression } from '../src/evaluator/parser';

describe('evaluateExpression parser', () => {
  // Simple arithmetic
  it('evaluates addition', () => {
    expect(evaluateExpression('2+3')).toBe(5);
  });

  // Operator precedence
  it('respects operator precedence', () => {
    expect(evaluateExpression('2+3*4')).toBe(14);
  });

  // Parentheses handling
  it('evaluates expressions with parentheses', () => {
    expect(evaluateExpression('(2+3)*4')).toBe(20);
  });

  // Decimal numbers
  it('handles decimal numbers', () => {
    expect(evaluateExpression('1.5+2.25')).toBeCloseTo(3.75);
  });

  // Negative numbers
  it('handles negative numbers', () => {
    expect(evaluateExpression('-5+3')).toBe(-2);
  });

  // Complex nested expression
  it('evaluates complex nested expression', () => {
    expect(evaluateExpression('(1+(2*3))-4/2')).toBe(5);
  });

  // Whitespace handling
  it('ignores whitespace in expression', () => {
    expect(evaluateExpression(' 2 + 3 ')).toBe(5);
  });

  // Division by zero – specific error code
  it('throws DIV_ZERO error on division by zero', () => {
    expect(() => evaluateExpression('10/0')).toThrowError('DIV_ZERO');
  });

  // Syntax error – malformed expression (consecutive operators)
  it('throws SYNTAX_ERROR on consecutive operators', () => {
    expect(() => evaluateExpression('2++3')).toThrowError('SYNTAX_ERROR');
  });

  // Syntax error – unmatched parentheses
  it('throws SYNTAX_ERROR on unmatched parentheses', () => {
    expect(() => evaluateExpression('(2+3')).toThrowError('SYNTAX_ERROR');
  });

  // Syntax error – invalid characters
  it('throws SYNTAX_ERROR on invalid characters', () => {
    expect(() => evaluateExpression('2a+3')).toThrowError('SYNTAX_ERROR');
  });

  // Syntax error – extra characters after valid expression
  it('throws SYNTAX_ERROR when extra characters follow expression', () => {
    expect(() => evaluateExpression('2+3abc')).toThrowError('SYNTAX_ERROR');
  });

  // Multiple unary signs
  it('handles multiple unary signs correctly', () => {
    expect(evaluateExpression('--5')).toBe(5);
    expect(evaluateExpression('+-5')).toBe(-5);
    expect(evaluateExpression('-+5')).toBe(-5);
  });

  // Unary plus
  it('handles unary plus', () => {
    expect(evaluateExpression('+5')).toBe(5);
  });

  // Negative expression with parentheses
  it('handles negative expression with parentheses', () => {
    expect(evaluateExpression('-(2+3)*4')).toBe(-20);
  });

  // Decimal with leading dot
  it('handles decimal numbers with leading dot', () => {
    expect(evaluateExpression('.5+1')).toBeCloseTo(1.5);
  });

  // Decimal with trailing dot
  it('handles decimal numbers with trailing dot', () => {
    expect(evaluateExpression('5.+2')).toBeCloseTo(7);
  });
});
