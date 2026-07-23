import React, { useState } from "react";
import { evaluateExpression, EvalResult } from "../evaluator";

export const Calculator: React.FC = () => {
  const [input, setInput] = useState("");
  const [display, setDisplay] = useState("");
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow only digits, operators, parentheses, decimal point, and minus sign
    if (/^[0-9+\-*/().\s]*$/.test(value)) {
      setInput(value);
      setDisplay(value);
      setError("");
    } else {
      setError("Invalid characters entered");
    }
  };

  const evaluate = () => {
    const evalResult: EvalResult = evaluateExpression(input);
    if (evalResult.error) {
      setError(evalResult.error.message);
      setResult("");
    } else if (evalResult.result !== undefined) {
      setResult(evalResult.result.toString());
      setError("");
    }
  };

  const clear = () => {
    setInput("");
    setDisplay("");
    setResult("");
    setError("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      evaluate();
    } else if (e.key === "Escape") {
      clear();
    }
  };

  return (
    <div>
      <label htmlFor="calc-input">Expression:</label>
      <input
        id="calc-input"
        aria-label="Expression input"
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      <button onClick={evaluate} aria-label="Evaluate button">
        Evaluate
      </button>
      <button onClick={clear} aria-label="Clear button">
        Clear
      </button>
      <div aria-label="Expression display">{display}</div>
      {result && <div aria-label="Result display">Result: {result}</div>}
      {error && <div role="alert">{error}</div>}
    </div>
  );
};
