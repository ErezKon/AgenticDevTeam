import { evaluate } from './evaluator';

describe('evaluate', () => {
  test('evaluates simple expression with precedence', () => {
    const res = evaluate('2+3*4');
    expect(res.result).toBe(14);
    expect(res.error).toBeUndefined();
  });

  test('evaluates expression with parentheses and division', () => {
    const res = evaluate('(1+2)/3');
    expect(res.result).toBeCloseTo(1);
    expect(res.error).toBeUndefined();
  });

  test('handles unary minus and whitespace', () => {
    const res = evaluate(' -5 + 2 ');
    expect(res.result).toBe(-3);
    expect(res.error).toBeUndefined();
  });

  test('handles decimal numbers', () => {
    const res = evaluate('0.1+0.2');
    expect(res.result).toBeCloseTo(0.3);
    expect(res.error).toBeUndefined();
  });

  test('division by zero returns DIV_ZERO error', () => {
    const res = evaluate('10/0');
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe('DIV_ZERO');
    expect(res.error?.message).toBe('Cannot divide by zero');
  });

  test('syntax error returns SYNTAX_ERROR', () => {
    const res = evaluate('2+*3');
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe('SYNTAX_ERROR');
  });

  test('empty string returns SYNTAX_ERROR', () => {
    const res = evaluate('');
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe('SYNTAX_ERROR');
  });
});
