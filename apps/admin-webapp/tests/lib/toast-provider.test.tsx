import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect } from 'vitest';

import { ApiError } from '#src/lib/api-error';
import { useToast } from '#src/lib/toast-context';
import { ToastProvider } from '#src/lib/toast-provider';

/** Stands in for the ~40 admin call sites that report a failed API call. */
const Thrower = ({ err }: { err: unknown }) => {
  const { showApiError } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        showApiError(err, 'Failed to load rooms.');
      }}
    >
      go
    </button>
  );
};

async function fire(err: unknown) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <Thrower err={err} />
    </ToastProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'go' }));
  return screen.findByRole('alert');
}

describe('ToastProvider.showApiError', () => {
  describe('a rate-limited request', (it) => {
    it('is a warning toast explaining the limit, not a red failure', async () => {
      // Arrange - admin-server registers the limiter with `global: true`, so
      // every one of these call sites can receive a 429.
      // Act
      const alert = await fire(
        new ApiError(
          'RATE_LIMITED',
          'Too many requests. Please retry after 1 minute.',
          429,
          'req-1',
          { retryAfter: '1 minute' },
        ),
      );

      // Assert
      expect(alert).toHaveTextContent(
        'Too many requests — the admin server is rate limiting this browser. Nothing was changed; wait 1 minute, then try again.',
      );
      expect(alert.className).toContain('MuiAlert-colorWarning');
    });
  });

  describe('any other API failure', (it) => {
    it('keeps the server message at error severity', async () => {
      // Act
      const alert = await fire(
        new ApiError('CONFLICT', 'Room name already in use.', 409),
      );

      // Assert
      expect(alert).toHaveTextContent('Room name already in use.');
      expect(alert.className).toContain('MuiAlert-colorError');
    });
  });

  describe('a non-API failure', (it) => {
    it('falls back to the caller-supplied message at error severity', async () => {
      // Act
      const alert = await fire(new TypeError('Failed to fetch'));

      // Assert
      expect(alert).toHaveTextContent('Failed to load rooms.');
      expect(alert.className).toContain('MuiAlert-colorError');
    });
  });
});
