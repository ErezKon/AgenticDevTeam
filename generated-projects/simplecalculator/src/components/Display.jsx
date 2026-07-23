import React from 'react';
import PropTypes from 'prop-types';
import './Display.css';

/**
 * Display component for the calculator.
 * Shows the current expression and result, or an error message.
 */
const Display = ({ expression, result, error }) => {
  return (
    <div className="display" role="status" aria-live="polite">
      {error ? (
        <span className="error" data-testid="display-error">
          {error}
        </span>
      ) : (
        <>
          <span className="expression" data-testid="display-expression">
            {expression}
          </span>
          <span className="result" data-testid="display-result">
            {result}
          </span>
        </>
      )}
    </div>
  );
};

Display.propTypes = {
  expression: PropTypes.string.isRequired,
  result: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  error: PropTypes.string,
};

Display.defaultProps = {
  result: '',
  error: null,
};

export default Display;
