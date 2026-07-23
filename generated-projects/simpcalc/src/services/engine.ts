export class ExpressionEngine {
  // Evaluate expression after validation. Uses shunting-yard algorithm.
  static evaluateExpression(expr: string): number {
    const rpn = this.shuntingYardParser(expr);
    const stack: number[] = [];
    for (const token of rpn) {
      if (typeof token === 'number') {
        stack.push(token);
      } else {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) throw new Error('Invalid expression');
        let res: number;
        switch (token) {
          case '+':
            res = a + b; break;
          case '-':
            res = a - b; break;
          case '*':
            res = a * b; break;
          case '/':
            if (b === 0) throw new Error('Division by zero is not allowed');
            res = a / b; break;
          default:
            throw new Error('Unknown operator');
        }
        stack.push(res);
      }
    }
    if (stack.length !== 1) throw new Error('Invalid expression');
    return stack[0];
  }

  // Convert infix expression string to RPN array (numbers and operator strings)
  static shuntingYardParser(expr: string): (number | string)[] {
    const output: (number | string)[] = [];
    const operators: string[] = [];
    const precedence: {[key:string]: number} = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const associativity: {[key:string]: 'L'|'R'} = { '+': 'L', '-': 'L', '*': 'L', '/': 'L' };
    // Tokenize (support negative numbers and decimals)
    const tokens = expr.match(/\d*\.?\d+|[+\-*/()]/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (/\d/.test(token)) {
        output.push(parseFloat(token));
      } else if (token === '(') {
        operators.push(token);
      } else if (token === ')') {
        while (operators.length && operators[operators.length-1] !== '(') {
          output.push(operators.pop() as string);
        }
        operators.pop(); // remove '('
      } else if (['+','-','*','/'].includes(token)) {
        // handle unary minus for negative numbers
        if (token === '-' && (i===0 || tokens[i-1] === '(' || ['+','-','*','/'].includes(tokens[i-1]))) {
          // unary minus, combine with next number
          const next = tokens[i+1];
          if (next && /\d/.test(next)) {
            output.push(-parseFloat(next));
            i++; // skip next token
            continue;
          }
        }
        while (operators.length) {
          const o2 = operators[operators.length-1];
          if (o2 === '(') break;
          if ((associativity[token] === 'L' && precedence[token] <= precedence[o2]) ||
              (associativity[token] === 'R' && precedence[token] < precedence[o2])) {
            output.push(operators.pop() as string);
          } else {
            break;
          }
        }
        operators.push(token);
      }
    }
    while (operators.length) {
      const op = operators.pop() as string;
      if (op === '(' || op === ')') throw new Error('Mismatched parentheses');
      output.push(op);
    }
    return output;
  }
}
