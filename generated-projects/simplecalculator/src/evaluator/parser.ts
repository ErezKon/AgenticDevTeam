export function evaluateExpression(expr: string): number {
  // Remove whitespace for simplicity
  const s = expr.replace(/\s+/g, '');
  let index = 0;

  const peek = () => s[index];
  const get = () => s[index++];

  const parseExpression = (): number => {
    let value = parseTerm();
    while (true) {
      const op = peek();
      if (op === '+' || op === '-') {
        // Disallow consecutive binary operators like ++ or +- etc.
        const next = s[index + 1];
        if (next === '+' || next === '-') {
          throw new Error('SYNTAX_ERROR');
        }
        get(); // consume operator
        const rhs = parseTerm();
        value = op === '+' ? value + rhs : value - rhs;
      } else {
        break;
      }
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (true) {
      const op = peek();
      if (op === '*' || op === '/') {
        // Disallow consecutive binary operators like ** or */ etc.
        const next = s[index + 1];
        if (next === '*' || next === '/' || next === '+' || next === '-') {
          throw new Error('SYNTAX_ERROR');
        }
        get(); // consume operator
        const rhs = parseFactor();
        if (op === '*') {
          value *= rhs;
        } else {
          if (rhs === 0) {
            throw new Error('DIV_ZERO');
          }
          value /= rhs;
        }
      } else {
        break;
      }
    }
    return value;
  };

  const parseFactor = (): number => {
    // Handle unary plus/minus
    let sign = 1;
    while (peek() === '+' || peek() === '-') {
      if (peek() === '-') sign = -sign;
      get();
    }
    if (peek() === '(') {
      get(); // '('
      const val = parseExpression();
      if (peek() !== ')') {
        throw new Error('SYNTAX_ERROR');
      }
      get(); // ')'
      return sign * val;
    }
    // Parse number (integer or decimal)
    let numStr = '';
    while (peek() && /[0-9.]/.test(peek())) {
      numStr += get();
    }
    if (numStr.length === 0) {
      throw new Error('SYNTAX_ERROR');
    }
    const num = Number(numStr);
    if (isNaN(num)) {
      throw new Error('SYNTAX_ERROR');
    }
    return sign * num;
  };

  const result = parseExpression();
  if (index < s.length) {
    // Extra characters left – syntax error
    throw new Error('SYNTAX_ERROR');
  }
  return result;
}
