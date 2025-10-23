import Fastify, { type FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '../../../../src/server/errors/http_errors.js';
import schemaValidator from '../../../../src/server/plugins/schema_validator.js';

describe('Schema Validator Plugin', (it) => {
  let fastify: FastifyInstance;
  let mockErrorHandler: Mock;

  beforeEach(() => {
    mockErrorHandler = vi.fn().mockReturnValue('');

    fastify = Fastify();

    fastify.setErrorHandler(mockErrorHandler);
    fastify.register(schemaValidator);
  });

  /**
   * Test that schemaValidator is able to parse valid requests
   */
  it('successfully parses valid request', async () => {
    // Arrange
    const validPayload = { string: 'string', num: 123 };
    fastify.post(
      '/test',
      {
        schema: {
          body: Type.Object({ string: Type.String(), num: Type.Number() }),
        },
      },
      (req, reply) => {
        return reply.send(req.body);
      },
    );

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/test',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(validPayload),
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual(validPayload);
  });

  /**
   * Test that schemaValidator throws BadRequest error when parsing invalid requests
   */
  it('throws BadRequest error for invalid request', async () => {
    // Arrange
    const invalidPayload = { string: 'string', num: 'not a num' };
    fastify.post(
      '/test',
      {
        schema: {
          body: Type.Object({ string: Type.String(), num: Type.Number() }),
        },
      },
      (req, reply) => {
        return reply.send(req.body);
      },
    );

    // Act
    await fastify.inject({
      method: 'POST',
      url: '/test',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify(invalidPayload),
    });

    // Assert
    expect(mockErrorHandler).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.BadRequest),
      expect.anything(),
      expect.anything(),
    );
  });
});
