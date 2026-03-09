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

  signSessionToken(payload: SessionTokenPayload): string {
    return jwt.sign(payload, this._secret);
  }
}
