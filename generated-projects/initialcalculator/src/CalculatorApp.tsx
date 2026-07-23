import { useState, useCallback, useEffect, memo } from 'react';
import { evaluate, EvalResult } from './engine/evaluate';
import Input from './components/Input';
import ResultDisplay from './components/ResultDisplay';
import ErrorDisplay from './components/ErrorDisplay';

// Main CalculatorApp component
const CalculatorApp = memo(function CalculatorApp() {
  // State for the expression input
  const [expression, setExpression] = useState<string>('');

  // State for evaluation result or error
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);

  // Handle input changes
  const handleExpressionChange = useCallback((value: string) => {
    setExpression(value);
  }, []);

  // Evaluate expression on change
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
    <div style={{ maxWidth: '400px', margin: '2rem auto', padding: '1rem', border: '1px solid #ccc', borderRadius: '8px' }}>
      <h2>Calculator</h2>
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
});

export default CalculatorApp;
