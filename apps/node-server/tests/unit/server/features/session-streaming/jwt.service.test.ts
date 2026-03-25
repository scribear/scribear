import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect } from 'vitest';

import { SessionTokenScope } from '@scribear/node-server-schema';

import { JwtService } from '#src/server/features/session-streaming/jwt.service.js';

const TEST_JWT_SECRET = 'a-secret-that-is-at-least-32-characters-long';
const TEST_SESSION_ID = 'test-session-id';
const TEST_SCOPES = [
  SessionTokenScope.SEND_AUDIO,
  SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
];

function signToken(
  payload: Record<string, unknown>,
  secret = TEST_JWT_SECRET,
  expiresIn = 3600,
): string {
  return jwt.sign(payload, secret, { expiresIn });
}

describe('JwtService', () => {
  let service: JwtService;

  beforeEach(() => {
    service = new JwtService({ jwtSecret: TEST_JWT_SECRET });
  });

  describe('verifySessionToken', (it) => {
    it('returns decoded payload for a valid token', () => {
      // Arrange
      const token = signToken({
        sessionId: TEST_SESSION_ID,
        scopes: TEST_SCOPES,
      });

      // Act
      const result = service.verifySessionToken(token);

      // Assert
      expect(result).toMatchObject({
        sessionId: TEST_SESSION_ID,
        scopes: TEST_SCOPES,
      });
      expect(result?.exp).toEqual(expect.any(Number));
    });

    it('returns null for a token signed with a different secret', () => {
      // Arrange
      const token = signToken(
        { sessionId: TEST_SESSION_ID, scopes: TEST_SCOPES },
        'a-different-secret-that-is-also-32-chars',
      );

      // Act
      const result = service.verifySessionToken(token);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for an expired token', () => {
      // Arrange
      const token = jwt.sign(
        { sessionId: TEST_SESSION_ID, scopes: TEST_SCOPES },
        TEST_JWT_SECRET,
        { expiresIn: -1 },
      );

      // Act
      const result = service.verifySessionToken(token);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for a malformed token', () => {
      // Act
      const result = service.verifySessionToken('not-a-jwt');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when payload is missing required fields', () => {
      // Arrange
      const token = signToken({ foo: 'bar' });

      // Act
      const result = service.verifySessionToken(token);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when scopes contain invalid values', () => {
      // Arrange
      const token = signToken({
        sessionId: TEST_SESSION_ID,
        scopes: ['INVALID_SCOPE'],
      });

      // Act
      const result = service.verifySessionToken(token);

      // Assert
      expect(result).toBeNull();
    });
  });
});
