import { Type } from 'typebox';
import { beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '../../src/index.js';
import createBaseServer from '../../src/server/create_base_server.js';
import type {
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
} from '../../src/server/types/base_fastify_types.js';

describe('Integration Tests - Request validation', (it) => {
  let fastify: BaseFastifyInstance;

  beforeEach(() => {
    const server = createBaseServer(LogLevel.SILENT);

    fastify = server.fastify;

    const schema = {
      params: Type.Object({
        id: Type.String({ minLength: 2 }),
      }),
      querystring: Type.Object({
        string: Type.String(),
      }),
      body: Type.Object({
        num: Type.Number({ minimum: 18 }),
      }),
    };

    fastify.post(
      '/schema/:id',
      { schema },
      (
        req: BaseFastifyRequest<typeof schema>,
        reply: BaseFastifyReply<typeof schema>,
      ) => {
        return reply.code(200).send();
      },
    );
  });

  /**
   * Test that valid requests are passed to request handler successfully
   */
  it('returns 200 response for valid schema', async () => {
    // Arrange
    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/schema/some_id?string=string',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ num: 18 }),
    });

    // Assert
    expect(response.statusCode).toBe(200);
  });

  /**
   * Test that invalid requests return 400 error
   */
  it('returns 400 response for invalid schema', async () => {
    // Arrange
    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/schema/some_id',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ num: 18 }),
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/querystring',
          message: 'must have required properties string',
        },
      ],
    });
  });
});
