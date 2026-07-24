import React, { ChangeEvent } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
};

export const InputField: React.FC<Props> = ({ value, onChange }) => {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };
  return (
    <input
      type="text"
      aria-label="Calculator input"
      value={value}
      onChange={handleChange}
    />
  );
};
