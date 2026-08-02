import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  ADMIN_FETCH_JOIN_CODE_ROUTE,
  ADMIN_FETCH_JOIN_CODE_SCHEMA,
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
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';
import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';

export function sessionAuthRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...FETCH_JOIN_CODE_ROUTE,
    schema: FETCH_JOIN_CODE_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('sessionAuthController', 'fetchJoinCode'),
  });

  fastify.route({
    ...ADMIN_FETCH_JOIN_CODE_ROUTE,
    schema: ADMIN_FETCH_JOIN_CODE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('sessionAuthController', 'adminFetchJoinCode'),
  });

  fastify.route({
    ...EXCHANGE_DEVICE_TOKEN_ROUTE,
    schema: EXCHANGE_DEVICE_TOKEN_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('sessionAuthController', 'exchangeDeviceToken'),
  });

  // The next two routes are intentionally unauthenticated: the join code and
  // the refresh token themselves serve as the credential. They are the
  // credential-guessing surface, so they are rate-limited per client IP.
  //
  // These are the *only* rate-limited routes in this service - the plugin is
  // registered with `global: false` (see create-server.ts) - which is why 429
  // is declared on exactly these two response schemas and not in
  // STANDARD_ERROR_REPLIES. If you add `config.rateLimit` to another route,
  // add `429: RATE_LIMITED_REPLY_SCHEMA` to its schema in the same commit, or
  // its callers will see the limit as an unexplained `UnexpectedResponseError`
  // again.
  fastify.route({
    ...EXCHANGE_JOIN_CODE_ROUTE,
    schema: EXCHANGE_JOIN_CODE_SCHEMA,
    config: { rateLimit: { max: 100, timeWindow: 60_000 } },
    handler: resolveHandler('sessionAuthController', 'exchangeJoinCode'),
  });

  fastify.route({
    ...REFRESH_SESSION_TOKEN_ROUTE,
    schema: REFRESH_SESSION_TOKEN_SCHEMA,
    config: { rateLimit: { max: 100, timeWindow: 60_000 } },
    handler: resolveHandler('sessionAuthController', 'refreshSessionToken'),
  });
}
