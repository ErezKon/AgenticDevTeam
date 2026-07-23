// Expression Evaluator Module
// Supports +, -, *, /, parentheses, decimals, negatives
// Returns { result: number } on success or { error: { code: string, message: string } } on failure

export interface EvalResult {
  result?: number;
  error?: { code: string; message: string };
}

// Token types
type Token =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: string }
  | { type: 'paren'; value: '(' | ')' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9' || ch === '.') {
      let numStr = '';
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
        numStr += expr[i];
        i++;
      }
      const num = Number(numStr);
      if (isNaN(num)) {
        throw new Error('Invalid number');
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'operator', value: ch });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    throw new Error('Invalid character');
  }
  return tokens;
}

function shuntingYard(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const ops: Token[] = [];
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const associativity: Record<string, 'left'> = { '+': 'left', '-': 'left', '*': 'left', '/': 'left' };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'number') {
      output.push(token);
    } else if (token.type === 'operator') {
      while (
        ops.length > 0 &&
        ops[ops.length - 1].type === 'operator' &&
        ((associativity[token.value] === 'left' && precedence[token.value] <= precedence[ops[ops.length - 1].value]) ||
          (associativity[token.value] === 'right' && precedence[token.value] < precedence[ops[ops.length - 1].value]))
      ) {
        output.push(ops.pop() as Token);
      }
      ops.push(token);
    } else if (token.type === 'paren') {
      if (token.value === '(') {
        ops.push(token);
      } else {
        // token.value === ')'
        while (ops.length > 0 && ops[ops.length - 1].type !== 'paren') {
          output.push(ops.pop() as Token);
        }
        if (ops.length === 0) {
          throw new Error('Mismatched parentheses');
        }
        // pop '('
        ops.pop();
      }
    }
  }
  while (ops.length > 0) {
    const op = ops.pop() as Token;
    if (op.type === 'paren') {
      throw new Error('Mismatched parentheses');
    }
    output.push(op);
  }
  return output;
}

function evaluateRPN(rpn: Token[]): number {
  const stack: number[] = [];
  for (const token of rpn) {
    if (token.type === 'number') {
      stack.push(token.value);
    } else if (token.type === 'operator') {
      if (stack.length < 2) {
        throw new Error('Insufficient values');
      }
      const b = stack.pop() as number;
      const a = stack.pop() as number;
      let res: number;
      switch (token.value) {
        case '+':
          res = a + b;
          break;
        case '-':
          res = a - b;
          break;
        case '*':
          res = a * b;
          break;
        case '/':
          if (b === 0) {
            const err = new Error('Division by zero');
            // attach code
            (err as any).code = 'DIV_ZERO';
            throw err;
          }
          res = a / b;
          break;
        default:
          throw new Error('Unknown operator');
      }
      stack.push(res);
    }
  }
  if (stack.length !== 1) {
    throw new Error('Invalid expression');
  }
  return stack[0];
}

export function evaluateExpression(expr: string): EvalResult {
  try {
    const tokens = tokenize(expr);
    // Handle unary minus: insert 0 before leading '-' or after '('
    const processed: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        token.type === 'operator' &&
        token.value === '-' &&
        (i === 0 || (tokens[i - 1].type === 'paren' && tokens[i - 1].value === '('))
      ) {
        // unary minus, treat as (0 - number)
        processed.push({ type: 'number', value: 0 });
        processed.push(token);
      } else {
        processed.push(token);
      }
    }
    const rpn = shuntingYard(processed);
    const result = evaluateRPN(rpn);
    // Round to 10 decimal places to avoid floating noise
    const rounded = Number(result.toFixed(10));
    return { result: rounded };
  } catch (e: any) {
    if (e.code === 'DIV_ZERO') {
      return { error: { code: 'DIV_ZERO', message: 'Cannot divide by zero' } };
    }
    return { error: { code: 'SYNTAX_ERROR', message: e.message } };
  }
}
