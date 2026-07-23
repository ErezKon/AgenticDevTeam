import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

function Calculator() {
  const [width, setWidth] = React.useState(window.innerWidth);
  React.useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  const layout = width < 600 ? 'single-column' : 'grid';
  return (
    <div data-testid="keypad" className={layout}>
      {/* buttons omitted for brevity */}
    </div>
  );
}

describe('Calculator UI responsive layout', () => {
  test('renders single-column layout when width < 600px', () => {
    // Mock innerWidth
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 500 });
    window.dispatchEvent(new Event('resize'));
    render(<Calculator />);
    const keypad = screen.getByTestId('keypad');
    expect(keypad).toHaveClass('single-column');
  });

  test('renders grid layout when width >= 600px', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));
    render(<Calculator />);
    const keypad = screen.getByTestId('keypad');
    expect(keypad).toHaveClass('grid');
  });
});
