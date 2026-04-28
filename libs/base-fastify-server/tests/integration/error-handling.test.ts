import { beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '#src/index.js';
import createBaseServer from '#src/server/create-base-server.js';
import { HttpError } from '#src/server/errors/http-errors.js';
import type { BaseFastifyInstance } from '#src/server/types/base-fastify-types.js';

describe('Integration Tests - Error Handling', (it) => {
  let fastify: BaseFastifyInstance;

  beforeEach(() => {
    const server = createBaseServer(LogLevel.SILENT);

    fastify = server.fastify;
  });

  it('serializes a 400 validation error with details', async () => {
    // Arrange
    const details = {
      validationErrors: [
        { message: 'something wrong', path: '/body' },
        { message: 'something else', path: '/body/a' },
      ],
    };
    fastify.get('/error', () => {
      throw HttpError.badRequest('Request validation failed.', details);
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/error' });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details,
    });
  });

  it.for([
    {
      make: () => HttpError.unauthorized('nope'),
      status: 401,
      code: 'UNAUTHORIZED',
    },
    {
      make: () => HttpError.forbidden('ADMIN_ONLY', 'admin only'),
      status: 403,
      code: 'ADMIN_ONLY',
    },
    {
      make: () => HttpError.notFound('ROOM_NOT_FOUND', 'gone'),
      status: 404,
      code: 'ROOM_NOT_FOUND',
    },
    {
      make: () => HttpError.conflict('SCHEDULE_CONFLICT', 'overlap'),
      status: 409,
      code: 'SCHEDULE_CONFLICT',
    },
    {
      make: () => HttpError.unprocessable('INVALID_TIMEZONE', 'bad tz'),
      status: 422,
      code: 'INVALID_TIMEZONE',
    },
    {
      make: () => HttpError.rateLimited(),
      status: 429,
      code: 'RATE_LIMITED',
    },
    {
      make: () => HttpError.internal(),
      status: 500,
      code: 'INTERNAL_ERROR',
    },
  ])(
    'serializes $code thrown in a handler as status $status',
    async ({ make, status, code }) => {
      // Arrange
      const err = make();
      fastify.get('/error', () => {
        throw err;
      });

      // Act
      const response = await fastify.inject({ method: 'GET', url: '/error' });

      // Assert
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        code,
        message: err.message,
      });
    },
  );

  it('returns a ROUTE_NOT_FOUND body for unknown paths', async () => {
    // Arrange / Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/error/notfound',
    });

    // Assert
    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({
      code: 'ROUTE_NOT_FOUND',
      message: 'Route GET: /error/notfound not found.',
    });
  });

  it('maps any non-HttpError thrown in a handler to 500 INTERNAL_ERROR', async () => {
    // Arrange
    fastify.get('/error', () => {
      throw new Error('Server Error');
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/error' });

    // Assert
    expect(response.statusCode).toBe(500);
    expect(response.json()).toStrictEqual({
      code: 'INTERNAL_ERROR',
      message:
        'Server encountered an unexpected error. Please try again later.',
    });
  });
});
