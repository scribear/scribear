import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect } from 'vitest';

import setRequestIdHeader from '#src/server/hooks/on-send/set-request-id-header.js';

describe('Set Request ID Header Hook', (it) => {
  const testRequestId = 'TEST-REQUEST-ID';

  let fastify: FastifyInstance;

  beforeEach(() => {
    fastify = Fastify({ genReqId: () => testRequestId });
    fastify.register(setRequestIdHeader);
  });

  it('sets X-Request-ID header on response', async () => {
    // Arrange
    fastify.get('/test', (_req, reply) => reply.send());

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.headers['x-request-id']).toBe(testRequestId);
  });

  it('sets X-Request-ID header for routes without explicit handler', async () => {
    // Arrange / Act
    const response = await fastify.inject({ method: 'GET', url: '/not-found' });

    // Assert
    expect(response.headers['x-request-id']).toBe(testRequestId);
  });
});
