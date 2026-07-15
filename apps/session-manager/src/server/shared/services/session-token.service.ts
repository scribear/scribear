import crypto from 'node:crypto';
import { Value } from 'typebox/value';

import {
  SESSION_TOKEN_PAYLOAD_SCHEMA,
  type SessionTokenPayload,
} from '@scribear/session-manager-schema';

export interface SessionTokenConfig {
  signingKey: string;
}

export type { SessionTokenPayload };

const TOKEN_SEPARATOR = '.';

/**
 * Encodes JSON as URL-safe base64 without padding. The fastify-cookie code path
 * passes session tokens through HTTP headers / query strings, so the wire form
 * must be safe to drop in either context unmodified.
 */
function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * HMAC-signed session token service. Tokens are compact strings of the form
 * `{base64url(payload-json)}.{base64url(hmac-sha256)}`. Verification is
 * stateless so any service holding the same signing key can validate a
 * presented token without a round-trip to the session manager.
 */
export class SessionTokenService {
  private _signingKey: string;

  constructor(sessionTokenConfig: SessionTokenConfig) {
    this._signingKey = sessionTokenConfig.signingKey;
  }

  /**
   * Signs a token carrying the given session/client/scopes/expiry payload.
   * @param payload Claims to embed in the token.
   * @returns The signed token string.
   */
  sign(payload: SessionTokenPayload): string {
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = this._computeSignature(encodedPayload);
    return `${encodedPayload}${TOKEN_SEPARATOR}${signature}`;
  }

  /**
   * Verifies a token's signature and decodes its payload. Does NOT check
   * `exp`; callers that need expiry enforcement should compare `payload.exp`
   * against `Date.now()` themselves.
   * @param token A token produced by {@link sign}.
   * @returns The decoded payload, or `null` if the token is malformed or has an invalid signature.
   */
  verify(token: string): SessionTokenPayload | null {
    const sep = token.indexOf(TOKEN_SEPARATOR);
    if (sep === -1) return null;

    const encodedPayload = token.slice(0, sep);
    const presentedSignature = token.slice(sep + 1);

    const expectedSignature = this._computeSignature(encodedPayload);
    const presentedBuf = Buffer.from(presentedSignature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    if (presentedBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(presentedBuf, expectedBuf)) return null;

    const json = base64UrlDecode(encodedPayload);
    if (json === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }

    if (!Value.Check(SESSION_TOKEN_PAYLOAD_SCHEMA, parsed)) return null;
    return parsed;
  }

  private _computeSignature(encodedPayload: string): string {
    return crypto
      .createHmac('sha256', this._signingKey)
      .update(encodedPayload)
      .digest('base64url');
  }
}
