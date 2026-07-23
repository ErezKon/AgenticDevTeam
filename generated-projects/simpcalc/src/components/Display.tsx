import React from 'react';

type Props = {
  value: string;
};

export const DisplayComponent: React.FC<Props> = ({ value }) => {
  return <div data-testid="display">{value}</div>;
};
