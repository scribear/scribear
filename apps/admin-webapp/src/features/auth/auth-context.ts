import { createContext, use } from 'react';

import type { AuthConfig, Identity } from '#src/lib/admin-api';

export type AuthStatus = 'loading' | 'authed' | 'anon';

export interface AuthContextValue {
  status: AuthStatus;
  identity: Identity | null;
  /** Which providers the BFF has enabled (for the login page). */
  config: AuthConfig | null;
  /**
   * Set when the initial `/auth/config` fetch itself failed - a proxy
   * misroute, admin-server unreachable, whatever - as opposed to succeeding
   * with no providers enabled. `config` stays null in both cases, so the
   * login page needs this to tell "still loading" and "nothing configured"
   * apart from "the server didn't answer".
   */
  configError: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider.');
  return ctx;
}
