import crypto from 'node:crypto';
import { Value } from 'typebox/value';

import {
  SESSION_TOKEN_PAYLOAD_SCHEMA,
  type SessionTokenPayload,
} from '@scribear/session-manager-schema';

export interface SessionTokenConfig {
  signingKey: string;
}

const TOKEN_SEPARATOR = '.';

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
 * stateless so the Node Server can validate a presented token without a
 * round-trip to Session Manager - both services share the same signing key
 * via `SESSION_TOKEN_SIGNING_KEY`.
 *
 * Tokens decoded here are also schema-checked against
 * {@link SESSION_TOKEN_PAYLOAD_SCHEMA} because the Node Server only consumes
 * tokens; we cannot trust that a presented payload follows the expected
 * shape just because the signature happened to verify against an old or
 * malformed payload format.
 */
export class SessionTokenService {
  private _signingKey: string;

  constructor(sessionTokenConfig: SessionTokenConfig) {
    this._signingKey = sessionTokenConfig.signingKey;
  }

  /**
   * Verifies a token's signature, decodes its payload, and validates the
   * payload structure against {@link SESSION_TOKEN_PAYLOAD_SCHEMA}. Does NOT
   * check `exp`; callers that need expiry enforcement should compare
   * `payload.exp` against `Date.now()` themselves.
   * @param token A token produced by Session Manager's session-token signer.
   * @returns The decoded payload, or `null` if the token is malformed, has an invalid signature, or fails schema validation.
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
