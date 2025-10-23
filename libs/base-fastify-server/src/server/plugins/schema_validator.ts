import {
  type TSchema,
  type TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from '@fastify/type-provider-typebox';
import fastifyPlugin from 'fastify-plugin';
import type { FastifyRouteSchemaDef } from 'fastify/types/schema.js';

import { HttpError } from '../errors/http_errors.js';
import type { BaseFastifyInstance } from '../types/base_fastify_types.js';

/**
 * Custom fastify schema validator to throw custom 400 error
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.withTypeProvider<TypeBoxTypeProvider>();

  fastify.setValidatorCompiler((schemaDef) => {
    const validator = TypeBoxValidatorCompiler(
      schemaDef as FastifyRouteSchemaDef<TSchema>,
    );

    return (...args) => {
      const result = validator(...args) as {
        value: unknown;
        error?: { message: string; instancePath: string }[];
      };

      if (!result.error) {
        return { value: result.value };
      }

      const requestErrors = result.error.map(({ message, instancePath }) => {
        return {
          message,
          key: `/${schemaDef.httpPart ?? ''}${instancePath}`,
        };
      });
      return {
        error: new HttpError.BadRequest(requestErrors),
      };
    };
  });
});
