// Error codes enumeration for the expression evaluator
export enum ErrorCode {
  SYNTAX_ERROR = "SYNTAX_ERROR",
  DIV_ZERO = "DIV_ZERO",
  RUNTIME_ERROR = "RUNTIME_ERROR",
}

/**
 * Interface representing a syntax error detected during parsing.
 * Includes an optional position indicating where the error occurred.
 */
export interface SyntaxError {
  /**
   * Discriminator for the type of error.
   */

  code: ErrorCode.SYNTAX_ERROR;
  message: string;
  /**
   * Zero‑based index in the original expression string where the error was detected.
   */
  position?: number;
}

/**
 * Interface representing a runtime error that occurs during evaluation (e.g., division by zero).
 */
export interface RuntimeError {
  /**
   * Specific runtime error code. Currently, DIV_ZERO is defined; other runtime errors can use RUNTIME_ERROR.
   */
  code: ErrorCode.DIV_ZERO | ErrorCode.RUNTIME_ERROR;
  message: string;
}

/** Factory function to create a SyntaxError object. */
export function createSyntaxError(message: string, position?: number): SyntaxError {
  return {
    code: ErrorCode.SYNTAX_ERROR,
    message,
    ...(position !== undefined ? { position } : {}),
  };
}

/** Factory function to create a RuntimeError object. */
export function createRuntimeError(code: ErrorCode.DIV_ZERO | ErrorCode.RUNTIME_ERROR, message: string): RuntimeError {
  return {
    code,
    message,
  };
}
