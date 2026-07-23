import { ValidationService } from '../../src/services/validation';

describe('ValidationService.validateExpression', () => {
  test('throws error for illegal characters', () => {
    expect(() => ValidationService.validateExpression('2 & 3')).toThrow('Invalid character detected');
    expect(() => ValidationService.validateExpression('5 @ 2')).toThrow('Invalid character detected');
  });
});

describe('ValidationService.checkParenthesesBalance', () => {
  test('throws error for mismatched parentheses', () => {
    expect(() => ValidationService.validateExpression('(2+3')).toThrow('Mismatched parentheses');
    expect(() => ValidationService.validateExpression('2+3)')).toThrow('Mismatched parentheses');
  });
});

describe('ValidationService.checkDivisionByZero', () => {
  test('throws error for division by zero', () => {
    expect(() => ValidationService.validateExpression('5/0')).toThrow('Division by zero is not allowed');
    expect(() => ValidationService.validateExpression('10 / 0')).toThrow('Division by zero is not allowed');
  });
});
