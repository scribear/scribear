import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AuthConfig, Identity } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

import { AuthContext, type AuthStatus } from './auth-context';

/**
 * Owns the admin session state. On mount it loads which providers are enabled
 * and probes `/auth/me`; a 401 anywhere (session expiry) flips the app to
 * anonymous so `RequireAuth` routes to /login. The CSRF token is handed to the
 * API client so mutations carry it.
 */
export const AuthProvider = ({ children }: React.PropsWithChildren) => {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    // Object flag (not a plain boolean) so its mutation in the cleanup closure
    // is visible to flow analysis.
    const alive = { current: true };

    adminApi.setOnUnauthorized(() => {
      adminApi.setCsrfToken('');
      setIdentity(null);
      setStatus('anon');
    });

    void (async () => {
      const cfg = await adminApi.getAuthConfig().catch((err: unknown) => {
        // Logged, not swallowed: a failure here used to leave the login page
        // rendering its title and nothing else - no form, no warning, no
        // error - with no signal anywhere that it was a fetch failure rather
        // than "nothing configured". console.error at minimum makes it show
        // up in exactly the browser console an operator already has open.
        console.error('Failed to load /auth/config', err);
        if (alive.current) {
          setConfigError(
            err instanceof ApiError
              ? err.message
              : 'Could not reach the admin server.',
          );
        }
        return null;
      });
      if (alive.current && cfg) setConfig(cfg);

      try {
        const info = await adminApi.me();
        if (!alive.current) return;
        adminApi.setCsrfToken(info.csrfToken);
        setIdentity(info.identity);
        setStatus('authed');
      } catch {
        if (alive.current) setStatus('anon');
      }
    })();

    return () => {
      alive.current = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const info = await adminApi.login(username, password);
    adminApi.setCsrfToken(info.csrfToken);
    setIdentity(info.identity);
    setStatus('authed');
  }, []);

  const logout = useCallback(async () => {
    try {
      await adminApi.logout();
    } finally {
      adminApi.setCsrfToken('');
      setIdentity(null);
      setStatus('anon');
    }
  }, []);

  const value = useMemo(
    () => ({ status, identity, config, configError, login, logout }),
    [status, identity, config, configError, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
};
