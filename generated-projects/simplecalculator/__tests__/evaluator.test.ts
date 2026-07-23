import { evaluate } from '../src/evaluator';

describe('Calculator Engine evaluate', () => {
  test('evaluates simple expression correctly', () => {
    expect(evaluate('3+4*2/(1-5)')).toBeCloseTo(1);
  });

  test('detects mismatched parentheses', () => {
    expect(evaluate('(1+2')).toBe('Error: Mismatched parentheses');
    expect(evaluate('1+2)')).toBe('Error: Mismatched parentheses');
    expect(evaluate('((1+2)')).toBe('Error: Mismatched parentheses');
  });

  test('handles division by zero', () => {
    expect(evaluate('10/0')).toBe('Error: Division by zero');
  });

  test('handles unary minus and decimals', () => {
    expect(evaluate('-3.5+2')).toBeCloseTo(-1.5);
    expect(evaluate('(-2)+4')).toBeCloseTo(2);
  });
});
