import { evaluate } from '../src/evaluator';

describe('Expression Evaluator - Division by Zero', () => {
  test('should return error object with code DIV_ZERO when dividing by zero', () => {
    const result = evaluate('10 / 0');
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('DIV_ZERO');
    expect(result.error?.message).toBe('Cannot divide by zero');
    expect(result.result).toBeUndefined();
  });

  test('should evaluate normal division correctly', () => {
    const result = evaluate('10 / 2');
    expect(result.error).toBeUndefined();
    expect(result.result).toBeCloseTo(5);
  });

  test('should handle division by zero in complex expression', () => {
    const result = evaluate('5 + 3 / (2 - 2)');
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('DIV_ZERO');
  });

  test('should return syntax error for malformed expression', () => {
    const result = evaluate('5 + * 2');
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('SYNTAX_ERROR');
  });
});
