import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AuthConfig, Identity } from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';

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
      const cfg = await adminApi.getAuthConfig().catch(() => null);
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
    () => ({ status, identity, config, login, logout }),
    [status, identity, config, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
};
