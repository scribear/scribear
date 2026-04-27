import { beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '#src/index.js';
import createBaseServer from '#src/server/create-base-server.js';
import { HttpError } from '#src/server/errors/http-errors.js';
import type { BaseFastifyInstance } from '#src/server/types/base-fastify-types.js';

describe('Integration Tests - Request ID Header', (it) => {
  let fastify: BaseFastifyInstance;

  beforeEach(() => {
    fastify = createBaseServer(LogLevel.SILENT).fastify;
  });

  it('includes X-Request-ID header on successful responses', async () => {
    // Arrange
    fastify.get('/test', (_req, reply) => reply.send());

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('includes X-Request-ID header on error responses', async () => {
    // Arrange
    fastify.get('/error', () => {
      throw HttpError.internal();
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/error' });

    // Assert
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('uses a unique request ID per request', async () => {
    // Arrange
    fastify.get('/test', (_req, reply) => reply.send());

    // Act
    const [first, second] = await Promise.all([
      fastify.inject({ method: 'GET', url: '/test' }),
      fastify.inject({ method: 'GET', url: '/test' }),
    ]);

    // Assert
    expect(first.headers['x-request-id']).not.toBe(
      second.headers['x-request-id'],
    );
  });
});
