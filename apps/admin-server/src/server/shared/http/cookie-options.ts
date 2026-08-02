import type { CookieSerializeOptions } from '@fastify/cookie';

import { SESSION_COOKIE_NAME } from '../services/session.service.js';

/** Path the session cookie is scoped to (covers all /api/admin/v1 routes). */
export const SESSION_COOKIE_PATH = '/api/admin';

/**
 * Options for the admin session cookie: HttpOnly (JS cannot read it), Secure in
 * production, SameSite=Strict (blocks cross-site sends — first CSRF defense),
 * signed with `ADMIN_SESSION_SECRET`, and scoped to the admin API path.
 *
 * @param secure Whether to set the `Secure` attribute (false only in dev/HTTP).
 * @param absoluteTimeoutMs Cookie max-age, aligned to the absolute session lifetime.
 */
export function sessionCookieOptions(
  secure: boolean,
  absoluteTimeoutMs: number,
): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    signed: true,
    path: SESSION_COOKIE_PATH,
    maxAge: Math.floor(absoluteTimeoutMs / 1000),
  };
}

/** Options used when clearing the session cookie (must match path/attributes). */
export function clearSessionCookieOptions(
  secure: boolean,
): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: SESSION_COOKIE_PATH,
  };
}

/**
 * Name of the short-lived cookie that carries the PKCE code verifier and CSRF
 * state between /auth/sso/login and /auth/sso/callback. See
 * `2026-08-02-02-PLAN-AzureSso.md` §2.
 */
export const SSO_STATE_COOKIE_NAME = 'sso_state';

/** Path the SSO state cookie is scoped to (covers both SSO routes only). */
export const SSO_STATE_COOKIE_PATH = '/api/admin/v1/auth/sso';

/** TTL for the SSO state cookie — enough for the OIDC redirect dance. */
export const SSO_STATE_COOKIE_MAX_AGE_SEC = 300;

/**
 * Options for the SSO state cookie. `SameSite=Lax` (not `Strict`) is required:
 * the OIDC callback is a cross-site redirect from Azure, and `Strict` would
 * suppress the cookie on that redirect, breaking the flow. `Lax` sends
 * cookies on top-level GET navigations — exactly what the callback is — while
 * still providing CSRF protection for non-GET requests.
 */
export function ssoStateCookieOptions(secure: boolean): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    signed: true,
    path: SSO_STATE_COOKIE_PATH,
    maxAge: SSO_STATE_COOKIE_MAX_AGE_SEC,
  };
}

/** Options used when clearing the SSO state cookie (must match path/attributes). */
export function clearSsoStateCookieOptions(
  secure: boolean,
): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: SSO_STATE_COOKIE_PATH,
  };
}

export { SESSION_COOKIE_NAME };
