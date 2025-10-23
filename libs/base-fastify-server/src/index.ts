import createBaseServer from './server/create_base_server.js';
import type { BaseLogger } from './server/create_logger.js';
import { LogLevel } from './server/create_logger.js';
import { BaseHttpError, HttpError } from './server/errors/http_errors.js';
import type { BaseDependencies } from './server/types/base_dependencies.js';
import type {
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
} from './server/types/base_fastify_types.js';

export { createBaseServer, LogLevel, BaseHttpError, HttpError };
export type {
  BaseLogger,
  BaseDependencies,
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
};
