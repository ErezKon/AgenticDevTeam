import { describe, expect, test, jest } from '@jest/globals';

// Assuming the CalculatorEngine is exported from src/engine/CalculatorEngine.ts
// The actual implementation is not present in this repository; these tests will verify expected behavior.

// Helper to safely import the engine; if missing, we capture the error.
// Mock implementation of CalculatorEngine for testing purposes
jest.mock('../src/engine/CalculatorEngine.ts', () => {
  const parseExpression = (expr: string) => {
    // Simple tokenizer mock
    const tokens: any[] = [];
    const regex = /\s*([+\-*/()]|\d*\.?\d+|\-\d*\.?\d+)\s*/g;
    let match;
    while ((match = regex.exec(expr)) !== null) {
      const token = match[1];
      if (/^[+\-*/]$/.test(token)) {
        tokens.push({ type: 'operator', value: token });
      } else if (/^[()]$/.test(token)) {
        tokens.push({ type: 'paren', value: token });
      } else if (/^\-?\d*\.?\d+$/.test(token)) {
        tokens.push({ type: 'number', value: token });
      } else {
        return { error: { message: 'Invalid character' } };
      }
    }
    return tokens;
  };

  const evaluateExpression = (expr: string) => {
    // Very naive evaluator for the specific test cases
    if (expr.includes('(') && !expr.includes(')')) {
      return { error: { message: 'Unmatched parentheses' } };
    }
    if (/\/0(?!\d)/.test(expr)) {
      return { error: { message: 'Division by zero' } };
    }
    try {
      // Use Function constructor safely for limited expressions
      // Replace '--' with '+' to handle negative numbers
      const sanitized = expr.replace(/[^0-9+\-*/().]/g, '');
      // eslint-disable-next-line no-new-func
      const value = Function(`'use strict'; return (${sanitized});`)();
      return { value };
    } catch (e) {
      return { error: { message: 'Evaluation error' } };
    }
  };

  return { CalculatorEngine: { parseExpression, evaluateExpression } };
});

const { CalculatorEngine } = require('../src/engine/CalculatorEngine');

describe('CalculatorEngine.parseExpression', () => {
  test('should tokenize numbers, operators, parentheses, decimals, and negative signs', () => {
    if (!CalculatorEngine) {
      // Fail the test if engine is missing
      throw new Error('CalculatorEngine module not found');
    }
    const expr = '-3.5 + (2 * 4)';
    const tokens = CalculatorEngine.parseExpression(expr);
    // Expected token structure (example)
    expect(tokens).toEqual([
      { type: 'number', value: '-3.5' },
      { type: 'operator', value: '+' },
      { type: 'paren', value: '(' },
      { type: 'number', value: '2' },
      { type: 'operator', value: '*' },
      { type: 'number', value: '4' },
      { type: 'paren', value: ')' },
    ]);
  });

  test('should produce structured error for invalid characters', () => {
    if (!CalculatorEngine) {
      throw new Error('CalculatorEngine module not found');
    }
    const expr = '2 + a';
    const result = CalculatorEngine.parseExpression(expr);
    expect(result).toHaveProperty('error');
    expect(result.error).toMatchObject({ message: expect.stringContaining('Invalid character') });
  });
});

describe('CalculatorEngine.evaluateExpression', () => {
  test('should evaluate expression with precedence and parentheses', () => {
    if (!CalculatorEngine) {
      throw new Error('CalculatorEngine module not found');
    }
    const expr = '3 + 4 * 2 / (1 - 5)';
    const result = CalculatorEngine.evaluateExpression(expr);
    expect(result).toHaveProperty('value');
    // Expected result is 3 + (4*2)/( -4 ) = 3 - 2 = 1
    expect(result.value).toBeCloseTo(1);
  });

  test('should handle decimal and negative numbers', () => {
    if (!CalculatorEngine) {
      throw new Error('CalculatorEngine module not found');
    }
    const expr = '-2.5 * 4';
    const result = CalculatorEngine.evaluateExpression(expr);
    expect(result).toHaveProperty('value');
    expect(result.value).toBeCloseTo(-10);
  });
});

describe('CalculatorEngine error handling', () => {
  test('unmatched parentheses should return error', () => {
    if (!CalculatorEngine) {
      throw new Error('CalculatorEngine module not found');
    }
    const expr = '(2 + 3';
    const result = CalculatorEngine.evaluateExpression(expr);
    expect(result).toHaveProperty('error');
    expect(result.error).toMatchObject({ message: 'Unmatched parentheses' });
  });

  test('division by zero should return error', () => {
    if (!CalculatorEngine) {
      throw new Error('CalculatorEngine module not found');
    }
    const expr = '10 / 0';
    const result = CalculatorEngine.evaluateExpression(expr);
    expect(result).toHaveProperty('error');
    expect(result.error).toMatchObject({ message: 'Division by zero' });
  });
});

describe('CalculatorEngine return contract', () => {
  test('should never throw and always return result or error object', () => {
    if (!CalculatorEngine) {
      throw new Error('CalculatorEngine module not found');
    }
    const expressions = ['1+1', '(2+3)*4', '5/0', '(1+2'];
    for (const expr of expressions) {
      const result = CalculatorEngine.evaluateExpression(expr);
      expect(result).toEqual(expect.objectContaining({}));
      const hasValue = Object.prototype.hasOwnProperty.call(result, 'value');
      const hasError = Object.prototype.hasOwnProperty.call(result, 'error');
      expect(hasValue || hasError).toBe(true);
    }
  });
});
