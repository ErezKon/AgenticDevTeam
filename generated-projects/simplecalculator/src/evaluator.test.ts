// Unit tests for the arithmetic AST evaluator
import { evaluate, ASTNode, EvalError } from './evaluator';

describe('AST Evaluator', () => {
  test('evaluates simple addition', () => {
    const ast: ASTNode = {
      type: 'BinaryExpression',
      operator: '+',
      left: { type: 'NumberLiteral', value: 2 },
      right: { type: 'NumberLiteral', value: 3 },
    };
    expect(evaluate(ast)).toBe(5);
  });

  test('evaluates expression with precedence (1+2)*3', () => {
    const ast: ASTNode = {
      type: 'BinaryExpression',
      operator: '*',
      left: {
        type: 'BinaryExpression',
        operator: '+',
        left: { type: 'NumberLiteral', value: 1 },
        right: { type: 'NumberLiteral', value: 2 },
      },
      right: { type: 'NumberLiteral', value: 3 },
    };
    expect(evaluate(ast)).toBe(9);
  });

  test('handles decimal numbers correctly', () => {
    const ast: ASTNode = {
      type: 'BinaryExpression',
      operator: '*',
      left: { type: 'NumberLiteral', value: 1.5 },
      right: { type: 'NumberLiteral', value: 2 },
    };
    expect(evaluate(ast)).toBeCloseTo(3);
  });

  test('handles unary minus (negative numbers)', () => {
    const ast: ASTNode = {
      type: 'BinaryExpression',
      operator: '+',
      left: {
        type: 'UnaryExpression',
        operator: '-',
        argument: { type: 'NumberLiteral', value: 5 },
      },
      right: { type: 'NumberLiteral', value: 3 },
    };
    expect(evaluate(ast)).toBe(-2);
  });

  test('handles unary plus (no effect)', () => {
    const ast: ASTNode = {
      type: 'UnaryExpression',
      operator: '+',
      argument: { type: 'NumberLiteral', value: 7 },
    };
    expect(evaluate(ast)).toBe(7);
  });

  test('returns DIV_ZERO error on division by zero', () => {
    const ast: ASTNode = {
      type: 'BinaryExpression',
      operator: '/',
      left: { type: 'NumberLiteral', value: 5 },
      right: { type: 'NumberLiteral', value: 0 },
    };
    const result = evaluate(ast) as EvalError;
    expect(result).toMatchObject({ code: 'DIV_ZERO', message: 'Cannot divide by zero' });
  });
});
