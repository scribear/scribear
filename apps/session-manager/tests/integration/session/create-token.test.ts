import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';

import AppConfig from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

describe('Integration Tests - POST /session/token', () => {
  let fastify: BaseFastifyInstance;
  let testConfig: AppConfig;

  beforeEach(async () => {
    // Use vi.stubEnv to set environment variables
    vi.stubEnv('LOG_LEVEL', LogLevel.SILENT);
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('HOST', 'localhost');
    vi.stubEnv(
      'JWT_SECRET',
      'test-jwt-secret-with-at-least-32-characters-long',
    );
    vi.stubEnv('JWT_ISSUER', 'scribear-session-manager');
    vi.stubEnv('JWT_EXPIRES_IN', '24h');
    vi.stubEnv('DB_HOST', 'localhost');
    vi.stubEnv('DB_PORT', '5432');
    vi.stubEnv('DB_NAME', 'scribear-db');
    vi.stubEnv('DB_USER', 'scribear');
    vi.stubEnv('DB_PASSWORD', 'CHANGEME');

    // Create a real AppConfig instance with stubbed environment variables
    testConfig = new AppConfig();

    const server = await createServer(testConfig);
    fastify = server.fastify;

    // Wait for server to be ready
    await fastify.ready();
  });

  /**
   * Helper function to create a session and return session details
   */
  async function createSession(enableJoinCode = false) {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: {
        sessionLength: 3600,
        enableJoinCode,
        audioSourceSecret: 'test-audio-source-secret-123',
      },
    });

    expect(response.statusCode).toBe(200);
    return response.json();
  }

  describe('Token creation via sessionId and audioSourceSecret', () => {
    /**
     * Test that server successfully creates token with source scope
     */
    it('creates token with source scope', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'source' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('expiresIn', '24h');
      expect(body).toHaveProperty('sessionId', session.sessionId);
      expect(body).toHaveProperty('scope', 'source');
      expect(typeof body.token).toBe('string');
    });

    /**
     * Test that server successfully creates token with sink scope
     */
    it('creates token with sink scope', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'sink' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('scope', 'sink');
    });

    /**
     * Test that server successfully creates token with both scope
     */
    it('creates token with both scope', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'both' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('scope', 'both');
    });

    /**
     * Test that server rejects token creation with invalid audioSourceSecret
     */
    it('rejects token with invalid audioSourceSecret', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'wrong-secret-1234567890',
        scope: 'source' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body).toHaveProperty(
        'message',
        'Invalid session ID or audio source secret',
      );
    });

    /**
     * Test that server rejects token creation with invalid sessionId
     */
    it('rejects token with invalid sessionId', async () => {
      // Arrange
      const request = {
        sessionId: 'session_invalid123456789012345678901234',
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'source' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe('Token creation via joinCode', (it) => {
    /**
     * Test that server successfully creates token using join code
     */
    it('creates token with valid joinCode', async () => {
      // Arrange
      const session = await createSession(true);
      const request = {
        joinCode: session.joinCode!,
        scope: 'sink' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('expiresIn', '24h');
      expect(body).toHaveProperty('sessionId', session.sessionId);
      expect(body).toHaveProperty('scope', 'sink');
    });

    /**
     * Test that server rejects token creation with invalid join code
     */
    it('rejects token with invalid joinCode', async () => {
      // Arrange
      const request = {
        joinCode: 'INVALID1',
        scope: 'sink' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body).toHaveProperty('message', 'Invalid join code');
    });

    /**
     * Test that server creates token with all valid scopes via join code
     */
    it('creates token with source scope via joinCode', async () => {
      // Arrange
      const session = await createSession(true);
      const request = {
        joinCode: session.joinCode!,
        scope: 'source' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('scope', 'source');
    });
  });

  describe('Token validation', (it) => {
    /**
     * Test that server rejects token creation for non-existent session
     */
    it('rejects token for non-existent session', async () => {
      // Arrange
      const request = {
        sessionId: 'session_00000000000000000000000000000000',
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'source' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    /**
     * Test that server rejects token creation with invalid scope
     */
    it('rejects token with invalid scope', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'invalid' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });

    /**
     * Test that server rejects token creation with missing scope
     */
    it('rejects token with missing scope', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'test-audio-source-secret-123',
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });
  });

  describe('Token content verification', (it) => {
    /**
     * Test that issued token can be decoded and contains correct payload
     */
    it('issues valid JWT token with correct payload', async () => {
      // Arrange
      const session = await createSession();
      const request = {
        sessionId: session.sessionId,
        audioSourceSecret: 'test-audio-source-secret-123',
        scope: 'source' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Decode JWT token (without verification, just to check payload structure)
      const tokenParts = (body.token as string).split('.');
      expect(tokenParts).toHaveLength(3);

      const payloadPart = tokenParts[1];
      if (!payloadPart) {
        throw new Error('Token payload part is missing');
      }

      const payload = JSON.parse(
        Buffer.from(payloadPart, 'base64').toString('utf-8'),
      ) as { sessionId: string; scope: string; sourceId?: string; iss: string };

      expect(payload).toHaveProperty('sessionId', session.sessionId);
      expect(payload).toHaveProperty('scope', 'source');
      expect(payload).toHaveProperty('sourceId', 'audio-source');
      expect(payload).toHaveProperty('iss', 'scribear-session-manager');
    });

    /**
     * Test that join code tokens do not include sourceId
     */
    it('issues token without sourceId when using joinCode', async () => {
      // Arrange
      const session = await createSession(true);
      const request = {
        joinCode: session.joinCode!,
        scope: 'sink' as const,
      };

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session/token',
        body: request,
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json();

      const tokenParts = (body.token as string).split('.');
      const payloadPart = tokenParts[1];
      if (!payloadPart) {
        throw new Error('Token payload part is missing');
      }

      const payload = JSON.parse(
        Buffer.from(payloadPart, 'base64').toString('utf-8'),
      ) as { sessionId: string; scope: string; sourceId?: string };

      expect(payload).not.toHaveProperty('sourceId');
    });
  });
});
