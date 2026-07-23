/**
 * Calculator Engine evaluate function.
 * Implements a recursive‑descent parser for arithmetic expressions.
 * Supports +, -, *, /, parentheses, decimals, and unary +/-.
 * Returns a result rounded to 10 decimal places or an error string.
 */

export type EvalResult = { result?: number; error?: string };

// Token definitions
enum TokenType {
  Number,
  Plus,
  Minus,
  Multiply,
  Divide,
  LParen,
  RParen,
  EOF,
}

interface Token {
  type: TokenType;
  value?: number; // only for Number tokens
}

class Lexer {
  private pos = 0;
  private currentChar: string | null;
  constructor(private readonly text: string) {
    this.currentChar = this.text.charAt(this.pos) || null;
  }

  private advance() {
    this.pos++;
    this.currentChar = this.text.charAt(this.pos) || null;
  }

  private skipWhitespace() {
    while (this.currentChar && /\s/.test(this.currentChar)) {
      this.advance();
    }
  }

  private number(): number {
    let numStr = '';
    let dotCount = 0;
    while (
      this.currentChar &&
      (/[0-9]/.test(this.currentChar) || this.currentChar === '.')
    ) {
      if (this.currentChar === '.') {
        dotCount++;
        if (dotCount > 1) break; // invalid number, will be caught later
      }
      numStr += this.currentChar;
      this.advance();
    }
    return parseFloat(numStr);
  }

  public getNextToken(): Token {
    while (this.currentChar) {
      if (/\s/.test(this.currentChar)) {
        this.skipWhitespace();
        continue;
      }
      if (/[0-9]/.test(this.currentChar) || this.currentChar === '.') {
        const value = this.number();
        if (isNaN(value)) {
          throw new Error('Invalid syntax');
        }
        return { type: TokenType.Number, value };
      }
      switch (this.currentChar) {
        case '+':
          this.advance();
          return { type: TokenType.Plus };
        case '-':
          this.advance();
          return { type: TokenType.Minus };
        case '*':
          this.advance();
          return { type: TokenType.Multiply };
        case '/':
          this.advance();
          return { type: TokenType.Divide };
        case '(':
          this.advance();
          return { type: TokenType.LParen };
        case ')':
          this.advance();
          return { type: TokenType.RParen };
        default:
          throw new Error('Invalid syntax');
      }
    }
    return { type: TokenType.EOF };
  }
}

class Parser {
  private currentToken: Token;
  constructor(private readonly lexer: Lexer) {
    this.currentToken = this.lexer.getNextToken();
  }

  private eat(type: TokenType) {
    if (this.currentToken.type === type) {
      this.currentToken = this.lexer.getNextToken();
    } else {
      if (type === TokenType.RParen) {
        throw new Error('Mismatched parentheses');
      }
      throw new Error('Invalid syntax');
    }
  }

  // Grammar:
  // expr   : term ((PLUS | MINUS) term)*
  // term   : factor ((MUL | DIV) factor)*
  // factor : (PLUS | MINUS)? primary
  // primary: NUMBER | LPAREN expr RPAREN

  public parse(): number {
    const result = this.expr();
    // If there are leftover tokens, determine the specific error
    if (this.currentToken.type === TokenType.RParen) {
      throw new Error('Mismatched parentheses');
    }
    if (this.currentToken.type !== TokenType.EOF) {
      // leftover tokens indicate syntax error
      throw new Error('Invalid syntax');
    }
    return result;
  }

  private expr(): number {
    let result = this.term();
    while (
      this.currentToken.type === TokenType.Plus ||
      this.currentToken.type === TokenType.Minus
    ) {
      const token = this.currentToken;
      if (token.type === TokenType.Plus) {
        this.eat(TokenType.Plus);
        // Disallow consecutive plus operators (e.g., 2++2)
        if (this.currentToken.type === TokenType.Plus) {
          throw new Error('Invalid syntax');
        }
        result = result + this.term();
      } else if (token.type === TokenType.Minus) {
        this.eat(TokenType.Minus);
        // Allow consecutive minus (e.g., 2--3) as unary minus
        result = result - this.term();
      }
    }
    return result;
  }

  private term(): number {
    let result = this.factor();
    while (
      this.currentToken.type === TokenType.Multiply ||
      this.currentToken.type === TokenType.Divide
    ) {
      const token = this.currentToken;
      if (token.type === TokenType.Multiply) {
        this.eat(TokenType.Multiply);
        result = result * this.factor();
      } else if (token.type === TokenType.Divide) {
        this.eat(TokenType.Divide);
        const divisor = this.factor();
        if (divisor === 0) {
          throw new Error('Division by zero');
        }
        result = result / divisor;
      }
    }
    return result;
  }

  private factor(): number {
    // handle unary plus/minus
    if (this.currentToken.type === TokenType.Plus) {
      this.eat(TokenType.Plus);
      return +this.factor();
    }
    if (this.currentToken.type === TokenType.Minus) {
      this.eat(TokenType.Minus);
      return -this.factor();
    }
    return this.primary();
  }

  private primary(): number {
    const token = this.currentToken;
    if (token.type === TokenType.Number && token.value !== undefined) {
      this.eat(TokenType.Number);
      return token.value;
    } else if (token.type === TokenType.LParen) {
      this.eat(TokenType.LParen);
      const result = this.expr();
      if (this.currentToken.type !== TokenType.RParen) {
        throw new Error('Mismatched parentheses');
      }
      this.eat(TokenType.RParen);
      return result;
    } else if (token.type === TokenType.RParen) {
      // Unexpected closing parenthesis
      throw new Error('Mismatched parentheses');
    } else {
      throw new Error('Invalid syntax');
    }
  }
}

/**
 * Public API: evaluate an arithmetic expression.
 * Returns an object with either `result` (rounded to 10 decimal places) or `error`.
 */
export function evaluate(expr: string): EvalResult {
  try {
    const lexer = new Lexer(expr);
    const parser = new Parser(lexer);
    const rawResult = parser.parse();
    // Round to at most 10 decimal places
    const rounded = Number(rawResult.toFixed(10));
    return { result: rounded };
  } catch (e: unknown) {
    let msg = 'Invalid syntax';
    if (e instanceof Error && typeof e.message === 'string') {
      msg = e.message;
    }
    if (
      msg === 'Division by zero' ||
      msg === 'Mismatched parentheses' ||
      msg === 'Invalid syntax'
    ) {
      return { error: msg };
    }
    // Fallback for unexpected errors
    return { error: 'Invalid syntax' };

  }
}
