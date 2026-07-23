import React from 'react';

type ButtonProps = {
  /**
   * The display label/value of the button.
   */
  label: string;
  /**
   * Value emitted when the button is activated. Usually same as label but can differ.
   */
  value?: string;
  /**
   * Callback invoked when the button is clicked or activated via keyboard.
   */
  onPress: (value: string) => void;
  /**
   * Optional className for styling.
   */
  className?: string;
};

/**
 * Reusable calculator button component.
 * Emits its `value` (or `label` if value omitted) via `onPress` when clicked.
 */
export const Button: React.FC<ButtonProps> = ({ label, value, onPress, className }) => {
  const emitValue = () => {
    onPress(value ?? label);
  };

  return (
    <button
      type="button"
      className={className}
      onClick={emitValue}
      // Accessibility: expose the label as aria-label for screen readers.
      aria-label={label}
    >
      {label}
    </button>
  );
};
