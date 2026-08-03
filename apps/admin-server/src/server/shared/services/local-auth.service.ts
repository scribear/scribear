import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import type { Identity } from '../types/identity.js';
import { ROLE_READ_WRITE } from '../types/identity.js';

export interface LocalAuthConfig {
  /** Raw `ADMIN_LOCAL_CREDENTIALS` value: `"<username> <password>"`. */
  credentials: string;
}

/**
 * Local single-account auth provider. Reads one username+password from
 * `ADMIN_LOCAL_CREDENTIALS` (split on the FIRST space only, so the password may
 * contain spaces). Empty/unset/malformed => provider disabled.
 */
export class LocalAuthService {
  readonly id = 'local' as const;

  private _enabled: boolean;
  private _username: string;
  private _password: string;
  // Per-process random key: username/password are HMAC'd to a fixed 32-byte
  // digest before comparison, so `timingSafeEqual` never sees mismatched
  // lengths (which would throw and leak length) and the raw secret length is
  // not observable via timing.
  private _hmacKey: Buffer;

  constructor(
    logger: AppDependencies['logger'],
    localAuthConfig: AppDependencies['localAuthConfig'],
  ) {
    this._hmacKey = randomBytes(32);
    const raw = localAuthConfig.credentials;

    if (raw.trim() === '') {
      this._enabled = false;
      this._username = '';
      this._password = '';
      return;
    }

    const spaceIdx = raw.indexOf(' ');
    if (spaceIdx <= 0 || spaceIdx === raw.length - 1) {
      // No space, empty username, or empty password: malformed. Disable rather
      // than accept a half-configured credential.
      this._enabled = false;
      this._username = '';
      this._password = '';
      logger.warn(
        'ADMIN_LOCAL_CREDENTIALS is set but malformed (expected "<username> <password>"); local login is disabled.',
      );
      return;
    }

    this._username = raw.slice(0, spaceIdx);
    this._password = raw.slice(spaceIdx + 1);
    this._enabled = true;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  private _digest(value: string): Buffer {
    return createHmac('sha256', this._hmacKey).update(value, 'utf8').digest();
  }

  /**
   * Verify a username+password. Both fields are compared in constant time; the
   * function never short-circuits on a username mismatch. Returns the resolved
   * identity on success, or `null` on any mismatch (or when disabled).
   */
  verify(username: string, password: string): Identity | null {
    if (!this._enabled) return null;

    const userOk = timingSafeEqual(
      this._digest(username),
      this._digest(this._username),
    );
    const passOk = timingSafeEqual(
      this._digest(password),
      this._digest(this._password),
    );

    if (userOk && passOk) {
      return {
        subject: this._username,
        displayName: this._username,
        provider: 'local',
        roles: [ROLE_READ_WRITE],
      };
    }
    return null;
  }
}
