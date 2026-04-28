import {
  type TSchema,
  type TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from '@fastify/type-provider-typebox';
import fastifyPlugin from 'fastify-plugin';
import type { FastifyRouteSchemaDef } from 'fastify/types/schema.js';

import { BaseHttpError } from '../errors/http-errors.js';
import type { BaseFastifyInstance } from '../types/base-fastify-types.js';

/**
 * Schema validator that converts TypeBox validation failures into a
 * `BaseHttpError` with status 400 and code `VALIDATION_ERROR`. The error
 * handler then serializes it as the canonical `ErrorReply` body, with
 * per-field issues under `details.validationErrors`.
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

      const validationErrors = result.error.map(
        ({ message, instancePath }) => ({
          message,
          path: `/${schemaDef.httpPart ?? ''}${instancePath}`,
        }),
      );

      return {
        error: new BaseHttpError(
          400,
          'VALIDATION_ERROR',
          'Request validation failed.',
          { validationErrors },
        ),
      };
    };
  });
});
