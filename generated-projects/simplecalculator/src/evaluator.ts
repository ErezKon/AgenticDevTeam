// Evaluator for arithmetic expression AST
// Supports +, -, *, /, unary +/-, decimal numbers, and negative numbers.
// Returns a numeric result or an error object for division by zero.

export type EvalError = {
  code: string;
  message: string;
};

export type NumberLiteral = {
  type: 'NumberLiteral';
  value: number;
};

export type BinaryExpression = {
  type: 'BinaryExpression';
  operator: '+' | '-' | '*' | '/';
  left: ASTNode;
  right: ASTNode;
};

export type UnaryExpression = {
  type: 'UnaryExpression';
  operator: '+' | '-';
  argument: ASTNode;
};

export type ASTNode = NumberLiteral | BinaryExpression | UnaryExpression;

/**
 * Recursively evaluates an AST representing an arithmetic expression.
 * @param node AST node to evaluate
 * @returns number result or EvalError for division by zero
 */
export function evaluate(node: ASTNode): number | EvalError {
  switch (node.type) {
    case 'NumberLiteral':
      return node.value;
    case 'UnaryExpression': {
      const val = evaluate(node.argument);
      if (isError(val)) return val;
      return node.operator === '-' ? -val : +val;
    }
    case 'BinaryExpression': {
      const left = evaluate(node.left);
      if (isError(left)) return left;
      const right = evaluate(node.right);
      if (isError(right)) return right;

      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          if (right === 0) {
            return { code: 'DIV_ZERO', message: 'Cannot divide by zero' };
          }
          return left / right;
      }
    }
  }
}

function isError(value: any): value is EvalError {
  return value && typeof value === 'object' && 'code' in value;
}
