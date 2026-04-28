import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect } from 'vitest';

import { HttpError } from '#src/server/errors/http-errors.js';
import errorHandler from '#src/server/plugins/error-handler.js';

describe('Error Handler Plugin', (it) => {
  const testRequestId = 'TEST-REQUEST-ID';

  let fastify: FastifyInstance;

  beforeEach(() => {
    fastify = Fastify({ genReqId: () => testRequestId });
    fastify.register(errorHandler);
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
      make: () => HttpError.notFound('ROOM_NOT_FOUND', 'missing'),
      status: 404,
      code: 'ROOM_NOT_FOUND',
    },
    {
      make: () =>
        HttpError.conflict('SCHEDULE_CONFLICT', 'overlap', { sessionUid: 'x' }),
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
    'serializes $code as status $status with canonical body',
    async ({ make, status, code }) => {
      // Arrange
      const err = make();
      fastify.get('/test', () => {
        throw err;
      });

      // Act
      const response = await fastify.inject({ method: 'GET', url: '/test' });

      // Assert
      expect(response.statusCode).toBe(status);
      const body = JSON.parse(response.payload) as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe(code);
      expect(body.message).toBe(err.message);
      if (err.details !== undefined) {
        expect(body.details).toStrictEqual(err.details);
      }
    },
  );

  it('includes details on the serialized body when provided', async () => {
    // Arrange
    const err = HttpError.conflict('SCHEDULE_CONFLICT', 'overlap', {
      conflictingSessionUid: 'u-1',
    });
    fastify.get('/test', () => {
      throw err;
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload)).toStrictEqual({
      code: 'SCHEDULE_CONFLICT',
      message: 'overlap',
      details: { conflictingSessionUid: 'u-1' },
    });
  });

  it.for([
    {
      statusCode: 405,
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.',
    },
    { statusCode: 406, code: 'NOT_ACCEPTABLE', message: 'Not acceptable.' },
    {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large.',
    },
    {
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported media type.',
    },
  ])(
    'normalizes framework $statusCode to $code',
    async ({ statusCode, code, message }) => {
      // Arrange - simulate a Fastify framework error (has statusCode but is not BaseHttpError)
      const frameworkErr = Object.assign(new Error('framework'), {
        statusCode,
      });
      fastify.get('/test', () => {
        throw frameworkErr;
      });

      // Act
      const response = await fastify.inject({ method: 'GET', url: '/test' });

      // Assert
      expect(response.statusCode).toBe(statusCode);
      expect(JSON.parse(response.payload)).toStrictEqual({ code, message });
    },
  );

  it('handles non-HttpError as 500 INTERNAL_ERROR', async () => {
    // Arrange
    fastify.get('/test', () => {
      throw new Error('Something went wrong');
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.payload)).toStrictEqual({
      code: 'INTERNAL_ERROR',
      message:
        'Server encountered an unexpected error. Please try again later.',
    });
  });
});
