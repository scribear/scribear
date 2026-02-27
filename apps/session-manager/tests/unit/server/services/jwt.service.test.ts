import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import type { BaseLogger } from '@scribear/base-fastify-server';

import {
  type JwtPayload,
  JwtService,
  type JwtServiceConfig,
} from '#src/server/services/jwt.service.js';

describe('JwtService', () => {
  let mockLogger: MockProxy<BaseLogger>;
  let jwtService: JwtService;
  const testSecret = 'test-jwt-secret-must-be-at-least-32-characters-long';
  const defaultConfig: JwtServiceConfig = {
    jwtSecret: testSecret,
    jwtIssuer: 'scribear-session-manager',
    jwtExpiresIn: '24h',
  };

  beforeEach(() => {
    mockLogger = mock<BaseLogger>();
    jwtService = new JwtService(mockLogger, defaultConfig);
  });

  describe('constructor', (it) => {
    /**
     * Test that constructor accepts valid secret
     */
    it('accepts valid secret', () => {
      // Act & Assert
      expect(() => new JwtService(mockLogger, defaultConfig)).not.toThrow();
    });

    /**
     * Test that constructor uses default values for optional parameters
     */
    it('uses default values for optional parameters', () => {
      // Arrange & Act
      const service = new JwtService(mockLogger, defaultConfig);
      const token = service.issueToken('session_123', 'source');

      // Assert
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      expect(decoded.iss).toBe('scribear-session-manager');
    });

    /**
     * Test that constructor accepts custom issuer
     */
    it('accepts custom issuer', () => {
      // Arrange & Act
      const service = new JwtService(mockLogger, {
        ...defaultConfig,
        jwtSecret: testSecret,
        jwtIssuer: 'custom-issuer',
      });
      const token = service.issueToken('session_123', 'source');

      // Assert
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      expect(decoded.iss).toBe('custom-issuer');
    });
  });

  describe('issueToken', (it) => {
    /**
     * Test that issueToken creates valid JWT with all required fields
     */
    it('issues token with all required fields', () => {
      // Act
      const token = jwtService.issueToken('session_abc123', 'source');

      // Assert
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = jwt.decode(token) as JwtPayload & jwt.JwtPayload;
      expect(decoded.sessionId).toBe('session_abc123');
      expect(decoded.scope).toBe('source');
      expect(decoded.iss).toBe('scribear-session-manager');
      expect(decoded.exp).toBeDefined();
    });

    /**
     * Test that issueToken includes sourceId when provided
     */
    it('includes sourceId when provided', () => {
      // Act
      const token = jwtService.issueToken(
        'session_abc123',
        'source',
        'audio-source-1',
      );

      // Assert
      const decoded = jwt.decode(token) as JwtPayload;
      expect(decoded.sourceId).toBe('audio-source-1');
    });

    /**
     * Test that issueToken omits sourceId when not provided
     */
    it('omits sourceId when not provided', () => {
      // Act
      const token = jwtService.issueToken('session_abc123', 'sink');

      // Assert
      const decoded = jwt.decode(token) as JwtPayload;
      expect(decoded.sourceId).toBeUndefined();
    });

    /**
     * Test that issueToken handles all scope types
     */
    it('issues token with source scope', () => {
      // Act
      const token = jwtService.issueToken('session_123', 'source');

      // Assert
      const decoded = jwt.decode(token) as JwtPayload;
      expect(decoded.scope).toBe('source');
    });

    it('issues token with sink scope', () => {
      // Act
      const token = jwtService.issueToken('session_123', 'sink');

      // Assert
      const decoded = jwt.decode(token) as JwtPayload;
      expect(decoded.scope).toBe('sink');
    });

    it('issues token with both scope', () => {
      // Act
      const token = jwtService.issueToken('session_123', 'both');

      // Assert
      const decoded = jwt.decode(token) as JwtPayload;
      expect(decoded.scope).toBe('both');
    });

    /**
     * Test that issueToken uses default expiration time
     */
    it('uses default expiration time', () => {
      // Arrange
      const beforeIssue = Math.floor(Date.now() / 1000);

      // Act
      const token = jwtService.issueToken('session_123', 'source');

      // Assert
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      expect(decoded.exp).toBeDefined();

      const expiresAt = decoded.exp!;
      const expectedExpiry = beforeIssue + 24 * 60 * 60; // 24 hours in seconds

      // Allow 5 second tolerance for test timing variations
      expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5);
    });

    /**
     * Test that issueToken respects custom expiration time
     */
    it('respects custom expiration time', () => {
      // Arrange
      const beforeIssue = Math.floor(Date.now() / 1000);

      // Act
      const token = jwtService.issueToken(
        'session_123',
        'source',
        undefined,
        '1h',
      );

      // Assert
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      const expiresAt = decoded.exp!;
      const expectedExpiry = beforeIssue + 60 * 60; // 1 hour in seconds

      // Allow 5 second tolerance for test timing variations
      expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5);
    });

    /**
     * Test that issueToken logs the operation
     */
    it('logs token issuance', () => {
      // Act
      jwtService.issueToken('session_123', 'source', 'audio-1');

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        { sessionId: 'session_123', scope: 'source', sourceId: 'audio-1' },
        'Issuing JWT token for session',
      );
    });

    /**
     * Test that issueToken uses HS256 algorithm
     */
    it('uses HS256 algorithm', () => {
      // Act
      const token = jwtService.issueToken('session_123', 'source');

      // Assert
      const decoded = jwt.decode(token, { complete: true }) as {
        header: { alg: string };
      };
      expect(decoded.header.alg).toBe('HS256');
    });
  });

  describe('verifyToken', (it) => {
    /**
     * Test that verifyToken successfully verifies valid token
     */
    it('verifies valid token', () => {
      // Arrange
      const token = jwtService.issueToken('session_abc123', 'source');

      // Act
      const result = jwtService.verifyToken(token);

      // Assert
      expect(result.valid).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.payload?.sessionId).toBe('session_abc123');
      expect(result.payload?.scope).toBe('source');
      expect(result.error).toBeUndefined();
    });

    /**
     * Test that verifyToken rejects token with invalid signature
     */
    it('rejects token with invalid signature', () => {
      // Arrange
      const differentSecret = 'different-secret-must-be-at-least-32-chars-long';
      const differentService = new JwtService(mockLogger, {
        ...defaultConfig,
        jwtSecret: differentSecret,
      });
      const token = differentService.issueToken('session_123', 'source');

      // Act
      const result = jwtService.verifyToken(token);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.payload).toBeUndefined();
      expect(result.error).toContain('invalid signature');
    });

    /**
     * Test that verifyToken rejects malformed token
     */
    it('rejects malformed token', () => {
      // Act
      const result = jwtService.verifyToken('invalid.token.format');

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    /**
     * Test that verifyToken rejects expired token
     */
    it('rejects expired token', () => {
      // Arrange - create token that's already expired
      const token = jwtService.issueToken(
        'session_123',
        'source',
        undefined,
        '-1s',
      );

      // Act
      const result = jwtService.verifyToken(token);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    /**
     * Test that verifyToken rejects token with wrong issuer
     */
    it('rejects token with wrong issuer', () => {
      // Arrange
      const differentService = new JwtService(mockLogger, {
        ...defaultConfig,
        jwtSecret: testSecret,
        jwtIssuer: 'different-issuer',
      });
      const token = differentService.issueToken('session_123', 'source');

      // Act
      const result = jwtService.verifyToken(token);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.error).toContain('issuer');
    });

    /**
     * Test that verifyToken logs success
     */
    it('logs successful verification', () => {
      // Arrange
      const token = jwtService.issueToken('session_123', 'source');

      // Act
      jwtService.verifyToken(token);

      // Assert
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { sessionId: 'session_123', scope: 'source' },
        'JWT token verified successfully',
      );
    });

    /**
     * Test that verifyToken logs failure
     */
    it('logs verification failure', () => {
      // Act
      jwtService.verifyToken('invalid.token');

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
        'JWT verification failed',
      );
    });
  });

  describe('decodeToken', (it) => {
    /**
     * Test that decodeToken decodes valid token without verification
     */
    it('decodes token without verification', () => {
      // Arrange
      const token = jwtService.issueToken(
        'session_abc123',
        'source',
        'audio-1',
      );

      // Act
      const decoded = jwtService.decodeToken(token);

      // Assert
      expect(decoded).toBeDefined();
      expect(decoded?.sessionId).toBe('session_abc123');
      expect(decoded?.scope).toBe('source');
      expect(decoded?.sourceId).toBe('audio-1');
    });

    /**
     * Test that decodeToken works with expired tokens
     */
    it('decodes expired token', () => {
      // Arrange - create token that's already expired
      const token = jwtService.issueToken(
        'session_123',
        'source',
        undefined,
        '-1s',
      );

      // Act
      const decoded = jwtService.decodeToken(token);

      // Assert
      expect(decoded).toBeDefined();
      expect(decoded?.sessionId).toBe('session_123');
    });

    /**
     * Test that decodeToken returns null for invalid token
     */
    it('returns null for invalid token', () => {
      // Act
      const decoded = jwtService.decodeToken('not-a-jwt-token');

      // Assert
      expect(decoded).toBeNull();
    });

    /**
     * Test that decodeToken returns null for malformed token
     */
    it('returns null for malformed token', () => {
      // Act
      const decoded = jwtService.decodeToken('invalid');

      // Assert
      expect(decoded).toBeNull();
    });
  });

  describe('isTokenExpired', (it) => {
    /**
     * Test that isTokenExpired returns false for valid token
     */
    it('returns false for valid token', () => {
      // Arrange
      const token = jwtService.issueToken('session_123', 'source');

      // Act
      const expired = jwtService.isTokenExpired(token);

      // Assert
      expect(expired).toBe(false);
    });

    /**
     * Test that isTokenExpired returns true for expired token
     */
    it('returns true for expired token', () => {
      // Arrange - create token that's already expired
      const token = jwtService.issueToken(
        'session_123',
        'source',
        undefined,
        '-1s',
      );

      // Act
      const expired = jwtService.isTokenExpired(token);

      // Assert
      expect(expired).toBe(true);
    });

    /**
     * Test that isTokenExpired returns true for token without exp claim
     */
    it('returns true for token without exp claim', () => {
      // Arrange
      const tokenWithoutExp = jwt.sign(
        { sessionId: 'session_123', scope: 'source' },
        testSecret,
      );

      // Act
      const expired = jwtService.isTokenExpired(tokenWithoutExp);

      // Assert
      expect(expired).toBe(true);
    });

    /**
     * Test that isTokenExpired returns true for invalid token
     */
    it('returns true for invalid token', () => {
      // Act
      const expired = jwtService.isTokenExpired('invalid-token');

      // Assert
      expect(expired).toBe(true);
    });
  });

  describe('token integration', (it) => {
    /**
     * Test complete token lifecycle: issue, verify, decode
     */
    it('completes full token lifecycle', () => {
      // Arrange & Act
      const token = jwtService.issueToken('session_full', 'both', 'source-1');

      const verifyResult = jwtService.verifyToken(token);
      const decoded = jwtService.decodeToken(token);
      const expired = jwtService.isTokenExpired(token);

      // Assert
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.payload?.sessionId).toBe('session_full');
      expect(verifyResult.payload?.scope).toBe('both');
      expect(verifyResult.payload?.sourceId).toBe('source-1');

      expect(decoded?.sessionId).toBe('session_full');
      expect(decoded?.scope).toBe('both');
      expect(decoded?.sourceId).toBe('source-1');

      expect(expired).toBe(false);
    });
  });
});
