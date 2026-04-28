import crypto from 'node:crypto';
import { describe, expect } from 'vitest';

import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { SessionTokenService } from '#src/server/shared/services/session-token.service.js';

const SIGNING_KEY = 'unit-test-signing-key';

const VALID_PAYLOAD: SessionTokenPayload = {
  sessionUid: '00000000-0000-0000-0000-000000000001',
  clientId: 'client-1',
  scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
  exp: 1_700_000_000,
};

/**
 * Mirror Session Manager's signing path so the verify-only Node Server
 * service can be exercised end-to-end without depending on Session Manager
 * source.
 */
function sign(payload: unknown, key: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = crypto
    .createHmac('sha256', key)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

describe('SessionTokenService', (it) => {
  it('verifies and returns the payload for a well-formed token', () => {
    // Arrange
    const service = new SessionTokenService({ signingKey: SIGNING_KEY });
    const token = sign(VALID_PAYLOAD, SIGNING_KEY);

    // Act
    const result = service.verify(token);

    // Assert
    expect(result).toStrictEqual(VALID_PAYLOAD);
  });

  it('returns null for a token signed with a different key', () => {
    // Arrange
    const service = new SessionTokenService({ signingKey: SIGNING_KEY });
    const token = sign(VALID_PAYLOAD, 'wrong-key');

    // Act
    const result = service.verify(token);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null when the token has no separator', () => {
    // Arrange
    const service = new SessionTokenService({ signingKey: SIGNING_KEY });

    // Act / Assert
    expect(service.verify('no-dot-here')).toBeNull();
  });

  it('returns null for a payload that does not match the schema', () => {
    // Arrange - sign a structurally invalid payload (wrong sessionUid format)
    // with the correct key so signature passes but Value.Check rejects it.
    const service = new SessionTokenService({ signingKey: SIGNING_KEY });
    const bogusPayload = {
      sessionUid: 'not-a-uuid',
      clientId: 'c',
      scopes: ['SEND_AUDIO'],
      exp: 1_700_000_000,
    };
    const token = sign(bogusPayload, SIGNING_KEY);

    // Act
    const result = service.verify(token);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null when the signature length differs (no timing-safe compare crash)', () => {
    // Arrange - hand-craft a token with a too-short signature.
    const service = new SessionTokenService({ signingKey: SIGNING_KEY });
    const encoded = Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString(
      'base64url',
    );
    const token = `${encoded}.short`;

    // Act
    const result = service.verify(token);

    // Assert
    expect(result).toBeNull();
  });

  it('returns null when the encoded payload is not valid JSON', () => {
    // Arrange - sign a non-JSON string with the right key.
    const service = new SessionTokenService({ signingKey: SIGNING_KEY });
    const encoded = Buffer.from('not-json', 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', SIGNING_KEY)
      .update(encoded)
      .digest('base64url');

    // Act
    const result = service.verify(`${encoded}.${signature}`);

    // Assert
    expect(result).toBeNull();
  });
});
