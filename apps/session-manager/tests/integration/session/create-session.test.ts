import { beforeEach, describe, expect, vi } from 'vitest';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';

import AppConfig from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

describe('Integration Tests - POST /session/create', (it) => {
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
   * Test that server successfully creates a session without join code
   */
  it('creates session without join code', async () => {
    // Arrange
    const request = {
      sessionLength: 3600,
      maxClients: 10,
      enableJoinCode: false,
      audioSourceSecret: 'test-audio-source-secret-123',
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('sessionId');
    expect(body).toHaveProperty('expiresAt');
    expect(body).not.toHaveProperty('joinCode');
    expect(body.sessionId).toMatch(/^session_[0-9a-f]{32}$/);
  });

  /**
   * Test that server successfully creates a session with join code
   */
  it('creates session with join code', async () => {
    // Arrange
    const request = {
      sessionLength: 3600,
      maxClients: 10,
      enableJoinCode: true,
      audioSourceSecret: 'test-audio-source-secret-123',
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('sessionId');
    expect(body).toHaveProperty('joinCode');
    expect(body).toHaveProperty('expiresAt');
    expect(body.sessionId).toMatch(/^session_[0-9a-f]{32}$/);
    expect(body.joinCode).toHaveLength(8);
    expect(body.joinCode).toMatch(/^[A-Z0-9]{8}$/);
  });

  /**
   * Test that server creates session with default values when optional fields omitted
   */
  it('creates session with default values', async () => {
    // Arrange
    const request = {
      sessionLength: 3600,
      audioSourceSecret: 'test-audio-source-secret-123',
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('sessionId');
    expect(body).toHaveProperty('expiresAt');
    expect(body).not.toHaveProperty('joinCode');
  });

  /**
   * Test that server rejects session creation with too short session length
   */
  it('rejects session with sessionLength below minimum', async () => {
    // Arrange
    const request = {
      sessionLength: 30, // Below minimum of 60
      audioSourceSecret: 'test-audio-source-secret-123',
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/body/sessionLength',
        },
      ],
    });
  });

  /**
   * Test that server rejects session creation with too long session length
   */
  it('rejects session with sessionLength above maximum', async () => {
    // Arrange
    const request = {
      sessionLength: 90000, // Above maximum of 86400
      audioSourceSecret: 'test-audio-source-secret-123',
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/body/sessionLength',
        },
      ],
    });
  });

  /**
   * Test that server rejects session creation with too short audio source secret
   */
  it('rejects session with short audioSourceSecret', async () => {
    // Arrange
    const request = {
      sessionLength: 3600,
      audioSourceSecret: 'short', // Below minimum of 16 characters
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/body/audioSourceSecret',
        },
      ],
    });
  });

  /**
   * Test that server rejects session creation with negative maxClients
   */
  it('rejects session with negative maxClients', async () => {
    // Arrange
    const request = {
      sessionLength: 3600,
      maxClients: -1,
      audioSourceSecret: 'test-audio-source-secret-123',
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/body/maxClients',
        },
      ],
    });
  });

  /**
   * Test that server rejects session creation with missing required fields
   */
  it('rejects session with missing audioSourceSecret', async () => {
    // Arrange
    const request = {
      sessionLength: 3600,
    };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
  });

  /**
   * Test that expiresAt is correctly calculated based on sessionLength
   */
  it('sets correct expiration time based on sessionLength', async () => {
    // Arrange
    const sessionLength = 3600; // 1 hour
    const request = {
      sessionLength,
      audioSourceSecret: 'test-audio-source-secret-123',
    };
    const beforeRequest = Date.now();

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session/create',
      body: request,
    });
    const afterRequest = Date.now();

    // Assert
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const expiresAt = new Date(body.expiresAt as string).getTime();
    const expectedMin = beforeRequest + sessionLength * 1000;
    const expectedMax = afterRequest + sessionLength * 1000;

    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });
});
