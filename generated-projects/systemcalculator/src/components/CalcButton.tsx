import React from 'react';

type CalcButtonProps = {
  /** Text shown on the button */
  label: string;
  /** Value passed to the click handler (usually same as label) */
  value: string;
  /** Click handler receiving the button's value */
  onClick: (value: string) => void;
};

/**
 * Reusable calculator button component.
 *
 * It renders a <button> element with a consistent style and forwards the
 * provided `value` to the `onClick` callback when the button is activated.
 */
const CalcButton: React.FC<CalcButtonProps> = ({ label, value, onClick }) => {
  const handleClick = () => {
    onClick(value);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="calc-button"
      aria-label={label}
    >
      {label}
    </button>
  );
};

export default CalcButton;
