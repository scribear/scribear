import jwt from 'jsonwebtoken';

import type { SessionTokenPayload } from '@scribear/session-manager-schema';

export interface JwtServiceConfig {
  jwtSecret: string;
}

export class JwtService {
  private _secret: string;

  constructor(jwtServiceConfig: JwtServiceConfig) {
    this._secret = jwtServiceConfig.jwtSecret;
  }

  /**
   * Signs a session JWT with the given payload. The payload must include `exp`
   * as a Unix timestamp (seconds) representing the session end time.
   *
   * @param payload - The session token payload to sign, including expiry.
   * @returns A signed JWT string.
   */
  signSessionToken(payload: SessionTokenPayload): string {
    return jwt.sign(payload, this._secret);
  }
}
