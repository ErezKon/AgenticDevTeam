import { evaluate } from '../src/engine/evaluator';

describe('src/engine/evaluator.ts', () => {
  test('evaluates simple expression with operator precedence', () => {
    expect(evaluate('2+3*4')).toBe(14);
  });

  test('evaluates expression with parentheses overriding precedence', () => {
    expect(evaluate('(2+3)*4')).toBe(20);
  });

  test('handles decimal numbers correctly', () => {
    expect(evaluate('3.5+2.1')).toBeCloseTo(5.6);
  });

  test('handles unary minus at start and after parentheses', () => {
    expect(evaluate('-5+2')).toBe(-3);
    expect(evaluate('(-5)+2')).toBe(-3);
    expect(evaluate('4*-2')).toBe(-8);
  });

  test('returns error string for division by zero', () => {
    expect(evaluate('10/0')).toBe('Error: Division by zero');
  });

  test('returns error string for mismatched parentheses', () => {
    expect(evaluate('(1+2')).toBe('Error: Mismatched parentheses');
    expect(evaluate('1+2)')).toBe('Error: Mismatched parentheses');
  });

  test('ignores whitespace in expression', () => {
    expect(evaluate(' 2 + 3 ')).toBe(5);
  });

  test('returns error for invalid expression', () => {
    expect(evaluate('2++2')).toBe('Error: Invalid expression');
  });
});
