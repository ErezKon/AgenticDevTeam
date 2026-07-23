import { evaluate, EvalResult } from './evaluator';

describe('Evaluator runtime error handling', () => {
  test('should return DIV_ZERO error for simple division by zero', () => {
    const result: EvalResult = evaluate('10/0');
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('DIV_ZERO');
    expect(result.error?.message).toBe('Cannot divide by zero');
    expect(result.result).toBeUndefined();
  });

  test('should detect division by zero with spaces', () => {
    const result: EvalResult = evaluate('10 / 0');
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('DIV_ZERO');
    expect(result.error?.message).toBe('Cannot divide by zero');
  });

  test('error object should have correct shape', () => {
    const result = evaluate('5/0');
    // TypeScript ensures shape, but runtime check for properties
    expect(result.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
    });
  });

  test('non-zero division should not return an error', () => {
    const result = evaluate('8/2');
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });
});
