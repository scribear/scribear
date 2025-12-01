import Swagger from '@fastify/swagger';
import SwaggerUI from '@fastify/swagger-ui';
import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

/**
 * Registers Swagger and Swagger UI to generate API documentation
 */
export default fastifyPlugin(async (fastify: BaseFastifyInstance) => {
  await fastify.register(Swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Session Manager API',
        description: 'The Swagger API documentation for Session Manager API.',
        version: '0.0.0',
      },
      tags: [
        {
          name: 'Healthcheck',
          description: 'Server health probe endpoint',
        },
      ],
    },
  });

  await fastify.register(SwaggerUI, {
    routePrefix: '/api-docs',
  });

  fastify.log.info('Swagger documentation is available at /api-docs');
});
