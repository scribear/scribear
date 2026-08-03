import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, vi } from 'vitest';

import { ErrorState } from '#src/components/error-state';
import { ApiError } from '#src/lib/api-error';

import { renderWithProviders } from '../utils/render-with-providers';

describe('ErrorState', (it) => {
  it('renders the cause, the next action and the requestId', async () => {
    // Arrange & Act
    renderWithProviders(
      <ErrorState
        title="Could not load rooms."
        error={
          new ApiError(
            'INTERNAL_ERROR',
            'Server encountered an unexpected error.',
            500,
            '7b1f2c3d-0000-4000-8000-abcdefabcdef',
          )
        }
      />,
    );

    // Assert
    expect(screen.getByText('Could not load rooms.')).toBeInTheDocument();
    expect(
      screen.getByText('Server encountered an unexpected error.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/check the admin server logs/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('7b1f2c3d-0000-4000-8000-abcdefabcdef'),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Copy request ID' }),
    ).toBeInTheDocument();
  });

  it('omits the requestId block entirely when the request never reached a server', () => {
    // Arrange & Act - `admin-api.ts` mints NETWORK with no requestId; a
    // "Request ID: undefined" line would be worse than none.
    renderWithProviders(
      <ErrorState
        title="Could not load rooms."
        error={new ApiError('NETWORK', 'Could not reach the admin server.', 0)}
      />,
    );

    // Assert
    expect(screen.queryByText(/Request ID/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Copy request ID' }),
    ).not.toBeInTheDocument();
  });

  it('calls onRetry when the failure is one a retry could fix', async () => {
    // Arrange
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithProviders(
      <ErrorState
        title="Could not load rooms."
        error={new ApiError('UPSTREAM_UNREACHABLE', 'down', 503)}
        onRetry={onRetry}
      />,
    );

    // Act
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    // Assert
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides Retry when retrying cannot help, even if a handler was passed', () => {
    // Arrange & Act - offering "Retry" for a 403 is advice we know is wrong
    // (PLAN-VisibleErrors §1: never imply an action that cannot work).
    renderWithProviders(
      <ErrorState
        title="Could not load rooms."
        error={new ApiError('FORBIDDEN', 'You do not have permission.', 403)}
        onRetry={vi.fn()}
      />,
    );

    // Assert
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
  });

  it('announces itself as an alert and has no axe violations', async () => {
    // Arrange & Act - severity is `error` per §10.4, and MUI gives that an
    // icon plus role="alert", so colour is not the only signal (SC 1.4.1).
    const { container } = renderWithProviders(
      <ErrorState
        title="Could not load rooms."
        error={new ApiError('UPSTREAM_ERROR', 'boom', 502, 'req-1')}
        onRetry={vi.fn()}
      />,
    );

    // Assert - the scaffolding rules disabled here fire because this is a
    // bare component under test rather than the full app shell, same set the
    // devices-list a11y test disables.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    const results = await axe(container, {
      rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
        'html-has-lang': { enabled: false },
        'document-title': { enabled: false },
        bypass: { enabled: false },
      },
    });
    expect(results.violations).toHaveLength(0);
  });
});
