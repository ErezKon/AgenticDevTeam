export type EvalResult =
  | { result: number }
  | { error: string };

/**
 * Safe evaluator for arithmetic expressions supporting +, -, *, /, parentheses,
 * decimals and negative numbers. Implements a shunting‑yard parser to avoid
 * using `eval` or the `Function` constructor. Performs thorough validation and
 * returns a typed result or error object.
 */
export function evaluate(expression: string): EvalResult {
  const MAX_LENGTH = 100; // limit expression length to prevent abuse

  // Trim whitespace
  const expr = expression.trim();
  if (expr === "") {
    return { error: "Invalid syntax" };
  }

  if (expr.length > MAX_LENGTH) {
    return { error: "Expression too long" };
  }

  // Validate allowed characters (digits, operators, parentheses, decimal point, whitespace)
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return { error: "Invalid syntax" };
  }

  // Tokenize the expression
  type Token = { type: "number"; value: number } | { type: "operator"; value: string } | { type: "paren"; value: "(" | ")" };
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (" \t\n".includes(ch)) {
      i++;
      continue;
    }
    if ("0123456789.".includes(ch)) {
      let numStr = "";
      while (i < expr.length && "0123456789.".includes(expr[i])) {
        numStr += expr[i];
        i++;
      }
      if (numStr.split('.').length > 2) {
        return { error: "Invalid syntax" };
      }
      const num = Number(numStr);
      if (isNaN(num)) return { error: "Invalid syntax" };
      tokens.push({ type: "number", value: num });
      continue;
    }
    if ("+-*/".includes(ch)) {
      tokens.push({ type: "operator", value: ch });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch as "(" | ")" });
      i++;
      continue;
    }
    // Should never reach here due to regex check
    return { error: "Invalid syntax" };
  }

  // Basic syntax validation: no consecutive operators (except unary minus) and balanced parentheses
  let prev: Token | null = null;
  let balance = 0;
  for (const token of tokens) {
    if (token.type === "paren") {
      if (token.value === "(") balance++;
      else balance--;
      if (balance < 0) return { error: "Mismatched parentheses" };
    }
    if (token.type === "operator") {
      if (prev && prev.type === "operator" && token.value !== "-") {
        // two binary operators in a row
        return { error: "Invalid syntax" };
      }
    }
    prev = token;
  }
  if (balance !== 0) return { error: "Mismatched parentheses" };

  // Shunting‑yard algorithm to convert to Reverse Polish Notation (RPN)
  const outputQueue: Token[] = [];
  const operatorStack: Token[] = [];
  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
  const isLeftAssociative = (op: string) => true; // all left‑associative for our operators

  for (let idx = 0; idx < tokens.length; idx++) {
    const token = tokens[idx];
    if (token.type === "number") {
      outputQueue.push(token);
    } else if (token.type === "operator") {
      // Handle unary minus: if at start or after '(' or another operator, treat as part of number
      if (token.value === "-" && (idx === 0 || (tokens[idx - 1].type === "operator" && tokens[idx - 1].value !== ")") || tokens[idx - 1].type === "paren" && tokens[idx - 1].value === "(")) {
        // Unary minus: combine with next number token
        const next = tokens[idx + 1];
        if (next && next.type === "number") {
          // Negate the number and push as number
          outputQueue.push({ type: "number", value: -next.value });
          idx++; // skip next token
          continue;
        } else {
          return { error: "Invalid syntax" };
        }
      }
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1].type === "operator" &&
        ((precedence[operatorStack[operatorStack.length - 1].value] > precedence[token.value]) ||
          (precedence[operatorStack[operatorStack.length - 1].value] === precedence[token.value] && isLeftAssociative(token.value)))
      ) {
        outputQueue.push(operatorStack.pop() as Token);
      }
      operatorStack.push(token);
    } else if (token.type === "paren") {
      if (token.value === "(") {
        operatorStack.push(token);
      } else {
        // token.value === ")"
        while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type !== "paren") {
          outputQueue.push(operatorStack.pop() as Token);
        }
        if (operatorStack.length === 0) return { error: "Mismatched parentheses" };
        // Pop the '('
        operatorStack.pop();
      }
    }
  }
  while (operatorStack.length > 0) {
    const op = operatorStack.pop() as Token;
    if (op.type === "paren") return { error: "Mismatched parentheses" };
    outputQueue.push(op);
  }

  // Evaluate RPN
  const stack: number[] = [];
  for (const token of outputQueue) {
    if (token.type === "number") {
      stack.push(token.value);
    } else if (token.type === "operator") {
      if (stack.length < 2) return { error: "Invalid syntax" };
      const b = stack.pop() as number;
      const a = stack.pop() as number;
      let res: number;
      switch (token.value) {
        case "+":
          res = a + b;
          break;
        case "-":
          res = a - b;
          break;
        case "*":
          res = a * b;
          break;
        case "/":
          if (b === 0) return { error: "Division by zero" };
          res = a / b;
          break;
        default:
          return { error: "Invalid syntax" };
      }
      // Check overflow after each operation
      if (!Number.isFinite(res) || Math.abs(res) > Number.MAX_SAFE_INTEGER) {
        return { error: "Numeric overflow" };
      }
      // Round intermediate result to avoid floating‑point blow‑up
      const rounded = Math.round(res * 1e10) / 1e10;
      stack.push(rounded);
    }
  }
  if (stack.length !== 1) return { error: "Invalid syntax" };
  const finalResult = Math.round(stack[0] * 1e10) / 1e10;
  if (!Number.isFinite(finalResult) || Math.abs(finalResult) > Number.MAX_SAFE_INTEGER) {
    return { error: "Numeric overflow" };
  }
  return { result: finalResult };
}

