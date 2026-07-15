/**
 * Authorization roles. `read-write` grants mutations; `read-only` grants reads
 * only. The local account maps to `read-write`; the `read-only` seam exists so
 * an SSO group can be mapped to reduced privileges later without touching route
 * wiring.
 */
export type Role = 'read-only' | 'read-write';

export const ROLE_READ_ONLY: Role = 'read-only';
export const ROLE_READ_WRITE: Role = 'read-write';

export type AuthProviderId = 'local' | 'sso';

/**
 * A resolved staff identity. Everything downstream of authentication (session,
 * CSRF, authorization, audit) sees only an `Identity` — never a provider
 * credential.
 */
export interface Identity {
  /** Stable unique identifier for the actor within its provider. */
  subject: string;
  /** Human-readable name for display/audit. */
  displayName: string;
  /** Which provider authenticated this identity. */
  provider: AuthProviderId;
  /** Granted authorization roles. */
  roles: Role[];
}

/** True if the identity holds the given role. */
export function identityHasRole(identity: Identity, role: Role): boolean {
  return identity.roles.includes(role);
}
