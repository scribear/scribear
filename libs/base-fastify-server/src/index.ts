import type { BuildInfo, BuildOrigin } from './server/build-info.js';
import { UNKNOWN_BUILD_FIELD, readBuildInfo } from './server/build-info.js';
import createBaseServer from './server/create-base-server.js';
import type { BaseLogger } from './server/create-logger.js';
import { LogLevel } from './server/create-logger.js';
import {
  BaseHttpError,
  type ErrorReply,
  HttpError,
  type HttpErrorStatus,
} from './server/errors/http-errors.js';
import { BUILD_INFO_PATH } from './server/plugins/build-info-route.js';
import type { BaseDependencies } from './server/types/base-dependencies.js';
import type {
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
} from './server/types/base-fastify-types.js';

export {
  createBaseServer,
  LogLevel,
  BaseHttpError,
  HttpError,
  readBuildInfo,
  BUILD_INFO_PATH,
  UNKNOWN_BUILD_FIELD,
};
export type {
  BuildInfo,
  BuildOrigin,
  BaseLogger,
  BaseDependencies,
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
  ErrorReply,
  HttpErrorStatus,
};
