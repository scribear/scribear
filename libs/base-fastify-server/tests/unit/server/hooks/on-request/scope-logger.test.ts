import type { Cradle, RequestCradle } from '@fastify/awilix';
import type { AwilixContainer } from 'awilix';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import type { BaseLogger } from '#src/server/create-logger.js';
import scopeLogger from '#src/server/hooks/on-request/scope-logger.js';

// Override awilix asValue function to be a no-op
vi.mock('awilix', () => ({
  asValue: vi.fn((a: unknown) => a),
}));

describe('Log Request Hook', (it) => {
  const testRequestId = 'TEST-REQUST-ID';

  let fastify: FastifyInstance;
  let mockLogger: { child: Mock };
  let mockDiScope: { register: Mock };

  beforeEach(() => {
    mockLogger = { child: vi.fn().mockReturnThis() };
    mockDiScope = { register: vi.fn() };

    fastify = Fastify({ genReqId: () => testRequestId });

    // fastify already decorates `log`; assign the mock per-request instead of
    // re-decorating (fastify throws FST_ERR_DEC_ALREADY_PRESENT since 5.8+)
    fastify.addHook('onRequest', (req, reply, done) => {
      req.log = mockLogger as unknown as BaseLogger;
      done();
    });
    fastify.decorateRequest('diScope', {
      getter: () =>
        mockDiScope as unknown as AwilixContainer<Cradle & RequestCradle>,
    });

    fastify.register(scopeLogger);
  });

  it('registers logger with dependency container', async () => {
    // Arrange / Act
    await fastify.inject({
      method: 'GET',
      url: '/test/hello/world',
    });

    // Assert
    expect(mockDiScope.register).toHaveBeenCalledExactlyOnceWith({
      logger: mockLogger,
    });
  });

  it('creates child logger with request id', async () => {
    // Arrange / Act
    await fastify.inject({
      method: 'GET',
      url: '/test/hello/world',
    });

    // Assert
    expect(mockLogger.child).toHaveBeenCalledExactlyOnceWith({
      reqId: testRequestId,
    });
  });
});
