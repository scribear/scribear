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

export { SESSION_COOKIE_NAME };
