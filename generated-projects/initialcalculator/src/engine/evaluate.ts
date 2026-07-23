export type EvalResult =
  | { result: number }
  | { error: string };

/** Custom error type for evaluation errors */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/**
 * Safe evaluator for arithmetic expressions supporting +, -, *, /, parentheses,
 * decimals and negative numbers. Implements a shunting‑yard parser to avoid
 * using `eval` or the `Function` constructor. Returns a typed result or error.
 */
export function evaluate(expression: string): EvalResult {
  try {
    const MAX_LENGTH = 100; // limit expression length to prevent abuse
    const expr = expression.trim();
    if (expr === '') {
      throw new EvalError('Invalid syntax');
    }
    if (expr.length > MAX_LENGTH) {
      throw new EvalError('Expression too long');
    }
    // Allowed characters: digits, operators, parentheses, decimal point, whitespace
    if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
      throw new EvalError('Invalid syntax');
    }
    // Tokenize
    type Token =
      | { type: 'number'; value: number }
      | { type: 'operator'; value: string }
      | { type: 'paren'; value: '(' | ')' };
    const tokens: Token[] = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (' \t\n'.includes(ch)) {
        i++;
        continue;
      }
      if ('0123456789.'.includes(ch)) {
        let numStr = '';
        while (i < expr.length && '0123456789.'.includes(expr[i])) {
          numStr += expr[i];
          i++;
        }
        if (numStr.split('.').length > 2) {
          throw new EvalError('Invalid syntax');
        }
        const num = Number(numStr);
        if (isNaN(num)) throw new EvalError('Invalid syntax');
        tokens.push({ type: 'number', value: num });
        continue;
      }
      if ('+-*/'.includes(ch)) {
        tokens.push({ type: 'operator', value: ch });
        i++;
        continue;
      }
      if (ch === '(' || ch === ')') {
        tokens.push({ type: 'paren', value: ch as '(' | ')' });
        i++;
        continue;
      }
      // Should never reach due to regex check
      throw new EvalError('Invalid syntax');
    }
    // Basic syntax validation: balanced parentheses and no invalid consecutive operators
    let prev: Token | null = null;
    let balance = 0;
    for (const token of tokens) {
      if (token.type === 'paren') {
        if (token.value === '(') balance++;
        else balance--;
        if (balance < 0) throw new EvalError('Mismatched parentheses');
      }
      if (token.type === 'operator') {
        if (prev && prev.type === 'operator' && token.value !== '-') {
          // two binary operators in a row (except unary minus)
          throw new EvalError('Invalid syntax');
        }
      }
      prev = token;
    }
    if (balance !== 0) throw new EvalError('Mismatched parentheses');

    // Shunting‑yard to RPN
    const outputQueue: Token[] = [];
    const operatorStack: Token[] = [];
    const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, 'u-': 3 };
    const isLeftAssociative = (op: string) => true; // all left‑associative

    for (let idx = 0; idx < tokens.length; idx++) {
      const token = tokens[idx];
      if (token.type === 'number') {
        outputQueue.push(token);
      } else if (token.type === 'operator') {
        // Detect unary minus
        if (
          token.value === '-' &&
          (idx === 0 ||
            (tokens[idx - 1].type === 'operator' && tokens[idx - 1].value !== ')') ||
            (tokens[idx - 1].type === 'paren' && tokens[idx - 1].value === '('))
        ) {
          const unary: Token = { type: 'operator', value: 'u-' };
          while (
            operatorStack.length > 0 &&
            operatorStack[operatorStack.length - 1].type === 'operator' &&
            ((precedence[operatorStack[operatorStack.length - 1].value] > precedence[unary.value]) ||
              (precedence[operatorStack[operatorStack.length - 1].value] === precedence[unary.value] &&
                isLeftAssociative(unary.value)))
          ) {
            outputQueue.push(operatorStack.pop() as Token);
          }
          operatorStack.push(unary);
          continue;
        }
        while (
          operatorStack.length > 0 &&
          operatorStack[operatorStack.length - 1].type === 'operator' &&
          ((precedence[operatorStack[operatorStack.length - 1].value] > precedence[token.value]) ||
            (precedence[operatorStack[operatorStack.length - 1].value] === precedence[token.value] &&
              isLeftAssociative(token.value)))
        ) {
          outputQueue.push(operatorStack.pop() as Token);
        }
        operatorStack.push(token);
      } else if (token.type === 'paren') {
        if (token.value === '(') {
          operatorStack.push(token);
        } else {
          // token is ')'
          while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type !== 'paren') {
            outputQueue.push(operatorStack.pop() as Token);
          }
          if (operatorStack.length === 0) throw new EvalError('Mismatched parentheses');
          // Pop the '('
          operatorStack.pop();
        }
      }
    }
    while (operatorStack.length > 0) {
      const op = operatorStack.pop() as Token;
      if (op.type === 'paren') throw new EvalError('Mismatched parentheses');
      outputQueue.push(op);
    }

    // Evaluate RPN
    const stack: number[] = [];
    for (const token of outputQueue) {
      if (token.type === 'number') {
        stack.push(token.value);
      } else if (token.type === 'operator') {
        if (token.value === 'u-') {
          if (stack.length < 1) throw new EvalError('Invalid syntax');
          const a = stack.pop() as number;
          const res = -a;
          if (!Number.isFinite(res) || Math.abs(res) > Number.MAX_SAFE_INTEGER) {
            throw new EvalError('Numeric overflow');
          }
          const rounded = Math.round(res * 1e10) / 1e10;
          stack.push(rounded);
          continue;
        }
        if (stack.length < 2) throw new EvalError('Invalid syntax');
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
            if (b === 0) throw new EvalError('Division by zero');
            res = a / b;
            break;
          default:
            throw new EvalError('Invalid syntax');
        }
        if (!Number.isFinite(res) || Math.abs(res) > Number.MAX_SAFE_INTEGER) {
          throw new EvalError('Numeric overflow');
        }
        const rounded = Math.round(res * 1e10) / 1e10;
        stack.push(rounded);
      }
    }
    if (stack.length !== 1) throw new EvalError('Invalid syntax');
    const finalResult = Math.round(stack[0] * 1e10) / 1e10;
    if (!Number.isFinite(finalResult) || Math.abs(finalResult) > Number.MAX_SAFE_INTEGER) {
      throw new EvalError('Numeric overflow');
    }
    return { result: finalResult };
  } catch (e) {
    if (e instanceof EvalError) {
      return { error: e.message };
    }
    // Unexpected errors re‑throw
    throw e;
  }
}
