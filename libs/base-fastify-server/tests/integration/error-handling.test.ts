import { beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '#src/index.js';
import createBaseServer from '#src/server/create-base-server.js';
import { HttpError } from '#src/server/errors/http-errors.js';
import type { BaseFastifyInstance } from '#src/server/types/base-fastify-types.js';

/**
 * Integration tests for server error handling
 */
describe('Integration Tests - Error Handling', (it) => {
  let fastify: BaseFastifyInstance;

  beforeEach(() => {
    const server = createBaseServer(LogLevel.SILENT);

    fastify = server.fastify;
  });

  /**
   * Test that server returns correct response containg request error when BadRequest error is thrown in handler
   */
  it('returns 400 response when BadRequest error is thrown in handler', async () => {
    // Arrange
    const requestErrors = [
      { message: 'something wrong', key: '/body' },
      { message: 'something else', key: '/body/a' },
    ];
    fastify.get('/error', () => {
      throw new HttpError.BadRequest(requestErrors);
    });

    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/error',
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ requestErrors });
  });

  /**
   * Test that server returns correct response when HttpErrors are thrown in handler
   */
  it.for([
    { httpError: HttpError.Unauthorized, code: 401, name: 'Unauthorized' },
    { httpError: HttpError.Forbidden, code: 403, name: 'Forbidden' },
    { httpError: HttpError.NotFound, code: 404, name: 'NotFound' },
    {
      httpError: HttpError.TooManyRequests,
      code: 429,
      name: 'TooManyRequests',
    },
    { httpError: HttpError.ServerError, code: 500, name: 'ServerError' },
  ])(
    'returns $code response for $name error is thrown in handler',
    async ({ httpError, code }) => {
      // Arrange
      const errorMessage = 'Test unauthorized';
      fastify.get('/error', () => {
        throw new httpError(errorMessage);
      });

      // Act
      const response = await fastify.inject({
        method: 'GET',
        url: '/error',
      });

      // Assert
      expect(response.statusCode).toBe(code);
      expect(response.json()).toMatchObject({ message: errorMessage });
    },
  );

  /**
   * Test that server returns correct response when an invalid route is requested
   */
  it('returns 404 response when path is not found', async () => {
    // Arrange
    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/error/notfound',
    });

    // Assert
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      message: 'Route GET: /error/notfound not found',
    });
  });

  /**
   * Test that server returns correct response when a server error is thrown in handler
   */
  it('returns 500 response when general error is thrown in handler', async () => {
    // Arrange
    fastify.get('/error', () => {
      throw new Error('Server Error');
    });

    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/error',
    });

    // Assert
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      message: 'Sever encountered an unexpected error. Please try again later.',
    });
  });
});
