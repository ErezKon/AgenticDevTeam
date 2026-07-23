import { useState, useCallback, useEffect } from 'react';
import { evaluate, EvalResult } from './engine/evaluate';
import Input from './components/Input';
import ResultDisplay from './components/ResultDisplay';
import ErrorDisplay from './components/ErrorDisplay';

// Main CalculatorApp component
import styles from './CalculatorApp.module.css';

export default function CalculatorApp() {
  // Strongly typed state for the expression string
  const [expression, setExpression] = useState<string>('');

  // State to hold the evaluation result or error
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);

  const handleExpressionChange = useCallback((value: string) => {
    setExpression(value);
  }, []);

  // Evaluate the expression whenever it changes (excluding empty input)
  useEffect(() => {
    const trimmed = expression.trim();
    if (trimmed === '') {
      setEvalResult(null);
    } else {
      setEvalResult(evaluate(trimmed));
    }
  }, [expression]);

  const hasError = evalResult && 'error' in evalResult;

  const getUserFriendlyError = (error: string): string => {
    switch (error) {
      case 'Division by zero':
        return 'Division by zero';
      case 'Mismatched parentheses':
        return 'Mismatched parentheses';
      case 'Invalid syntax':
        return 'Invalid syntax';
      case 'Expression too long':
        return 'Expression too long';
      case 'Numeric overflow':
        return 'Numeric overflow';
      default:
        return 'Error evaluating expression';
    }
  };

  return (
    <div className={`container ${styles.container || ''}`} data-testid="calculator-container">
      <h2 className={styles.title}>Calculator</h2>
      <Input value={expression} onChange={handleExpressionChange} />
      {hasError ? (
        <ErrorDisplay error={getUserFriendlyError((evalResult as { error: string }).error)} />
      ) : (
        expression.trim() !== '' && evalResult && (
          <ResultDisplay result={(evalResult as { result: number }).result} />
        )
      )}
    </div>
  );
}
