/**
 * Simple arithmetic expression evaluator supporting +, -, *, /, parentheses, decimals, and unary +/-.
 * Returns either a numeric result or an error object.
 */

export interface EvalError {
  code: string;
  message: string;
}

export interface EvalResult {
  result?: number;
  error?: EvalError;
}

class DivisionByZeroError extends Error {
  public readonly code = 'DIV_ZERO';
  constructor() {
    super('Cannot divide by zero');
    this.name = 'DivisionByZeroError';
  }
}

/**
 * Evaluate an arithmetic expression string.
 * @param expr The expression to evaluate.
 * @returns EvalResult containing either result or error.
 */
export function evaluate(expr: string): EvalResult {
  try {
    const parser = new Parser(expr);
    const value = parser.parseExpression();
    // Ensure entire input consumed
    parser.skipWhitespace();
    if (!parser.isAtEnd()) {
      throw new Error('Unexpected token');
    }
    return { result: value };
  } catch (e: any) {
    if (e instanceof DivisionByZeroError) {
      return { error: { code: e.code, message: e.message } };
    }
    // For other errors, return a generic syntax error
    return { error: { code: 'SYNTAX_ERROR', message: e.message } };
  }
}

class Parser {
  private readonly input: string;
  private pos: number = 0;

  constructor(input: string) {
    this.input = input;
  }

  // Public entry point used by evaluate
  public parseExpression(): number {
    this.skipWhitespace();
    const value = this.parseAddSub();
    this.skipWhitespace();
    return value;
  }

  // Helpers
  public isAtEnd(): boolean {
    return this.pos >= this.input.length;
  }

  public skipWhitespace(): void {
    while (!this.isAtEnd() && /\s/.test(this.peek())) {
      this.pos++;
    }
  }

  private peek(): string {
    return this.input[this.pos];
  }

  private consume(): string {
    return this.input[this.pos++];
  }

  // Grammar implementation
  // addSub := mulDiv (('+' | '-') mulDiv)*
  private parseAddSub(): number {
    let value = this.parseMulDiv();
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '+' || ch === '-') {
        this.consume();
        const right = this.parseMulDiv();
        if (ch === '+') {
          value += right;
        } else {
          value -= right;
        }
      } else {
        break;
      }
    }
    return value;
  }

  // mulDiv := factor (('*' | '/') factor)*
  private parseMulDiv(): number {
    let value = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '*' || ch === '/') {
        this.consume();
        const right = this.parseFactor();
        if (ch === '*') {
          value *= right;
        } else {
          // Division – check for zero divisor
          if (right === 0) {
            throw new DivisionByZeroError();
          }
          value /= right;
        }
      } else {
        break;
      }
    }
    return value;
  }

  // factor := number | '(' addSub ')' | ('+' | '-') factor
  private parseFactor(): number {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '+') {
      this.consume();
      return this.parseFactor();
    }
    if (ch === '-') {
      this.consume();
      return -this.parseFactor();
    }
    if (ch === '(') {
      this.consume();
      const value = this.parseAddSub();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      this.consume();
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.pos;
    while (!this.isAtEnd() && /[0-9.]/.test(this.peek())) {
      this.consume();
    }
    if (start === this.pos) {
      throw new Error('Number expected');
    }
    const numStr = this.input.slice(start, this.pos);
    const value = parseFloat(numStr);
    if (isNaN(value)) {
      throw new Error('Invalid number');
    }
    return value;
  }
}
