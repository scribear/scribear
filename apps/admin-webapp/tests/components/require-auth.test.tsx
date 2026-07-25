import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, vi } from 'vitest';

import { RequireAuth } from '#src/components/require-auth';
import type { AuthContextValue } from '#src/features/auth/auth-context';
import { useAuth } from '#src/features/auth/auth-context';

vi.mock('#src/features/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

function renderGuarded(authValue: Pick<AuthContextValue, 'status'>) {
  vi.mocked(useAuth).mockReturnValue(authValue as AuthContextValue);

  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/dashboard" element={<div>Protected content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', (it) => {
  it('redirects to /login when unauthenticated', () => {
    // Act
    renderGuarded({ status: 'anon' });

    // Assert
    expect(screen.getByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders the protected route when authenticated', () => {
    // Act
    renderGuarded({ status: 'authed' });

    // Assert
    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  it('shows a loading spinner while the session is still resolving', () => {
    // Act
    renderGuarded({ status: 'loading' });

    // Assert
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });
});
