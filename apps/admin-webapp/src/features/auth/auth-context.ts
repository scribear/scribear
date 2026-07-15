import { createContext, use } from 'react';

import type { AuthConfig, Identity } from '#src/lib/admin-api';

export type AuthStatus = 'loading' | 'authed' | 'anon';

export interface AuthContextValue {
  status: AuthStatus;
  identity: Identity | null;
  /** Which providers the BFF has enabled (for the login page). */
  config: AuthConfig | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider.');
  return ctx;
}
