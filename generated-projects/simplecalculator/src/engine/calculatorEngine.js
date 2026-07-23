// Calculator Engine module
// Exposes evaluate(expression: string): number
// Implements tokenization, parsing with operator precedence and parentheses, and evaluation.
// Throws Error with messages for various error conditions.

/**
 * Token types
 */
const TOKEN_NUMBER = 'NUMBER';
const TOKEN_OPERATOR = 'OPERATOR';
const TOKEN_PAREN = 'PAREN';

/**
 * Operator precedence map (higher number = higher precedence)
 */
const PRECEDENCE = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
};

/**
 * Tokenizer: converts expression string into an array of tokens.
 * Supports numbers (including decimals) and unary minus by attaching it to the number.
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const length = expr.length;
  const isDigit = (ch) => /[0-9]/.test(ch);
  const isWhitespace = (ch) => /\s/.test(ch);

  while (i < length) {
    const ch = expr[i];
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: TOKEN_PAREN, value: ch });
      i++;
      continue;
    }
    if (['+', '-', '*', '/'].includes(ch)) {
      // Determine if this is a unary minus (part of a number)
      if (ch === '-') {
        const prev = tokens[tokens.length - 1];
        const isUnary =
          !prev || // start of expression
          (prev.type === TOKEN_OPERATOR && prev.value !== ')') ||
          (prev.type === TOKEN_PAREN && prev.value === '(');
        if (isUnary) {
          // Parse a negative number
          let numStr = '-';
          i++;
          // Must have at least one digit or a decimal point after '-'
          if (i < length && (isDigit(expr[i]) || expr[i] === '.')) {
            while (i < length && (isDigit(expr[i]) || expr[i] === '.')) {
              numStr += expr[i];
              i++;
            }
            if (numStr === '-' || numStr === '-.') {
              throw new Error('Invalid syntax');
            }
            tokens.push({ type: TOKEN_NUMBER, value: parseFloat(numStr) });
            continue;
          } else {
            // Lone '-' not followed by number -> treat as operator (invalid later)
            tokens.push({ type: TOKEN_OPERATOR, value: ch });
            i++;
            continue;
          }
        }
      }
      // Binary operator
      tokens.push({ type: TOKEN_OPERATOR, value: ch });
      i++;
      continue;
    }
    // Number (including decimal)
    if (isDigit(ch) || ch === '.') {
      let numStr = '';
      while (i < length && (isDigit(expr[i]) || expr[i] === '.')) {
        numStr += expr[i];
        i++;
      }
      if (numStr === '.' || numStr === '') {
        throw new Error('Invalid syntax');
      }
      tokens.push({ type: TOKEN_NUMBER, value: parseFloat(numStr) });
      continue;
    }
    // Unknown character
    throw new Error('Invalid syntax');
  }
  return tokens;
}

/**
 * Shunting-yard algorithm to convert tokens to Reverse Polish Notation (RPN).
 */
function toRPN(tokens) {
  const outputQueue = [];
  const operatorStack = [];
  const isOperator = (t) => t.type === TOKEN_OPERATOR;
  const isNumber = (t) => t.type === TOKEN_NUMBER;
  const isParen = (t) => t.type === TOKEN_PAREN;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isNumber(token)) {
      outputQueue.push(token);
    } else if (isOperator(token)) {
      // Validate syntax: previous token cannot be operator (except unary handled earlier)
      const prev = tokens[i - 1];
      if (prev && isOperator(prev) && prev.value !== ')') {
        throw new Error('Invalid syntax');
      }
      while (
        operatorStack.length > 0 &&
        isOperator(operatorStack[operatorStack.length - 1]) &&
        PRECEDENCE[operatorStack[operatorStack.length - 1].value] >= PRECEDENCE[token.value]
      ) {
        outputQueue.push(operatorStack.pop());
      }
      operatorStack.push(token);
    } else if (isParen(token)) {
      if (token.value === '(') {
        operatorStack.push(token);
      } else {
        // token is ')'
        let foundLeft = false;
        while (operatorStack.length > 0) {
          const op = operatorStack.pop();
          if (op.type === TOKEN_PAREN && op.value === '(') {
            foundLeft = true;
            break;
          } else {
            outputQueue.push(op);
          }
        }
        if (!foundLeft) {
          throw new Error('Unmatched parentheses');
        }
      }
    }
  }
  // After processing tokens, pop remaining operators
  while (operatorStack.length > 0) {
    const op = operatorStack.pop();
    if (op.type === TOKEN_PAREN) {
      throw new Error('Unmatched parentheses');
    }
    outputQueue.push(op);
  }
  return outputQueue;
}

/**
 * Evaluate RPN expression.
 */
function evaluateRPN(rpnTokens) {
  const stack = [];
  for (const token of rpnTokens) {
    if (token.type === TOKEN_NUMBER) {
      stack.push(token.value);
    } else if (token.type === TOKEN_OPERATOR) {
      if (stack.length < 2) {
        throw new Error('Invalid syntax');
      }
      const b = stack.pop();
      const a = stack.pop();
      let result;
      switch (token.value) {
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
          throw new Error('Invalid syntax');
      }
      stack.push(result);
    }
  }
  if (stack.length !== 1) {
    throw new Error('Invalid syntax');
  }
  return stack[0];
}

/**
 * Public API: evaluate an arithmetic expression string.
 * @param {string} expression
 * @returns {number}
 * @throws {Error} with messages for syntax errors, division by zero, etc.
 */
function evaluate(expression) {
  if (typeof expression !== 'string') {
    throw new Error('Invalid syntax');
  }
  const tokens = tokenize(expression);
  const rpn = toRPN(tokens);
  const result = evaluateRPN(rpn);
  return result;
}

export { evaluate };
