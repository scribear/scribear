import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, vi } from 'vitest';

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

describe('LoginPage auth/config failure handling', (it) => {
  it('shows a distinct error alert when the initial auth/config fetch fails, instead of rendering nothing', async () => {
    // Arrange - a fetch failure used to be swallowed to null, indistinguishable
    // from "loaded, nothing configured", and the page rendered its title with
    // no form, no warning, and no error at all.
    vi.mocked(adminApi.getAuthConfig).mockRejectedValue(
      new ApiError(
        'ROUTE_NOT_FOUND',
        'Route GET: /api/admin/v1/auth/config not found.',
        404,
      ),
    );
    vi.mocked(adminApi.me).mockRejectedValue(
      new ApiError('UNAUTHORIZED', 'no session', 401),
    );

    // Act
    renderLoginPage();

    // Assert
    await waitFor(() => {
      expect(
        screen.getByText(
          /Couldn't reach the admin server \(Route GET: \/api\/admin\/v1\/auth\/config not found\.\)/,
        ),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'No sign-in methods are configured. Contact an operator.',
      ),
    ).not.toBeInTheDocument();
  });

  it('falls back to a generic message for a non-API error (e.g. network failure)', async () => {
    // Arrange
    vi.mocked(adminApi.getAuthConfig).mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    vi.mocked(adminApi.me).mockRejectedValue(
      new ApiError('UNAUTHORIZED', 'no session', 401),
    );

    // Act
    renderLoginPage();

    // Assert
    await waitFor(() => {
      expect(
        screen.getByText(
          /Couldn't reach the admin server \(Could not reach the admin server\.\)/,
        ),
      ).toBeInTheDocument();
    });
  });

  it('renders the sign-in form normally when auth/config succeeds (no regression)', async () => {
    // Arrange
    vi.mocked(adminApi.getAuthConfig).mockResolvedValue({
      local: true,
      sso: false,
      grafana: false,
    });
    vi.mocked(adminApi.me).mockRejectedValue(
      new ApiError('UNAUTHORIZED', 'no session', 401),
    );

    // Act
    renderLoginPage();

    // Assert
    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Couldn't reach the admin server/),
    ).not.toBeInTheDocument();
  });
});
