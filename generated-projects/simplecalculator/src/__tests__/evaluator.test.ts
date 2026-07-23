import { evaluate } from "../evaluator";

describe('Evaluator', () => {
  test('evaluates simple addition and multiplication with precedence', () => {
    const res = evaluate('2+3*4');
    expect(res).toEqual({ result: 14 });
  });

  test('evaluates expression with parentheses', () => {
    const res = evaluate('(1+2)*3');
    expect(res).toEqual({ result: 9 });
  });

  test('handles decimal numbers', () => {
    const res = evaluate('0.5*8');
    expect(res).toEqual({ result: 4 });
  });

  test('handles unary minus and negative numbers', () => {
    const res = evaluate('-5 + 2');
    expect(res).toEqual({ result: -3 });
  });

  test('division by zero returns DIV_ZERO error', () => {
    const res = evaluate('10/0');
    expect(res).toHaveProperty('error');
    expect(res.error).toMatchObject({ code: 'DIV_ZERO' });
  });

  test('syntax error for unmatched parenthesis', () => {
    const res = evaluate('(1+2');
    expect(res).toHaveProperty('error');
    expect(res.error?.code).toBe('SYNTAX_ERROR');
  });

  test('syntax error for invalid character', () => {
    const res = evaluate('2+3a');
    expect(res).toHaveProperty('error');
    expect(res.error?.code).toBe('SYNTAX_ERROR');
  });
});
