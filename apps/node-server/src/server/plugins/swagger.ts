import Swagger from '@fastify/swagger';
import SwaggerUI from '@fastify/swagger-ui';
import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  OPENAPI_INFO,
  OPENAPI_SECURITY_SCHEMES,
  OPENAPI_TAGS,
  OPENAPI_VERSION,
} from '@scribear/node-server-schema';

/**
 * Registers Swagger and Swagger UI to generate API documentation
 */
export default fastifyPlugin(async (fastify: BaseFastifyInstance) => {
  await fastify.register(Swagger, {
    openapi: {
      openapi: OPENAPI_VERSION,
      info: OPENAPI_INFO,
      tags: OPENAPI_TAGS,
      components: {
        securitySchemes: OPENAPI_SECURITY_SCHEMES,
      },
    },
  });

  await fastify.register(SwaggerUI, {
    routePrefix: '/api-docs',
  });

  fastify.log.info('Swagger documentation is available at /api-docs');
});
