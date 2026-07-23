// src/evaluator.ts
/**
 * Expression Evaluator module
 * Provides a public evaluate function that parses and evaluates arithmetic expressions.
 * Supports +, -, *, /, parentheses, decimal numbers, and unary plus/minus.
 * Returns a result number or a structured error.
 */

export interface EvalError {
  code: string;
  message: string;
}

interface EvalResult {
  result?: number;
  error?: EvalError;
}

/**
 * Public API: evaluate an arithmetic expression string.
 * @param expression The arithmetic expression to evaluate.
 * @returns An object containing either the numeric result or an EvalError.
 */
export function evaluate(expression: string): EvalResult {
  try {
    const parser = new Parser(expression);
    const value = parser.parseExpression();
    if (!parser.isAtEnd()) {
      // Unexpected trailing characters
      throw new SyntaxError('Unexpected token');
    }
    return { result: value };
  } catch (e) {
    if (e instanceof EvalErrorClass) {
      return { error: { code: e.code, message: e.message } };
    }
    if (e instanceof SyntaxError) {
      return { error: { code: 'SYNTAX_ERROR', message: e.message } };
    }
    // Fallback generic error
    return { error: { code: 'UNKNOWN_ERROR', message: String(e) } };
  }
}

/**
 * Internal error class for evaluation errors (e.g., division by zero).
 */
class EvalErrorClass extends Error {
  public code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'EvalError';
  }
}

/**
 * Recursive‑descent parser for arithmetic expressions.
 */
class Parser {
  private input: string;
  private pos: number = 0;

  constructor(input: string) {
    this.input = input;
  }

  // Entry point
  public parseExpression(): number {
    // Expression = Term ((+|-) Term)*
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '+' || ch === '-') {
        this.pos++; // consume operator
        const rhs = this.parseTerm();
        if (ch === '+') value += rhs;
        else value -= rhs;
      } else {
        break;
      }
    }
    return value;
  }

  private parseTerm(): number {
    // Term = Factor ((*|/) Factor)*
    let value = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '*' || ch === '/') {
        this.pos++; // consume operator
        const rhs = this.parseFactor();
        if (ch === '*') {
          value *= rhs;
        } else {
          // Division – check for zero
          if (rhs === 0) {
            throw new EvalErrorClass('DIV_ZERO', 'Cannot divide by zero');
          }
          value /= rhs;
        }
      } else {
        break;
      }
    }
    return value;
  }

  private parseFactor(): number {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '+' || ch === '-') {
      // Unary plus/minus
      this.pos++;
      const factor = this.parseFactor();
      return ch === '+' ? factor : -factor;
    }
    if (ch === '(') {
      this.pos++; // consume '('
      const expr = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        throw new SyntaxError('Expected closing parenthesis');
      }
      this.pos++; // consume ')'
      return expr;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.pos;
    let hasDigits = false;
    while (this.isDigit(this.peek())) {
      this.pos++;
      hasDigits = true;
    }
    if (this.peek() === '.') {
      this.pos++; // consume '.'
      while (this.isDigit(this.peek())) {
        this.pos++;
        hasDigits = true;
      }
    }
    if (!hasDigits) {
      throw new SyntaxError('Invalid number');
    }
    const numStr = this.input.slice(start, this.pos);
    const value = Number(numStr);
    if (Number.isNaN(value)) {
      throw new SyntaxError('Invalid number format');
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\n' || this.peek() === '\r') {
      this.pos++;
    }
  }

  private peek(): string {
    return this.input[this.pos] ?? '\0';
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  public isAtEnd(): boolean {
    this.skipWhitespace();
    return this.pos >= this.input.length;
  }
}
