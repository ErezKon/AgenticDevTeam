export class ValidationService {
  static illegalCharRegex = /[^0-9+\-*/().\s]/;

  static validateExpression(expr: string): void {
    if (this.hasInvalidChars(expr)) {
      throw new Error('Invalid character detected');
    }
    this.checkParenthesesBalance(expr);
    this.checkDivisionByZero(expr);
  }

  static hasInvalidChars(expr: string): boolean {
    return this.illegalCharRegex.test(expr);
  }

  static checkParenthesesBalance(expr: string): void {
    let balance = 0;
    for (const ch of expr) {
      if (ch === '(') balance++;
      else if (ch === ')') balance--;
      if (balance < 0) break;
    }
    if (balance !== 0) {
      throw new Error('Mismatched parentheses');
    }
  }

  static checkDivisionByZero(expr: string): void {
    // Simple check for /0 or /0.0 etc not preceded by a digit (to avoid false positives like /10)
    const divZeroPattern = /\/\s*0(?![0-9])/;
    if (divZeroPattern.test(expr)) {
      throw new Error('Division by zero is not allowed');
    }
  }
}
