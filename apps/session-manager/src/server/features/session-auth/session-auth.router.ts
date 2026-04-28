import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  EXCHANGE_DEVICE_TOKEN_ROUTE,
  EXCHANGE_DEVICE_TOKEN_SCHEMA,
  EXCHANGE_JOIN_CODE_ROUTE,
  EXCHANGE_JOIN_CODE_SCHEMA,
  FETCH_JOIN_CODE_ROUTE,
  FETCH_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_ROUTE,
  REFRESH_SESSION_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';

export function sessionAuthRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...FETCH_JOIN_CODE_ROUTE,
    schema: FETCH_JOIN_CODE_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('sessionAuthController', 'fetchJoinCode'),
  });

  fastify.route({
    ...EXCHANGE_DEVICE_TOKEN_ROUTE,
    schema: EXCHANGE_DEVICE_TOKEN_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('sessionAuthController', 'exchangeDeviceToken'),
  });

  // The next two routes are intentionally unauthenticated: the join code and
  // the refresh token themselves serve as the credential.
  fastify.route({
    ...EXCHANGE_JOIN_CODE_ROUTE,
    schema: EXCHANGE_JOIN_CODE_SCHEMA,
    handler: resolveHandler('sessionAuthController', 'exchangeJoinCode'),
  });

  fastify.route({
    ...REFRESH_SESSION_TOKEN_ROUTE,
    schema: REFRESH_SESSION_TOKEN_SCHEMA,
    handler: resolveHandler('sessionAuthController', 'refreshSessionToken'),
  });
}
