import { evaluateSafe } from '../src/evaluateSafe';

describe('evaluateSafe', () => {
  test('returns correct result for valid expression', () => {
    const result = evaluateSafe('3+4*2/(1-5)');
    expect(result).toBeCloseTo(1);
  });

  test('handles operator precedence and parentheses', () => {
    const result = evaluateSafe('2*(3+4)');
    expect(result).toBe(14);
  });

  test('returns error string for mismatched parentheses', () => {
    const result = evaluateSafe('(1+2');
    expect(result).toBe('Error: Mismatched parentheses');
  });

  test('returns error string for division by zero', () => {
    const result = evaluateSafe('10/0');
    expect(result).toBe('Error: Division by zero');
  });

  test('returns error string for invalid character', () => {
    const result = evaluateSafe('2+2a');
    expect(result).toBe('Error: Invalid character');
  });

  test('returns error string for invalid number format', () => {
    const result = evaluateSafe('1..2+3');
    expect(result).toBe('Error: Invalid number format');
  });
});
