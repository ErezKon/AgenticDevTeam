import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Calculator } from "../Calculator";

/**
 * Component tests for Calculator UI.
 *
 * Scenarios:
 * 1. Enter a valid arithmetic expression and submit – the correct result is displayed.
 * 2. Enter an expression that causes a division‑by‑zero error – the appropriate error message is shown.
 */

describe("Calculator component", () => {
  test("displays result after evaluating a valid expression", async () => {
    render(<Calculator />);

    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    const evaluateButton = screen.getByRole("button", { name: /evaluate/i });

    // Type a valid expression
    await userEvent.type(input, "2+3*4");
    // Click evaluate
    await userEvent.click(evaluateButton);

    // The result should be displayed
    const result = await screen.findByLabelText(/result display/i);
    expect(result).toHaveTextContent("Result: 14");
  });

  test("shows error message when evaluator returns division by zero error", async () => {
    render(<Calculator />);

    const input = screen.getByLabelText(/expression input/i) as HTMLInputElement;
    const evaluateButton = screen.getByRole("button", { name: /evaluate/i });

    // Type an expression that divides by zero
    await userEvent.type(input, "10/0");
    await userEvent.click(evaluateButton);

    // Expect the error alert to be shown with the correct message
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Cannot divide by zero");
  });
});
