import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Identity } from '../types/identity.js';

export interface SessionConfig {
  /** Whether the cookie carries the `Secure` attribute (false in dev/HTTP). */
  secure: boolean;
  /** Max gap between requests before the session is considered idle-expired. */
  idleTimeoutMs: number;
  /** Max total session lifetime regardless of activity. */
  absoluteTimeoutMs: number;
}

export interface SessionRecord {
  identity: Identity;
  /** CSRF token bound to this session (synchronizer-token pattern). */
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

export const SESSION_COOKIE_NAME = 'admin_session';
export const CSRF_COOKIE_NAME = 'admin_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Server-side session store. Sessions are revocable (delete removes them) and
 * carry idle + absolute lifetimes.
 *
 * NOTE: the store is in-memory, which is correct for a single BFF instance
 * (sessions reset on restart and are not shared across replicas). Scaling out
 * horizontally would require a shared backing store (Redis/Postgres); the
 * interface here is deliberately small so that swap is localized.
 */
export class SessionService {
  private _config: SessionConfig;
  private _sessions = new Map<string, SessionRecord>();

  constructor(sessionConfig: SessionConfig) {
    this._config = sessionConfig;
  }

  get config(): SessionConfig {
    return this._config;
  }

  /** Number of live sessions (used by tests/metrics). */
  get activeCount(): number {
    return this._sessions.size;
  }

  /** Issue a new session for an identity. Returns opaque ids for the cookies. */
  create(identity: Identity): { sessionId: string; csrfToken: string } {
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    this._sessions.set(sessionId, {
      identity,
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
    });
    return { sessionId, csrfToken };
  }

  /**
   * Look up and validate a session id. Enforces idle + absolute lifetimes and,
   * on success, slides the idle window forward. Expired/unknown ids return null
   * (expired records are deleted).
   */
  validate(sessionId: string | undefined): SessionRecord | null {
    if (!sessionId) return null;
    const record = this._sessions.get(sessionId);
    if (!record) return null;

    const now = Date.now();
    const absoluteExpired =
      now - record.createdAt > this._config.absoluteTimeoutMs;
    const idleExpired = now - record.lastSeenAt > this._config.idleTimeoutMs;
    if (absoluteExpired || idleExpired) {
      this._sessions.delete(sessionId);
      return null;
    }

    record.lastSeenAt = now;
    return record;
  }

  /** Constant-time comparison of a presented CSRF token to the session's. */
  verifyCsrf(
    record: SessionRecord,
    presentedToken: string | undefined,
  ): boolean {
    if (!presentedToken) return false;
    const expected = Buffer.from(record.csrfToken, 'utf8');
    const actual = Buffer.from(presentedToken, 'utf8');
    // Token length is fixed and non-secret, so an early length check is safe.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /** Revoke a session. */
  destroy(sessionId: string | undefined): void {
    if (sessionId) this._sessions.delete(sessionId);
  }
}
