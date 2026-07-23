/**
 * Calculator Engine evaluator module.
 * Provides a pure function `evaluate` that parses an arithmetic expression
 * containing +, -, *, /, parentheses, decimal numbers and unary negatives.
 * It returns either a numeric result or an error string.
 */

export type EvalResult = number | string;

/**
 * Evaluate an arithmetic expression.
 * @param expr The expression string (e.g., "3+4*2/(1-5)")
 * @returns numeric result or error message string.
 */
export function evaluate(expr: string): EvalResult {
  try {
  // Remove whitespace
  const input = expr.replace(/\s+/g, "");
  if (input.length === 0) return "Error: Invalid expression";

  const values: number[] = [];
  const ops: string[] = [];

  const precedence = (op: string): number => {
    if (op === '+' || op === '-') return 1;
    if (op === '*' || op === '/') return 2;
    return 0;
  };

  const applyOp = (): void => {
    const op = ops.pop();
    if (!op) return;
    // Unary minus handling (if only one value on stack)
    if ((op === '+' || op === '-') && values.length < 2) {
      const val = values.pop();
      if (val === undefined) return;
      values.push(op === '+' ? +val : -val);
      return;
    }
    const b = values.pop();
    const a = values.pop();
    if (a === undefined || b === undefined) {
      // Invalid state
      return;
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
          throw new Error('DIV_ZERO');
        }
        result = a / b;
        break;
      default:
        return;
    }
    values.push(result);
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch >= '0' && ch <= '9' || ch === '.') {
      // Number parsing
      let numStr = '';
      while (i < input.length && (input[i] >= '0' && input[i] <= '9' || input[i] === '.')) {
        numStr += input[i];
        i++;
      }
      const num = parseFloat(numStr);
      if (Number.isNaN(num)) {
        return "Error: Invalid expression";
      }
      values.push(num);
      continue; // skip i++ at end
    } else if (ch === '(') {
      ops.push(ch);
    } else if (ch === ')') {
      // Solve entire bracket
      let found = false;
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top === '(') {
          ops.pop();
          found = true;
          break;
        }
        applyOp();
      }
      if (!found) {
        return "Error: Mismatched parentheses";
      }
    } else if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      // Handle unary minus/plus
      const prev = i === 0 ? null : input[i - 1];
      if ((ch === '+' || ch === '-') && (i === 0 || prev === '(' || prev === '+' || prev === '-' || prev === '*' || prev === '/')) {
        // Unary operator: treat as 0 <op> number later, push 0 then operator
        values.push(0);
      }
      while (ops.length && precedence(ops[ops.length - 1]) >= precedence(ch)) {
        if (ops[ops.length - 1] === '(') break;
        applyOp();
      }
      ops.push(ch);
    } else {
      return "Error: Invalid expression";
    }
    i++;
  }

  while (ops.length) {
    if (ops[ops.length - 1] === '(' || ops[ops.length - 1] === ')') {
      return "Error: Mismatched parentheses";
    }
    applyOp();
  }

  if (values.length !== 1) {
    return "Error: Invalid expression";
  }
  return values[0];
}
