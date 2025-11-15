import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { StringValue } from 'ms';

import type { BaseLogger } from '@scribear/base-fastify-server';

export type SessionScope = 'source' | 'sink' | 'both';

export interface JwtPayload {
  sessionId: string;
  scope: SessionScope;
  /**
   * Optional audio source identifier for source connections
   */
  sourceId?: string | undefined;
}

export interface JwtVerificationResult {
  valid: boolean;
  payload?: JwtPayload;
  error?: string;
}

export interface JwtConfig {
  jwtSecret: string;
  jwtIssuer?: string;
  jwtExpiresIn?: string;
}

export class JwtService {
  private _log: BaseLogger;
  private _secret: string;
  private _issuer: string;
  private _jwtExpiresIn: string;

  constructor(logger: BaseLogger, config: JwtConfig) {
    this._log = logger;
    this._secret = config.jwtSecret;
    this._issuer = config.jwtIssuer ?? 'scribear-session-manager';
    this._jwtExpiresIn = config.jwtExpiresIn ?? '24h';

    if (!this._secret || this._secret.length < 32) {
      throw new Error('JWT secret must be at least 32 characters long');
    }
  }

  /**
   * Issue a new JWT token for a session
   * @param sessionId - The session identifier
   * @param scope - The access scope (source, sink, or both)
   * @param sourceId - Optional audio source identifier
   * @param expiresIn - Token expiration time (default: 24h)
   * @returns Signed JWT token string
   */
  issueToken(
    sessionId: string,
    scope: SessionScope,
    sourceId?: string,
    expiresIn?: string,
  ): string {
    const payload: JwtPayload = {
      sessionId,
      scope,
      sourceId
    };

    this._log.info(
      { sessionId, scope, sourceId },
      'Issuing JWT token for session',
    );

    const options: SignOptions = {
      issuer: this._issuer,
      algorithm: 'HS256',
    };

    // Only set expiresIn if we have a value
    const expiresInValue = expiresIn ?? this._jwtExpiresIn;
    if (expiresInValue) {
      options.expiresIn = expiresInValue as StringValue;
    }

    return jwt.sign(payload, this._secret, options);
  }

  /**
   * Verify and decode a JWT token
   * @param token - The JWT token string to verify
   * @returns Verification result with payload or error
   */
  verifyToken(token: string): JwtVerificationResult {
    try {
      const decoded = jwt.verify(token, this._secret, {
        issuer: this._issuer,
        algorithms: ['HS256'],
      }) as JwtPayload;

      this._log.debug(
        { sessionId: decoded.sessionId, scope: decoded.scope },
        'JWT token verified successfully',
      );

      return {
        valid: true,
        payload: decoded,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      this._log.warn({ error: errorMessage }, 'JWT verification failed');

      return {
        valid: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Decode a JWT token without verification (useful for debugging)
   * WARNING: Do not use for authentication! Always use verifyToken() for security.
   * @param token - The JWT token string to decode
   * @returns Decoded payload or null
   */
  decodeToken(token: string): JwtPayload | null {
    try {
      const decoded = jwt.decode(token) as JwtPayload;
      return decoded;
    } catch (error) {
      this._log.warn({ error }, 'Failed to decode JWT token');
      return null;
    }
  }

  /**
   * Check if a token has expired without verifying signature
   * @param token - The JWT token string
   * @returns true if expired, false otherwise
   */
  isTokenExpired(token: string): boolean {
    try {
      const decoded = jwt.decode(token) as jwt.JwtPayload | null;
      if (!decoded?.exp) {
        return true;
      }
      return Date.now() >= decoded.exp * 1000;
    } catch {
      return true;
    }
  }
}
