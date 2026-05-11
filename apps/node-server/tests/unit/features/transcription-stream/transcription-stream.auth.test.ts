import crypto from 'node:crypto';
import { describe, expect } from 'vitest';

import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { verifyAuth } from '#src/server/features/transcription-stream/transcription-stream.auth.js';
import { SessionTokenService } from '#src/server/shared/services/session-token.service.js';

const SIGNING_KEY = 'auth-test-key';
const SESSION_UID = '00000000-0000-0000-0000-000000000abc';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function signToken(payload: SessionTokenPayload, key = SIGNING_KEY): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = crypto
    .createHmac('sha256', key)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

const tokens = new SessionTokenService({ signingKey: SIGNING_KEY });

describe('verifyAuth', (it) => {
  it('accepts a valid source token with SEND_AUDIO scope', () => {
    // Arrange
    const token = signToken({
      sessionUid: SESSION_UID,
      clientId: 'c1',
      scopes: ['SEND_AUDIO'],
      exp: FAR_FUTURE,
    });

    // Act
    const result = verifyAuth('source', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({ ok: true });
  });

  it('accepts a valid client token with RECEIVE_TRANSCRIPTIONS scope', () => {
    // Arrange
    const token = signToken({
      sessionUid: SESSION_UID,
      clientId: 'c1',
      scopes: ['RECEIVE_TRANSCRIPTIONS'],
      exp: FAR_FUTURE,
    });

    // Act
    const result = verifyAuth('client', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({ ok: true });
  });

  it('rejects an invalid-signature token with 1008 invalid-token', () => {
    // Arrange
    const token = signToken(
      {
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: FAR_FUTURE,
      },
      'wrong-key',
    );

    // Act
    const result = verifyAuth('source', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1008,
      reason: 'invalid-token',
    });
  });

  it('rejects an expired token with 1008 token-expired', () => {
    // Arrange
    const token = signToken({
      sessionUid: SESSION_UID,
      clientId: 'c1',
      scopes: ['SEND_AUDIO'],
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    // Act
    const result = verifyAuth('source', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1008,
      reason: 'token-expired',
    });
  });

  it('rejects a sessionUid mismatch with 1008 session-mismatch', () => {
    // Arrange
    const token = signToken({
      sessionUid: '00000000-0000-0000-0000-000000000999',
      clientId: 'c1',
      scopes: ['SEND_AUDIO'],
      exp: FAR_FUTURE,
    });

    // Act
    const result = verifyAuth('source', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1008,
      reason: 'session-mismatch',
    });
  });

  it('rejects a source-role token lacking SEND_AUDIO with 1008 missing-scope', () => {
    // Arrange
    const token = signToken({
      sessionUid: SESSION_UID,
      clientId: 'c1',
      scopes: ['RECEIVE_TRANSCRIPTIONS'],
      exp: FAR_FUTURE,
    });

    // Act
    const result = verifyAuth('source', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1008,
      reason: 'missing-scope',
    });
  });

  it('rejects a client-role token lacking RECEIVE_TRANSCRIPTIONS with 1008 missing-scope', () => {
    // Arrange
    const token = signToken({
      sessionUid: SESSION_UID,
      clientId: 'c1',
      scopes: ['SEND_AUDIO'],
      exp: FAR_FUTURE,
    });

    // Act
    const result = verifyAuth('client', SESSION_UID, token, tokens);

    // Assert
    expect(result).toEqual({
      ok: false,
      code: 1008,
      reason: 'missing-scope',
    });
  });
});
