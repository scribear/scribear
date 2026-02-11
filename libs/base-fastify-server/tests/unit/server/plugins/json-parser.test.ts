import Fastify, { type FastifyInstance } from 'fastify';
import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '#src/server/errors/http-errors.js';
import jsonParser from '#src/server/plugins/json-parser.js';

describe('JSON Parser Plugin', (it) => {
  let fastify: FastifyInstance;
  let mockErrorHandler: Mock;

  beforeEach(() => {
    mockErrorHandler = vi.fn().mockReturnValue('');

    fastify = Fastify();

    fastify.setErrorHandler(mockErrorHandler);
    fastify.register(jsonParser);

    fastify.post('/test', async (req, reply) => {
      return reply.send(req.body);
    });
  });

  /**
   * Test that jsonParser is able to parse valid json
   */
  it('parses a valid JSON body successfully', async () => {
    // Arrange
    const validPayload = { hello: 'world', count: 123 };

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
   * Test that jsonParser throws BadRequest error if malformed JSON is received
   */
  it('throws BadRequest error for a malformed JSON body', async () => {
    // Arrange
    const invalidPayload = '{"key": "value",}';

    // Act
    await fastify.inject({
      method: 'POST',
      url: '/test',
      headers: {
        'content-type': 'application/json',
      },
      payload: invalidPayload,
    });

    // Assert
    expect(mockErrorHandler).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.BadRequest),
      expect.anything(),
      expect.anything(),
    );
  });
});
