// Evaluator module implementing a recursive-descent parser for arithmetic expressions.
// Supports +, -, *, /, parentheses, decimal numbers, and unary minus.
// Returns either a numeric result or a structured error.

export type EvalResult = { result?: number; error?: EvalError };

export interface EvalError {
  code: string; // e.g., "SYNTAX_ERROR", "DIV_ZERO"
  message: string;
}

// Token definitions
type Token =
  | { type: "Number"; value: number }
  | { type: "Operator"; value: "+" | "-" | "*" | "/" }
  | { type: "Paren"; value: "(" | ")" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const length = input.length;
  let i = 0;
  while (i < length) {
    const char = input[i];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i++; // skip whitespace
      continue;
    }
    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ type: "Operator", value: char as any });
      i++;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: "Paren", value: char as any });
      i++;
      continue;
    }
    // Number (integer or decimal)
    if (char >= "0" && char <= "9" || char === ".") {
      let numStr = "";
      let dotCount = 0;
      while (i < length && ((input[i] >= "0" && input[i] <= "9") || input[i] === ".")) {
        if (input[i] === ".") {
          dotCount++;
          if (dotCount > 1) break; // stop at second dot, will cause syntax error later
        }
        numStr += input[i];
        i++;
      }
      if (numStr === "." || numStr === "") {
        // Invalid number token
        throw { code: "SYNTAX_ERROR", message: "Invalid number format" } as EvalError;
      }
      tokens.push({ type: "Number", value: parseFloat(numStr) });
      continue;
    }
    // Unsupported character
    throw { code: "SYNTAX_ERROR", message: `Unsupported character '${char}'` } as EvalError;
  }
  return tokens;
}

// Parser class maintains token list and current position
class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private consume(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  // Entry point
  public parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      const token = this.peek();
      if (token && token.type === "Operator" && (token.value === "+" || token.value === "-")) {
        this.consume();
        const right = this.parseTerm();
        if (token.value === "+") value += right; else value -= right;
      } else {
        break;
      }
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (true) {
      const token = this.peek();
      if (token && token.type === "Operator" && (token.value === "*" || token.value === "/")) {
        this.consume();
        const right = this.parseFactor();
        if (token.value === "*") {
          value *= right;
        } else {
          // Division – check for zero
          if (right === 0) {
            throw { code: "DIV_ZERO", message: "Cannot divide by zero" } as EvalError;
          }
          value /= right;
        }
      } else {
        break;
      }
    }
    return value;
  }

  private parseFactor(): number {
    const token = this.peek();
    if (!token) {
      throw { code: "SYNTAX_ERROR", message: "Unexpected end of input" } as EvalError;
    }
    // Unary plus/minus
    if (token.type === "Operator" && (token.value === "+" || token.value === "-")) {
      this.consume();
      const factor = this.parseFactor();
      return token.value === "-" ? -factor : factor;
    }
    if (token.type === "Number") {
      this.consume();
      return token.value;
    }
    if (token.type === "Paren" && token.value === "(") {
      this.consume(); // '('
      const expr = this.parseExpression();
      const next = this.peek();
      if (!next || next.type !== "Paren" || next.value !== ")") {
        throw { code: "SYNTAX_ERROR", message: "Missing closing parenthesis" } as EvalError;
      }
      this.consume(); // ')'
      return expr;
    }
    // If we reach here, it's an unexpected token
    throw { code: "SYNTAX_ERROR", message: `Unexpected token '${(token as any).value}'` } as EvalError;
  }
}

/**
 * Evaluates an arithmetic expression string.
 * Returns { result } on success or { error } on failure.
 */
export function evaluate(expression: string): EvalResult {
  try {
    const tokens = tokenize(expression);
    const parser = new Parser(tokens);
    const result = parser.parseExpression();
    // Ensure all tokens were consumed
    if (parser['pos'] < tokens.length) {
      // Extra tokens after valid expression
      throw { code: "SYNTAX_ERROR", message: "Unexpected token after end of expression" } as EvalError;
    }
    return { result };
  } catch (e) {
    const err = e as EvalError;
    return { error: err };
  }
}
