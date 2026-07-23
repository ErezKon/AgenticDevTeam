import { evaluate } from '../../engine/calculatorEngine.js';

describe('CalculatorEngine evaluate', () => {
  // Existing tests for basic functionality and error handling
  test('basic addition', () => {
    expect(evaluate('2+3')).toBe(5);
  });

  test('operator precedence multiplication before addition', () => {
    expect(evaluate('3+4*2')).toBe(11);
  });

  test('parentheses alter precedence', () => {
    expect(evaluate('(2+3)*(4-1)')).toBe(15);
  });

  test('decimal numbers', () => {
    expect(evaluate('3.5*2')).toBeCloseTo(7.0);
  });

  test('unary minus handling', () => {
    expect(evaluate('-5+2')).toBe(-3);
    expect(evaluate('4*-2')).toBe(-8);
  });

  test('division by zero throws error', () => {
    expect(() => evaluate('10/0')).toThrow('Division by zero');
  });

  test('unmatched parentheses throws error', () => {
    expect(() => evaluate('(2+3')).toThrow('Unmatched parentheses');
  });

  test('invalid token sequence throws error', () => {
    expect(() => evaluate('5++2')).toThrow('Invalid syntax');
  });

  // New tests for basic operations and precedence as per assignment US-004
  test('addition and multiplication precedence', () => {
    expect(evaluate('3+4*2')).toBe(11);
  });

  test('parentheses precedence with addition', () => {
    expect(evaluate('(1+2)*3')).toBe(9);
  });

  test('subtraction and division precedence', () => {
    expect(evaluate('7-5/2')).toBeCloseTo(4.5);
  });
});
