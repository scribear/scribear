import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';

import { AuthProvider } from '#src/features/auth/auth-provider';
import { LoginPage } from '#src/features/auth/login-page';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: {
      getAuthConfig: vi.fn(),
      me: vi.fn(),
      setOnUnauthorized: vi.fn(),
      setCsrfToken: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    },
  };
});

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function submitCredentials() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Username'), 'engrit');
  await user.type(screen.getByLabelText('Password'), 'hunter2');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage sign-in failures', () => {
  beforeEach(() => {
    vi.mocked(adminApi.getAuthConfig).mockResolvedValue({
      local: true,
      sso: false,
      grafana: false,
    });
    vi.mocked(adminApi.me).mockRejectedValue(
      new ApiError('UNAUTHORIZED', 'no session', 401),
    );
  });

  describe('when the login route rate limits the operator', (it) => {
    it('says the password was not rejected, and says it as a warning', async () => {
      // Arrange - admin-server limits POST /auth/login to 5 attempts a minute,
      // so an operator who mistyped a few times gets this, not a 401. Before
      // this fix the server's terse "Too many requests." landed in the same red
      // alert as "Invalid credentials.", so the operator kept guessing.
      vi.mocked(adminApi.login).mockRejectedValue(
        new ApiError(
          'RATE_LIMITED',
          'Too many requests. Please retry after 1 minute.',
          429,
          'req-1',
          { retryAfter: '1 minute' },
        ),
      );

      // Act
      renderLoginPage();
      await submitCredentials();

      // Assert
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'Too many sign-in attempts. This is a rate limit, not a rejected password — wait 1 minute, then sign in again.',
      );
      // MUI renders the severity as a class; `warning` not `error`, because a
      // rate limit clears on its own and needs no action but waiting.
      expect(alert.className).toContain('MuiAlert-colorWarning');
      expect(alert.className).not.toContain('MuiAlert-colorError');
    });
  });

  describe('when the password really is wrong', (it) => {
    it('keeps the credential message at error severity', async () => {
      // Arrange
      vi.mocked(adminApi.login).mockRejectedValue(
        new ApiError('INVALID_CREDENTIALS', 'Invalid credentials.', 401),
      );

      // Act
      renderLoginPage();
      await submitCredentials();

      // Assert - the 429 handling must not soften a genuine rejection.
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Invalid credentials.');
      expect(alert.className).toContain('MuiAlert-colorError');
    });
  });

  describe('when the request never reached the server', (it) => {
    it('falls back to the generic sign-in message at error severity', async () => {
      // Arrange
      vi.mocked(adminApi.login).mockRejectedValue(new TypeError('boom'));

      // Act
      renderLoginPage();
      await submitCredentials();

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Sign in failed. Please try again.',
        );
      });
      expect(screen.getByRole('alert').className).toContain(
        'MuiAlert-colorError',
      );
    });
  });
});
