import jwt from 'jsonwebtoken';
import { Value } from 'typebox/value';

import {
  SESSION_TOKEN_PAYLOAD_SCHEMA,
  type SessionTokenPayload,
} from '@scribear/node-server-schema';

export interface JwtServiceConfig {
  jwtSecret: string;
}

export class JwtService {
  private _jwtServiceConfig: JwtServiceConfig;

  constructor(jwtServiceConfig: JwtServiceConfig) {
    this._jwtServiceConfig = jwtServiceConfig;
  }

  /**
   * Verifies a session JWT and returns the decoded payload, or null if invalid.
   *
   * @param token - The JWT string to verify.
   * @returns The decoded payload if valid, or null if the token is invalid or expired.
   */
  verifySessionToken(token: string): SessionTokenPayload | null {
    try {
      const decoded = jwt.verify(token, this._jwtServiceConfig.jwtSecret);
      if (!Value.Check(SESSION_TOKEN_PAYLOAD_SCHEMA, decoded)) return null;
      return decoded;
    } catch {
      return null;
    }
  }
}
