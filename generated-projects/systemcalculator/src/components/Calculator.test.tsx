import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import Calculator from './Calculator';
import * as fs from 'fs';
import * as path from 'path';

describe('Calculator component', () => {
  test('renders display and keypad', () => {
    render(<Calculator />);
    const display = screen.getByTestId('display');
    const keypad = screen.getByTestId('keypad');
    expect(display).toBeInTheDocument();
    expect(keypad).toBeInTheDocument();
    // ensure buttons rendered
    const button = screen.getByRole('button', { name: '7' });
    expect(button).toBeInTheDocument();
  });

  test('includes responsive media query for keypad layout', () => {
    const cssPath = path.resolve(__dirname, 'Calculator.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    expect(cssContent).toMatch(/@media\s*\(max-width:\s*600px\)/);
    // ensure grid-template-columns set to 1fr inside media query
    expect(cssContent).toMatch(/\.keypad\s*{[^}]*grid-template-columns:\s*1fr;/s);
  });
});
