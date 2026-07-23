import { render, screen } from '@testing-library/react';
import ErrorDisplay from './ErrorDisplay';

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
    // No element with role alert should be present
    const alerts = screen.queryByRole('alert');
    expect(alerts).toBeNull();
    // Container should be empty (null render)
    expect(container.firstChild).toBeNull();
  });
});
