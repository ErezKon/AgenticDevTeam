import { render, screen } from '@testing-library/react';
import ErrorDisplay, { ErrorDisplayProps } from './ErrorDisplay';

describe('ErrorDisplay component', () => {
  test('renders error message with role alert when error is provided', () => {
    const errorMessage = 'Division by zero';
    render(<ErrorDisplay error={errorMessage} />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(errorMessage);
  });

  test('does not render anything when error is empty string', () => {
    const { container } = render(<ErrorDisplay error={''} />);
    const alerts = screen.queryByRole('alert');
    expect(alerts).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test('does not render and does not crash for non-string falsy values', () => {
    const falsyValues: any[] = [null, undefined, 0, false, {}];
    falsyValues.forEach((val) => {
      const { container } = render(<ErrorDisplay error={val} />);
      const alerts = screen.queryByRole('alert');
      expect(alerts).toBeNull();
      expect(container.firstChild).toBeNull();
    });
  });

  test('alert element includes aria-live attribute', () => {
    const errorMessage = 'Division by zero';
    render(<ErrorDisplay error={errorMessage} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });
});
