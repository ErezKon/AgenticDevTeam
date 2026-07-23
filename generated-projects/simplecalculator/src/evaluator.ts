/**
 * Calculator Engine - expression evaluator
 * Supports +, -, *, /, parentheses, decimals, and unary minus.
 * Returns a numeric result or an error string for invalid expressions.
 */

export function evaluate(expression: string): number | string {
  // Returns numeric result or an error string.

  if (!expression) return "Error: Invalid expression";

  // Insert explicit 0 for unary minus (e.g., -3 => 0-3, ( -2) => (0-2)
  const sanitized = expression.replace(/(^|[\(\+\-\*\/])\-/g, "$10-");

  // Validate characters: only allowed characters should be present
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
    return "Error: Invalid character";
  }
  // Detect invalid number format (e.g., multiple decimal points in a number)
  if (/\.\./.test(expression)) {
    return "Error: Invalid number format";
  }
  const tokens = sanitized.match(/\d+(?:\.\d+)?|[+\-*/()]|\s+/g);
  if (!tokens) return "Error: Invalid expression";


  const values: number[] = [];
  const ops: string[] = [];

  const precedence = (op: string) => {
    if (op === '+' || op === '-') return 1;
    if (op === '*' || op === '/') return 2;
    return 0;
  };

  const applyOp = () => {
    // This function may throw errors for invalid operations; callers should handle them
    const op = ops.pop();
    if (!op) return;
    const b = values.pop();
    const a = values.pop();
    if (a === undefined || b === undefined) {
      throw new Error('Insufficient values');
    }
    let result: number;
    switch (op) {
      case '+':
        result = a + b;
        break;
      case '-':
        result = a - b;
        break;
      case '*':
        result = a * b;
        break;
      case '/':
        if (b === 0) {
          throw new Error('Division by zero');
        }
        result = a / b;
        break;
      default:
        throw new Error('Unknown operator');
    }
    values.push(result);
  };



    try {
    for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (token === '') continue; // skip whitespace
    if (!isNaN(Number(token))) {
      values.push(Number(token));
    } else if (token === '(') {
      ops.push(token);
    } else if (token === ')') {
      // Resolve until matching '('
      while (ops.length && ops[ops.length - 1] !== '(') {
        applyOp();
      }
      if (!ops.length) {
        return "Error: Mismatched parentheses";
      }
      ops.pop(); // remove '('
    } else if (['+', '-', '*', '/'].includes(token)) {
      while (
        ops.length &&
        precedence(ops[ops.length - 1]) >= precedence(token)
      ) {
        if (ops[ops.length - 1] === '(') break;
        applyOp();
      }
      ops.push(token);
    } else {
      return "Error: Invalid expression";
    }
  }

  // After processing all tokens, apply remaining ops
  while (ops.length) {
    if (ops[ops.length - 1] === '(' || ops[ops.length - 1] === ')') {
      return "Error: Mismatched parentheses";
    }
    applyOp();
  }

  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'Division by zero') return 'Error: Division by zero';
    }
    return 'Error: Invalid expression';
  }

  if (values.length !== 1) {
    return "Error: Invalid expression";
  }
  return values[0];
}
