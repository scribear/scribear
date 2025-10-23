import type { AwilixContainer } from 'awilix';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import type { BaseLogger } from '../../../../../src/server/create_logger.js';
import scopeLogger from '../../../../../src/server/hooks/on_request/scope_logger.js';

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

    fastify.decorateRequest('log', {
      getter: () => mockLogger as unknown as BaseLogger,
      setter: () => mockLogger,
    });
    fastify.decorateRequest('diScope', {
      getter: () => mockDiScope as unknown as AwilixContainer,
    });

    fastify.register(scopeLogger);
  });

  /**
   * Test that scopeLogger hook registers logger with request scoped dependency container
   */
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
});
