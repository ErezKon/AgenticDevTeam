import { evaluate } from './evaluate';

describe('Calculator Engine evaluate', () => {
  // Valid expression tests
  const validCases: Array<[string, number]> = [
    ['1+2', 3],
    ['2-5', -3],
    ['3*4', 12],
    ['8/2', 4],
    ['2+3*4', 14], // precedence
    ['(2+3)*4', 20], // parentheses
    ['-5+2', -3], // leading unary minus
    ['4+-2', 2], // unary minus after plus
    ['3.5+2.1', 5.6],
    ['0.1+0.2', 0.3], // floating point rounding
    ['10/3', 3.3333333333], // rounded to 10 decimals
    ['(1+2)*(3+4)', 21],
    ['((2))', 2],
    ['-(-3)', 3],
    ['5*-2', -10],
    ['-5*-2', 10],
    ['(1+2)*(3-4)/5', -0.6],
    ['1000000*1000000', 1000000000000],
    ['1/3+1/6', 0.5],
    ['(0.1+0.2)*10', 3],
  ];

  validCases.forEach(([expr, expected]) => {
    test(`evaluates "${expr}" => ${expected}`, () => {
      const result = evaluate(expr);
      expect('result' in result).toBe(true);
      if ('result' in result) {
        // Use toBeCloseTo for floating point comparisons
        expect(result.result).toBeCloseTo(expected, 10);
      }
    });
  });

  // Invalid expression tests
  const invalidCases: Array<[string, string]> = [
    ['', 'Invalid syntax'],
    ['   ', 'Invalid syntax'],
    ['2++2', 'Invalid syntax'],
    ['5/*2', 'Invalid syntax'],
    ['abc', 'Invalid syntax'],
    ['1+2a', 'Invalid syntax'],
    ['(1+2', 'Mismatched parentheses'],
    ['1+2)', 'Mismatched parentheses'],
    ['(1+2))', 'Mismatched parentheses'],
    ['5/0', 'Division by zero'],
    ['1/0+2', 'Division by zero'],
    ['1..2+3', 'Invalid syntax'],
    ['..1+2', 'Invalid syntax'],
    ['1+2..3', 'Invalid syntax'],
    ['1+*2', 'Invalid syntax'],
    ['-+3', 'Invalid syntax'],
    ['1/ (2-2)', 'Division by zero'],
    ['1/ (2-2) + 5', 'Division by zero'],
    ['1'.repeat(101), 'Expression too long'],
    ['9999999999999999999999999*9', 'Numeric overflow'],
  ];

  invalidCases.forEach(([expr, expectedError]) => {
    test(`returns error "${expectedError}" for expression "${expr}"`, () => {
      const result = evaluate(expr);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe(expectedError);
      }
    });
  });
});
