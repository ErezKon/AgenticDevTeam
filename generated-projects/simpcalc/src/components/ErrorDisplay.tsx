import React from 'react';

type Props = {
  message: string;
};

export const ErrorDisplayComponent: React.FC<Props> = ({ message }) => {
  return (
    <div role="alert" aria-live="assertive" data-testid="error">
      {message}
    </div>
  );
};
