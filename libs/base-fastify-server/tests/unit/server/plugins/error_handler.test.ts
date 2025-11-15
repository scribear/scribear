import Fastify, { type FastifyInstance, errorCodes } from 'fastify';
import { beforeEach, describe, expect } from 'vitest';

import { HttpError } from '../../../../src/server/errors/http_errors.js';
import errorHandler from '../../../../src/server/plugins/error_handler.js';

describe('Error Handler Plugin', (it) => {
  const testRequestId = 'TEST-REQUEST-ID';

  let fastify: FastifyInstance;

  beforeEach(() => {
    fastify = Fastify({ genReqId: () => testRequestId });
    fastify.register(errorHandler);
  });

  /**
   * Check that error handler handles HttpErrors by return API response containing message and request id
   * Note: BadRequest has a different schema and is tested separately
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
    'handles $name by returning error message and request id',
    async ({ httpError, code }) => {
      // Arrange
      const errorMessage = 'Resource not found';
      fastify.get('/test', () => {
        throw new httpError(errorMessage);
      });

      // Act
      const response = await fastify.inject({ method: 'GET', url: '/test' });

      // Assertions
      expect(response.statusCode).toBe(code);
      expect(JSON.parse(response.payload)).toStrictEqual({
        message: errorMessage,
      });
    },
  );

  /**
   * Check that error handler handles BadRequest by returning API response containing request id and list of request errors
   */
  it('handles BadRequest by returning list of request errors', async () => {
    // Arrange
    const testRequestErrors = [
      { key: '/body/email', message: 'Invalid email format' },
      { key: '/body/password', message: 'Password is too short' },
    ];

    fastify.get('/test', () => {
      throw new HttpError.BadRequest(testRequestErrors);
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toStrictEqual({
      requestErrors: testRequestErrors,
    });
  });

  /**
   * Check that error handler lets fastify handle fastify errors
   */
  it.for(
    Object.entries(errorCodes).map(([key, value]) => {
      return { name: key, error: value };
    }),
  )('avoids handling fastify error: $name', async ({ error, name }) => {
    // Arrange
    fastify.get('/test', () => {
      throw new error('Fastify threw some error');
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.json()).toMatchObject({
      // fastify error handler returns error name in code field
      code: name,
    });
  });

  /**
   * Check that error handler treats all other Errors as a 500 Server Error and returns appropriate response
   */
  it('handles non-HttpError as a 500 Server Error', async () => {
    // Arrange
    fastify.get('/test', () => {
      throw new Error('Something went wrong');
    });

    // Act
    const response = await fastify.inject({ method: 'GET', url: '/test' });

    // Assert
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.payload)).toStrictEqual({
      message: 'Sever encountered an unexpected error. Please try again later.',
    });
  });
});
