import createBaseServer from './server/create-base-server.js';
import type { BaseLogger } from './server/create-logger.js';
import { LogLevel } from './server/create-logger.js';
import { BaseHttpError, HttpError } from './server/errors/http-errors.js';
import type { BaseDependencies } from './server/types/base-dependencies.js';
import type {
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
} from './server/types/base-fastify-types.js';

export { createBaseServer, LogLevel, BaseHttpError, HttpError };
export type {
  BaseLogger,
  BaseDependencies,
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
};
