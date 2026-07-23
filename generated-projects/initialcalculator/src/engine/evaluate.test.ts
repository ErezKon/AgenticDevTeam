import { evaluate } from './evaluate';

describe('Calculator Engine evaluate', () => {
  // Helper to extract result or error
  const getResult = (expr: string) => evaluate(expr).result;
  const getError = (expr: string) => evaluate(expr).error;

  // Valid expression tests
  test('simple addition', () => {
    expect(getResult('2+2')).toBe(4);
  });

  test('operator precedence', () => {
    expect(getResult('2+3*4')).toBe(14);
  });

  test('parentheses precedence', () => {
    expect(getResult('(2+3)*4')).toBe(20);
  });

  test('unary minus at start', () => {
    expect(getResult('-5+3')).toBe(-2);
  });

  test('whitespace handling', () => {
    expect(getResult('  -5  ')).toBe(-5);
  });

  test('decimal multiplication', () => {
    expect(getResult('3.5*2')).toBe(7);
  });

  test('division with rounding to 10 decimals', () => {
    expect(getResult('10/3')).toBeCloseTo(3.3333333333, 10);
  });

  test('floating point addition rounding', () => {
    expect(getResult('0.1+0.2')).toBeCloseTo(0.3, 10);
  });

  test('complex nested expression', () => {
    expect(getResult('((1+2)*(3-4))/5')).toBeCloseTo(-0.6, 10);
  });

  test('single number', () => {
    expect(getResult('5')).toBe(5);
  });

  test('double parentheses', () => {
    expect(getResult('((2))')).toBe(2);
  });

  test('plus followed by unary minus', () => {
    expect(getResult('2+-3')).toBe(-1);
  });

  test('double minus becomes plus', () => {
    expect(getResult('2--3')).toBe(5);
  });

  test('unary minus after multiplication', () => {
    expect(getResult('2* -3')).toBe(-6);
  });

  test('unary plus at start', () => {
    expect(getResult('+5')).toBe(5);
  });

  test('invalid consecutive operators', () => {
    expect(getError('5*/2')).toBe('Invalid syntax');
  });

  test('spaces around operators', () => {
    expect(getResult(' 3 + 4 * 2 ')).toBe(11);
  });

  test('deep nested parentheses', () => {
    expect(getResult('(((1+2)))')).toBe(3);
  });

  test('rounding more than 10 decimals', () => {
    expect(getResult('1/3')).toBeCloseTo(0.3333333333, 10);
  });

  test('unary minus with parentheses', () => {
    expect(getResult('-(3+2)')).toBe(-5);
  });

  // Invalid expression tests
  test('whitespace only string', () => {
    expect(getError('   ')).toBe('Invalid syntax');
  });
  test('division by zero', () => {
    expect(getError('5/0')).toBe('Division by zero');
  });

  test('mismatched parentheses missing closing', () => {
    expect(getError('(1+2')).toBe('Mismatched parentheses');
  });

  test('mismatched parentheses extra closing', () => {
    expect(getError('1+2)')).toBe('Mismatched parentheses');
  });

  test('invalid syntax double operator', () => {
    expect(getError('2++2')).toBe('Invalid syntax');
  });

  test('invalid characters', () => {
    expect(getError('abc')).toBe('Invalid syntax');
  });

  test('malformed number with multiple dots', () => {
    expect(getError('2..3+4')).toBe('Invalid syntax');
  });

  test('empty string', () => {
    expect(getError('')).toBe('Invalid syntax');
  });
});
