import Fastify, { type FastifyInstance } from 'fastify';
import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '#src/server/errors/http-errors.js';
import notFoundHandler from '#src/server/plugins/not-found-handler.js';

describe('Not Found Handler Plugin', (it) => {
  let fastify: FastifyInstance;
  let mockErrorHandler: Mock;

  beforeEach(() => {
    mockErrorHandler = vi.fn().mockReturnValue('');

    fastify = Fastify();

    fastify.setErrorHandler(mockErrorHandler);
    fastify.register(notFoundHandler);
  });

  /**
   * Test that Not Found handler plugin throws Not Found error when called
   */
  it('throws NotFound error', async () => {
    // Arrange / Act
    await fastify.inject({
      method: 'GET',
      url: '/test',
    });

    // Assert
    expect(mockErrorHandler).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.NotFound),
      expect.anything(),
      expect.anything(),
    );
  });
});
