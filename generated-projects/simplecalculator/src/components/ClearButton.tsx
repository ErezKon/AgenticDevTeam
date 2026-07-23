import React, { useEffect, useCallback } from 'react';

type ClearButtonProps = {
  /**
   * Callback to reset the calculator state.
   */
  onClear: () => void;
};

/**
 * ClearButton renders a button that clears the calculator when clicked.
 * It also registers a global Escape key listener to trigger the same action.
 */
export const ClearButton: React.FC<ClearButtonProps> = ({ onClear }) => {
  const handleClick = useCallback(() => {
    onClear();
  }, [onClear]);

  // Register Escape key listener on mount/unmount
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClear();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClear]);

  return (
    <button type="button" onClick={handleClick} aria-label="Clear calculator" data-testid="clear-button">
      Clear
    </button>
  );
};
