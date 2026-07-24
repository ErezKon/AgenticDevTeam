import { evaluate } from '../../src/engine/evaluate';

describe('Calculator Engine - evaluate', () => {
  test('Returns {result: number} for a simple valid expression "2+2".', () => {
    const res = evaluate('2+2');
    expect(res).toEqual({ result: 4 });
  });

  test('Respects operator precedence: "2+3*4" yields 14.', () => {
    const res = evaluate('2+3*4');
    expect(res).toEqual({ result: 14 });
  });

  test('Handles parentheses correctly: "(2+3)*4" yields 20.', () => {
    const res = evaluate('(2+3)*4');
    expect(res).toEqual({ result: 20 });
  });

  test('Rounds decimal results to at most 10 decimal places (e.g., "1/3" yields 0.3333333333).', () => {
    const res = evaluate('1/3');
    expect(res.result).toBeCloseTo(0.3333333333, 10);
  });

  test('Returns {error: "Division by zero"} for expression "5/0".', () => {
    const res = evaluate('5/0');
    expect(res).toEqual({ error: 'Division by zero' });
  });

  test('Returns {error: "Mismatched parentheses"} for expression "(2+3".', () => {
    const res = evaluate('(2+3');
    expect(res).toEqual({ error: 'Mismatched parentheses' });
  });

  test('Returns {error: "Invalid syntax"} for malformed token "2++2".', () => {
    const res = evaluate('2++2');
    expect(res).toEqual({ error: 'Invalid syntax' });
  });

  test('Handles negative numbers: "-5+3" yields -2.', () => {
    const res = evaluate('-5+3');
    expect(res).toEqual({ result: -2 });
  });

  test('Handles decimal numbers: "0.1+0.2" yields 0.3 (within rounding tolerance).', () => {
    const res = evaluate('0.1+0.2');
    expect(res.result).toBeCloseTo(0.3, 10);
  });

  test('Handles complex mixed expression "(1+2.5)*3-4/2" correctly.', () => {
    const res = evaluate('(1+2.5)*3-4/2');
    expect(res).toEqual({ result: 8.5 });
  });

  test('Detects invalid characters (e.g., letters) and returns "Invalid syntax".', () => {
    const res = evaluate('2+2a');
    expect(res).toEqual({ error: 'Invalid syntax' });
  });
});
